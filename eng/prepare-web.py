#!/usr/bin/env python3
"""Stage receipt-verified browser assets at an immutable, content-addressed path."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
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


def verify_nuget_package(baseline, receipt, package_id, version):
    package_root = baseline / 'packages' / package_id.lower() / version
    metadata_path = package_root / '.nupkg.metadata'
    metadata = json.loads(metadata_path.read_text())
    if metadata.get('source') != 'https://api.nuget.org/v3/index.json':
        raise ValueError(f'{package_id} did not originate from NuGet.org')
    archive = package_root / f'{package_id.lower()}.{version}.nupkg'
    relative = str(archive.relative_to(baseline))
    if receipt['packages'].get(relative) != fingerprint(archive):
        raise ValueError(f'{package_id} package archive is not bound by the baseline receipt')
    return package_root


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
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--compiler', type=Path)
    parser.add_argument('--tools', type=Path)
    parser.add_argument('--lld', type=Path)
    parser.add_argument('--component', type=Path)
    parser.add_argument('--workers', type=Path, default=ROOT / 'src/workers')
    parser.add_argument('--examples', type=Path, help='Receipt-verified public desktop example inputs')
    parser.add_argument('--generated-json', type=Path, help='Separate receipt-verified source-generated JSON inputs, when needed')
    parser.add_argument('--tunit', type=Path, help='Receipt-verified public TUnit template inputs')
    parser.add_argument('--notices', type=Path, help='Verified public notices and portable origins.json')
    parser.add_argument('--output', type=Path, default=ROOT / 'public/toolchain')
    parser.add_argument('--additional-examples', type=Path, action='append', help='Additional receipt-verified public example inputs')
    parser.add_argument('--verify', type=Path, help='Verify an already staged version without rebuilding')
    args = parser.parse_args()
    if args.verify:
        verify_staged(args.verify.resolve())
        return
    required = ['baseline', 'compiler', 'tools', 'lld', 'component', 'examples', 'tunit', 'notices']
    missing = [f'--{name}' for name in required if getattr(args, name) is None]
    if missing:
        parser.error('staging requires ' + ', '.join(missing))
    subprocess.run(['python3', str(ROOT / 'eng/browser-notices.py'), '--verify', str(args.notices)], check=True)
    subprocess.run(['python3', str(ROOT / 'eng/desktop-baseline.py'), str(args.baseline), '--verify'], check=True)
    baseline_receipt = json.loads((args.baseline / 'receipt.json').read_text())
    for folder in [args.compiler, args.tools, args.component]:
        verify_receipt(folder)
    additional_examples = args.additional_examples or []
    example_folders = [folder for folder in [args.examples, args.generated_json, *additional_examples] if folder]
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
    version = pins['netwasm']['packageVersion']
    hosting_package = verify_nuget_package(args.baseline, baseline_receipt, 'NetWasm.Hosting', version)
    toolchain_package = verify_nuget_package(args.baseline, baseline_receipt, 'NetWasm.Toolchain', version)
    compiler_inputs = json.loads((args.compiler / 'inputs.json').read_text())
    expected_compiler = {'id': 'NetWasm.Compiler.Browser', 'version': version,
                         'source': 'https://api.nuget.org/v3/index.json'}
    if compiler_inputs.get('browserCompilerPackage') != expected_compiler:
        raise ValueError('Compiler host is not bound to the pinned public browser compiler package')
    compiler_origins = json.loads((args.compiler / 'compiler-package-origins.json').read_text())
    if set(compiler_origins) != {'netwasm.compiler.browser', 'netwasm.runtime.pack'} or any(
            item.get('version') != version or item.get('source') != 'https://api.nuget.org/v3/index.json'
            for item in compiler_origins.values()):
        raise ValueError('Compiler host package origins are incomplete or do not match the public pin')
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
        if args.tunit:
            tunit_pins = json.loads((args.tunit / 'receipt.json').read_text())['pins']['sources']
            if (tunit_pins['tunit'] != pins['tunit'] or
                    any(tunit_pins['netwasm'][key] != pins['netwasm'][key]
                        for key in ['repository', 'commit', 'packageVersion'])):
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
                (stage / 'hosting').mkdir(exist_ok=True)
                copy(hosting_package / 'tools/netwasm/hosting' / name, Path('hosting') / name)
        for name in ['binaryen-host.mjs', 'tool-inputs.mjs', 'wasm-tools-host.mjs', 'wasm32-memory-ceiling.mjs']:
            (stage / 'hosts').mkdir(exist_ok=True)
            copy(toolchain_package / 'tools/netwasm/browser' / name, Path('hosts') / name)
        for path in sorted(args.notices.rglob('*')):
            if path.is_file():
                copy(path, Path('notices') / path.relative_to(args.notices))
        for path in worker_paths:
            copy(path, Path('workers') / path.name)
        assets = {}
        for path in sorted(stage.rglob('*')):
            if not path.is_file():
                continue
            relative = path.relative_to(stage).as_posix()
            entry = fingerprint(path)
            assets[relative] = entry
        identity = {'schemaVersion': 1, 'pins': pins, 'assets': assets}
        digest = hashlib.sha256(encoded(identity)).hexdigest()
        manifest = {**identity, 'id': digest, 'rawBytes': sum(a['bytes'] for a in assets.values())}
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
    print(json.dumps({**index, 'rawBytes': manifest['rawBytes']}))


if __name__ == '__main__':
    try:
        main()
    except ValueError as error:
        print(f'ERROR: {error}', file=sys.stderr)
        raise SystemExit(1) from None
