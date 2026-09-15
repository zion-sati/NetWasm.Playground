#!/usr/bin/env python3
"""Stage pinned public tool assets; no server executes compiler/tool operations."""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('baseline', type=Path)
parser.add_argument('run', type=Path)
args = parser.parse_args()
run = args.run.resolve()
run.mkdir(parents=True, exist_ok=True)
site = run / 'site'
site.mkdir(exist_ok=True)
baseline = args.baseline.resolve()
subprocess.run([sys.executable, str(Path(__file__).resolve().parents[2] / 'eng/desktop-baseline.py'), str(baseline), '--verify'], check=True)
package_root = baseline / 'packages/netwasm.toolchain/0.1.0'
tools = package_root / 'tools'
package_manifest = json.loads((tools / 'toolchain-manifest.json').read_text())
pins = {entry['relativePath'].removeprefix('tools/'): entry['sha256'] for entry in package_manifest['assets']}
closure = json.loads((tools / 'jco/closure-integrity.json').read_text())
pins.update({'jco/' + entry['path']: entry['sha256'] for entry in closure['files']})
assets = {}
provenance = []

def stage(source, relative, replacements=()):
    original = source.read_bytes()
    digest = hashlib.sha256(original).hexdigest()
    if source.is_relative_to(tools):
        key = source.relative_to(tools).as_posix()
        if key not in pins:
            raise ValueError(f'Published tool manifest has no asset pin: {key}')
        if digest != pins[key]:
            raise ValueError(f'Published tool manifest mismatch: {key}')
    data = original
    for before, after in replacements:
        if before not in data:
            raise ValueError(f'Module mapping missing: {relative}')
        data = data.replace(before, after)
    target = site / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)
    assets[relative] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
    provenance.append({'asset': relative, 'originalSha256': digest, 'rewrittenModuleSpecifiers': bool(replacements)})

(run / 'package.json').write_text(json.dumps({'private': True, 'dependencies': {'@bjorn3/browser_wasi_shim': '0.4.2', 'path-browserify': '1.0.1'}}, indent=2) + '\n')
subprocess.run(['npm', 'install', '--prefix', str(run), '--ignore-scripts', '--no-audit', '--no-fund'], check=True)
for name, source in [('wasm-tools.wasm', tools / 'wasm-tools/wasm-tools.wasm'), ('wasm-merge.js', tools / 'binaryen/bin/wasm-merge'), ('wasm-opt.js', tools / 'binaryen/bin/wasm-opt')]:
    stage(source, name)
for source in (run / 'node_modules/@bjorn3/browser_wasi_shim/dist').glob('*.js'):
    stage(source, 'wasi-shim/' + source.name)
stage(run / 'node_modules/path-browserify/index.js', 'path-browserify.js')
modules = tools / 'jco/node_modules/@bytecodealliance'
stage(modules / 'jco/dist/browser.js', 'jco/browser.js', [(b'@bytecodealliance/jco-transpile/component', b'./js-component-bindgen-component.js')])
stage(modules / 'jco-transpile/vendor/js-component-bindgen-component.js', 'jco/js-component-bindgen-component.js', [(f'@bytecodealliance/preview2-shim/{name}'.encode(), f'./preview2/{name}.js'.encode()) for name in ['cli', 'filesystem', 'io', 'random']])
for source in (modules / 'jco-transpile/vendor').glob('js-component-bindgen-component.core*.wasm'):
    stage(source, 'jco/' + source.name)
for source in (modules / 'preview2-shim/dist/browser').glob('*.js'):
    stage(source, 'jco/preview2/' + source.name)
(site / 'assets.json').write_text(json.dumps(assets, indent=2) + '\n')
(site / 'index.html').write_text('<!doctype html><title>Trusted browser tool probe</title><p>Probe controlled through worker messages.</p>')
shutil.copyfile(Path(__file__).with_name('worker.js'), site / 'worker.js')
(run / 'inputs.json').write_text(json.dumps({'versions': {'NetWasm.Toolchain': '0.1.0', 'wasm-tools': '1.256.0', 'binaryen': '132.0.0', 'jco': '1.28.1', 'jco-transpile': '0.7.0', 'preview2-shim': '0.24.1', 'browser_wasi_shim': '0.4.2', 'path-browserify': '1.0.1'}, 'baselineReceiptSha256': hashlib.sha256((baseline / 'receipt.json').read_bytes()).hexdigest(), 'packageArchiveSha256': hashlib.sha256((package_root / 'netwasm.toolchain.0.1.0.nupkg').read_bytes()).hexdigest(), 'jcoClosureIntegritySha256': hashlib.sha256((tools / 'jco/closure-integrity.json').read_bytes()).hexdigest(), 'packageToolManifestSha256': hashlib.sha256((tools / 'toolchain-manifest.json').read_bytes()).hexdigest(), 'assets': provenance, 'servedRawAssetBytes': sum(entry['bytes'] for entry in assets.values())}, indent=2) + '\n')
print(f'Staged {len(assets)} assets, {sum(entry["bytes"] for entry in assets.values())} raw bytes')
