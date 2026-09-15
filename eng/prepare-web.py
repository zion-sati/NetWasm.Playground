#!/usr/bin/env python3
"""Stage receipt-verified browser assets at an immutable, content-addressed path."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def fingerprint(path):
    return {'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def verify_receipt(folder):
    receipt = json.loads((folder / 'receipt.json').read_text())
    for relative, expected in receipt['files'].items():
        if fingerprint(folder / relative) != expected:
            raise ValueError(f'Receipt mismatch: {folder.name}/{relative}')


def verify_staged(folder):
    manifest = json.loads((folder / 'asset-manifest.json').read_text())
    assets = manifest['assets']
    for relative, expected in assets.items():
        if fingerprint(folder / relative) != {key: expected[key] for key in ['bytes', 'sha256']}:
            raise ValueError(f'Staged asset mismatch: {relative}')
        if 'gzip' in expected:
            compressed = expected['gzip']
            if fingerprint(folder / compressed['path']) != {key: compressed[key] for key in ['bytes', 'sha256']}:
                raise ValueError(f'Staged gzip mismatch: {relative}')
            if gzip.decompress((folder / compressed['path']).read_bytes()) != (folder / relative).read_bytes():
                raise ValueError(f'Staged gzip content mismatch: {relative}')
    identity = {'schemaVersion': 1, 'pins': manifest['pins'], 'assets': assets}
    if hashlib.sha256(encoded(identity)).hexdigest() != manifest['id'] or folder.name != manifest['id']:
        raise ValueError('Staged content identity mismatch')
    print(f'PASS: {len(assets)} immutable toolchain assets verified')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', type=Path, default=ROOT / '.cache/desktop-baseline-verified-20260915-d')
    parser.add_argument('--compiler', type=Path, default=ROOT / '.cache/trusted-compiler-host-20260916')
    parser.add_argument('--tools', type=Path, default=ROOT / '.cache/browser-tools-probe-20260915')
    parser.add_argument('--lld', type=Path, default=ROOT / '.cache/browser-lld-20260915')
    parser.add_argument('--component', type=Path, default=ROOT / '.cache/browser-component-20260916/final')
    parser.add_argument('--source', type=Path, default=ROOT / '.cache/public-netwasm')
    parser.add_argument('--workers', type=Path, default=ROOT / 'src/workers')
    parser.add_argument('--examples', type=Path, default=ROOT / '.cache/desktop-examples-20260916', help='Receipt-verified public desktop example inputs')
    parser.add_argument('--generated-json', type=Path, default=ROOT / '.cache/desktop-json-generated-20260916', help='Receipt-verified source-generated JSON example inputs')
    parser.add_argument('--tunit', type=Path, default=ROOT / '.cache/tunit-example-20260916/final', help='Receipt-verified public TUnit template inputs')
    parser.add_argument('--output', type=Path, default=ROOT / 'public/toolchain')
    parser.add_argument('--verify', type=Path, help='Verify an already staged version without rebuilding')
    args = parser.parse_args()
    if args.verify:
        verify_staged(args.verify.resolve())
        return
    subprocess.run(['python3', str(ROOT / 'eng/desktop-baseline.py'), str(args.baseline), '--verify'], check=True)
    for folder in [args.compiler, args.tools, args.component]:
        verify_receipt(folder)
    example_folders = [folder for folder in [args.examples, args.generated_json] if folder]
    for folder in example_folders:
        verify_receipt(folder)
    if args.tunit:
        verify_receipt(args.tunit)
    build = json.loads((args.lld / 'build-receipt.json').read_text())
    baseline_pins = json.loads((args.baseline / 'receipt.json').read_text())['toolchain']
    for key, baseline_key in [('llvm', 'llvmLld'), ('emscripten', 'emscripten'), ('node', 'node')]:
        if build[key] != baseline_pins[baseline_key]:
            raise ValueError(f'LLD toolchain pin mismatch: {key}')
    for name, expected in build['assets'].items():
        if fingerprint(args.lld / 'assets' / name) != expected:
            raise ValueError(f'LLD asset mismatch: {name}')
    pins = json.loads((ROOT / 'eng/upstream-sources.json').read_text())['sources']
    worker_paths = sorted(args.workers.glob('*.mjs'))
    required = {'compiler-worker.mjs', 'tools-worker.mjs', 'lld-worker.mjs', 'guest-worker.mjs'}
    if not required.issubset({path.name for path in worker_paths}):
        raise ValueError('All four real worker templates must exist before staging')
    args.output.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(args.output).free < 100 * 1024 ** 3:
        raise RuntimeError('At least 100 GiB free space required')
    with tempfile.TemporaryDirectory(prefix='.staging-', dir=args.output) as temporary:
        stage = Path(temporary)
        def copy(source, relative):
            destination = stage / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
        for path in sorted((args.compiler / 'publish/wwwroot').rglob('*')):
            relative = path.relative_to(args.compiler / 'publish/wwwroot')
            if path.is_file() and relative.parts[0] != 'trusted' and path.name not in {'index.html', 'compiler-worker.mjs', 'trusted-worker.mjs', 'trusted-recipes.json'}:
                copy(path, Path('compiler') / relative)
        copy(args.compiler / 'inputs.json', 'compiler/inputs.json')
        for path in sorted((args.tools / 'site').rglob('*')):
            if path.is_file() and path.name not in {'index.html', 'worker.js', 'assets.json'}:
                copy(path, path.relative_to(args.tools / 'site'))
        for path in sorted((args.lld / 'assets').rglob('*')):
            if path.is_file():
                copy(path, Path('lld') / path.relative_to(args.lld / 'assets'))
        for path in sorted((args.component / 'site/runtime').rglob('*')):
            if path.is_file():
                copy(path, Path('runtime') / path.relative_to(args.component / 'site/runtime'))
        copy(args.component / 'site/command.wit.wasm', 'command.wit.wasm')
        for folder in example_folders:
            example_pins = json.loads((folder / 'receipt.json').read_text())['pins']['sources']
            if example_pins['libraries'] != pins['libraries'] or example_pins['netwasm']['commit'] != pins['netwasm']['commit']:
                raise ValueError('Example package/source pins do not match the toolchain')
            for path in sorted(folder.glob('*/recipe-inputs.json')):
                recipe = json.loads(path.read_text())
                references, implementations = {}, {}
                for name, relative in recipe['libraries'].items():
                    for role, destination in [('references', references), ('implementations', implementations)]:
                        asset = f'{role}/{name}'
                        if (stage / asset).exists() and fingerprint(stage / asset) != fingerprint(folder / relative):
                            raise ValueError(f'Conflicting recipe assembly: {name}')
                        copy(folder / relative, asset)
                        destination[name] = asset
                (stage / 'recipes').mkdir(exist_ok=True)
                (stage / 'recipes' / f"{recipe['id']}.json").write_bytes(encoded({
                    'schemaVersion': 1, 'id': recipe['id'], 'references': references, 'implementations': implementations,
                    'packages': recipe['packages'], 'version': recipe['version']}))
        commit = pins['netwasm']['browserToolHostCommit']
        if args.tunit:
            tunit_pins = json.loads((args.tunit / 'receipt.json').read_text())['pins']['sources']
            if tunit_pins != pins:
                raise ValueError('TUnit package/source pins do not match the toolchain')
            recipe = json.loads((args.tunit / 'recipe-inputs.json').read_text())
            references, implementations = {}, {}
            for library in recipe['libraries'].values():
                for role, key, destination in [('references', 'compile', references), ('implementations', 'runtime', implementations)]:
                    for relative in library.get(key, []):
                        name = Path(relative).name
                        if name == 'NetWasm.CoreLib.dll':
                            continue
                        asset = f'{role}/{name}'
                        if (stage / asset).exists() and fingerprint(stage / asset) != fingerprint(args.tunit / relative):
                            raise ValueError(f'Conflicting TUnit assembly: {name}')
                        copy(args.tunit / relative, asset)
                        destination[name] = asset
            (stage / 'recipes').mkdir(exist_ok=True)
            support = [{'path': 'obj/Release/netwasm0.1/' + path.name, 'text': path.read_text()} for path in sorted((args.tunit / 'cases/template/obj').glob('*.cs'))]
            (stage / 'recipes/tunit-support.json').write_bytes(encoded(support))
            (stage / 'recipes/tunit.json').write_bytes(encoded({'schemaVersion': 1, 'id': 'tunit', 'references': references,
                'implementations': implementations, 'support': 'recipes/tunit-support.json', 'version': pins['tunit']['packageVersion']}))
            copy(args.tunit / recipe['componentWitBinary'], 'async-command.wit.wasm')
            # Exact browser-safe closure used by the async guest proof.
            for name in ['canonical-component-binder.mjs', 'command-executor.mjs', 'component-execution-preparation.mjs',
                         'component-executor.mjs', 'execution-contracts.mjs', 'execution-result.mjs', 'execution-scope-closer.mjs',
                         'guest-wake-notifier.mjs', 'managed-process-observer.mjs', 'pollable-reactor.mjs']:
                content = subprocess.check_output(['git', '-C', str(args.source), 'show', f'{commit}:src/NetWasm.Hosting/JavaScript/{name}'])
                (stage / 'hosting').mkdir(exist_ok=True)
                (stage / 'hosting' / name).write_bytes(content)
        for name in ['binaryen-host.mjs', 'tool-inputs.mjs', 'wasm-tools-host.mjs']:
            content = subprocess.check_output(['git', '-C', str(args.source), 'show', f'{commit}:src/NetWasm.Toolchain/Browser/Tools/{name}'])
            (stage / 'hosts').mkdir(exist_ok=True)
            (stage / 'hosts' / name).write_bytes(content)
        for path in worker_paths:
            copy(path, Path('workers') / path.name)
        assets = {}
        for path in sorted(stage.rglob('*')):
            if not path.is_file():
                continue
            relative = path.relative_to(stage).as_posix()
            entry = fingerprint(path)
            if path.suffix in {'.wasm', '.dll', '.a', '.dat'} or path.name in {'wasm-merge.js', 'wasm-opt.js'}:
                compressed = path.with_name(path.name + '.gz.bin')
                compressed.write_bytes(gzip.compress(path.read_bytes(), compresslevel=9, mtime=0))
                entry['gzip'] = {'path': relative + '.gz.bin', **fingerprint(compressed)}
            assets[relative] = entry
        identity = {'schemaVersion': 1, 'pins': pins, 'assets': assets}
        digest = hashlib.sha256(encoded(identity)).hexdigest()
        manifest = {**identity, 'id': digest, 'rawBytes': sum(a['bytes'] for a in assets.values()),
                    'gzipBytes': sum(a.get('gzip', a)['bytes'] for a in assets.values())}
        (stage / 'asset-manifest.json').write_bytes(encoded(manifest))
        destination = args.output / digest
        if destination.exists():
            verify_staged(destination)
        else:
            stage.rename(destination)
        index = {'id': digest, 'manifestSha256': fingerprint(destination / 'asset-manifest.json')['sha256']}
        temporary_index = args.output / '.index.json.tmp'
        temporary_index.write_bytes(encoded(index))
        temporary_index.replace(args.output / 'index.json')
    verify_staged(destination)
    print(json.dumps({**index, 'rawBytes': manifest['rawBytes'], 'gzipBytes': manifest['gzipBytes']}))


if __name__ == '__main__':
    main()
