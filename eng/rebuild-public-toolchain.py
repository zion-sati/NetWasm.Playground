#!/usr/bin/env python3
"""Rebuild the release toolchain from a pinned public base and clean compiler host."""
import argparse
import base64
import hashlib
import io
import importlib.util
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('prepare_web', ROOT / 'eng/prepare-web.py')
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)
NOTICE_SPEC = importlib.util.spec_from_file_location('browser_notices', ROOT / 'eng/browser-notices.py')
NOTICES = importlib.util.module_from_spec(NOTICE_SPEC)
NOTICE_SPEC.loader.exec_module(NOTICES)
RELEASE_SPEC = importlib.util.spec_from_file_location('toolchain_release', ROOT / 'eng/toolchain-release.py')
RELEASE = importlib.util.module_from_spec(RELEASE_SPEC)
RELEASE_SPEC.loader.exec_module(RELEASE)


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def sha256(payload):
    return hashlib.sha256(payload).hexdigest()


def safe_path(value):
    path = PurePosixPath(value)
    if path.is_absolute() or not path.parts or any(part in {'', '.', '..'} for part in path.parts):
        raise ValueError(f'Unsafe public toolchain path: {value}')
    return path


def download(url, maximum):
    request = urllib.request.Request(url, headers={'User-Agent': 'NetWasm.Playground-release-builder'})
    with urllib.request.urlopen(request) as response:
        payload = response.read(maximum + 1)
    if len(payload) > maximum:
        raise ValueError(f'Public toolchain response exceeded its receipt: {url}')
    return payload


def package_members(package, version, members):
    url = f'https://api.nuget.org/v3-flatcontainer/{package}/{version}/{package}.{version}.nupkg'
    payload = download(url, 32 * 1024 * 1024)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        extracted = {name: archive.read(name) for name in members}
    for name, expected in members.items():
        if sha256(extracted[name]) != expected:
            raise ValueError(f'Public package member changed: {package}/{name}')
    return extracted


def rebind_notice_origins(stage, pins):
    origins_path = stage / 'notices/origins.json'
    origins = json.loads(origins_path.read_text())
    versions = {
        'netwasm.toolchain': pins['netwasm']['packageVersion'],
        'netwasm.tunit': pins['tunit']['packageVersion'],
        'netwasm.tunit.assertions': pins['tunit']['packageVersion'],
        'netwasm.tunit.core': pins['tunit']['packageVersion'],
    }
    packages = {}
    for package, version in versions.items():
        archive_name = f'{package}.{version}.nupkg'
        url = f'https://api.nuget.org/v3-flatcontainer/{package}/{version}/{archive_name}'
        registration = json.loads(download(
            f'https://api.nuget.org/v3/registration5-semver1/{package}/{version}.json', 1024 * 1024))
        catalog_url = registration.get('catalogEntry')
        if not isinstance(catalog_url, str) or not catalog_url.startswith('https://api.nuget.org/'):
            raise ValueError(f'Invalid NuGet catalog entry: {package}/{version}')
        catalog = json.loads(download(catalog_url, 4 * 1024 * 1024))
        package_size = catalog.get('packageSize')
        if (catalog.get('packageHashAlgorithm') != 'SHA512' or not isinstance(catalog.get('packageHash'), str) or
                not isinstance(package_size, int) or package_size < 1 or package_size > 256 * 1024 * 1024):
            raise ValueError(f'Invalid NuGet package hash: {package}/{version}')
        archive = download(url, package_size)
        if len(archive) != package_size:
            raise ValueError(f'NuGet package size changed: {package}/{version}')
        if base64.b64encode(hashlib.sha512(archive).digest()).decode() != catalog['packageHash']:
            raise ValueError(f'NuGet package hash changed: {package}/{version}')
        packages[package] = (version, url, archive, catalog['packageHash'])
    for target, entry in origins['files'].items():
        source = entry['source']
        package = source.get('package')
        if package not in packages:
            continue
        version, url, archive, restore_hash = packages[package]
        with zipfile.ZipFile(io.BytesIO(archive)) as package_zip:
            notice = package_zip.read(source['path'])
        if notice != (stage / 'notices' / target).read_bytes():
            raise ValueError(f'Notice changed in public package: {package}/{source["path"]}')
        source.update(version=version, url=url, archiveSha256=sha256(archive),
                      archiveSha512=base64.b64encode(hashlib.sha512(archive).digest()).decode(),
                      restoreContentHash=restore_hash)
    origins_path.write_bytes(encoded(origins))
    NOTICES.verify(stage / 'notices')
    return packages


def add_guest_providers(stage, toolchain_archive):
    prefix = 'tools/jco/node_modules/@bytecodealliance/preview2-shim/dist/browser/'
    browser = stage / 'jco/preview2'
    browser.mkdir(parents=True)
    with zipfile.ZipFile(io.BytesIO(toolchain_archive)) as package:
        names = [name for name in package.namelist() if name.startswith(prefix) and
                 name.endswith('.js') and '/' not in name[len(prefix):]]
        required = {'cli.js', 'clocks.js', 'filesystem.js', 'http.js', 'io.js', 'random.js'}
        if not required.issubset({name[len(prefix):] for name in names}):
            raise ValueError('Public package lacks browser WASI providers')
        for name in names:
            (browser / name[len(prefix):]).write_bytes(package.read(name))
    subprocess.run(['node', str(ROOT / 'eng/bundle-toolchain-modules.mjs'), str(stage),
                    '--providers-only'], check=True)
    shutil.rmtree(browser)


def add_http_example(stage, library_version):
    member = 'lib/NetWasm,Version=v0.1/System.Net.Http.dll'
    assembly = package_members('netwasm.system.net.http', library_version, {
        member: '7527ccf4d8a4c918b656c8c0d1af29a83159ee1bc02cb0b30e479a06127401e8',
    })[member]
    for role in ('references', 'implementations'):
        destination = stage / role / 'System.Net.Http.dll'
        destination.parent.mkdir(exist_ok=True)
        destination.write_bytes(assembly)
    recipe = {'schemaVersion': 1, 'id': 'http',
              'references': {'System.Net.Http.dll': 'references/System.Net.Http.dll'},
              'implementations': {'System.Net.Http.dll': 'implementations/System.Net.Http.dll'},
              'packages': ['NetWasm.System.Net.Http'], 'version': library_version}
    (stage / 'recipes/http.json').write_bytes(encoded(recipe))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--compiler-framework', type=Path, required=True)
    parser.add_argument('--workers', type=Path, default=ROOT / 'src/workers')
    parser.add_argument('--output', type=Path, default=ROOT / 'public/toolchain')
    args = parser.parse_args()
    base = json.loads((ROOT / 'eng/toolchain-base.json').read_text())
    archive = base.get('archive', {})
    if base.get('schemaVersion') != 2 or not isinstance(archive.get('bytes'), int) or archive['bytes'] < 1 or \
            not isinstance(archive.get('sha256'), str) or not archive.get('url', '').startswith('https://github.com/'):
        raise ValueError('Pinned public base coordinates are invalid')
    archive_bytes = download(archive['url'], archive['bytes'])
    if len(archive_bytes) != archive['bytes'] or sha256(archive_bytes) != archive['sha256']:
        raise ValueError('Pinned public base archive changed')
    if args.output.exists():
        shutil.rmtree(args.output)
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.release-build-', dir=args.output) as temporary:
        temporary = Path(temporary)
        extracted = temporary / 'extracted'
        extracted.mkdir()
        with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode='r:gz') as package:
            members = package.getmembers()
            for member in members:
                path = PurePosixPath(member.name)
                if not (member.isfile() or member.isdir()) or path.is_absolute() or '..' in path.parts or path.parts[:1] != ('toolchain',):
                    raise ValueError(f'Unsafe public base archive member: {member.name}')
            package.extractall(extracted, filter='data')
        base_toolchain = extracted / 'toolchain'
        RELEASE.verify_staged(base_toolchain)
        if json.loads((base_toolchain / 'index.json').read_text()) != base.get('index'):
            raise ValueError('Pinned public base index changed')
        manifest_root = base_toolchain / base['index']['id']
        manifest = json.loads((manifest_root / 'asset-manifest.json').read_text())
        stage = temporary / 'stage'
        stage.mkdir()
        entries = [(name, receipt) for name, receipt in manifest['assets'].items()
                   if not name.startswith('compiler/_framework/') and not name.startswith('workers/')]
        bundle_payloads = {name: (manifest_root / receipt.get('path', name)).read_bytes()
                           for name, receipt in manifest['bundles'].items()}
        for name, receipt in entries:
            path = safe_path(name)
            if not isinstance(receipt.get('bytes'), int) or receipt['bytes'] < 0 or not isinstance(receipt.get('sha256'), str):
                raise ValueError(f'Invalid public base receipt: {name}')
            if receipt.get('bundle'):
                payload = bundle_payloads[receipt['bundle']][receipt['offset']:receipt['offset'] + receipt['bytes']]
            else:
                payload = manifest_root.joinpath(*path.parts).read_bytes()
            if len(payload) != receipt['bytes'] or sha256(payload) != receipt['sha256']:
                raise ValueError(f'Pinned public base asset changed: {name}')
            destination = stage.joinpath(*path.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(payload)
        pins = json.loads((ROOT / 'eng/upstream-sources.json').read_text())['sources']
        version = pins['netwasm']['packageVersion']
        runtime_members = package_members('netwasm.runtime.pack', version, {
            'runtime/wasm32/libnetwasm-runtime.a':
                '0d03137a766f820950d3eb765c6d729ce937e745afb65f1be382ad11716c3adb',
            'runtime/runtime-pack.json':
                'fc9a2b7d19bea3e072758ecf986a70c03edec57116bafced11d1f2168a18250f',
        })
        (stage / 'runtime/wasm32/libnetwasm-runtime.a').write_bytes(
            runtime_members['runtime/wasm32/libnetwasm-runtime.a'])
        (stage / 'compiler/runtime-pack.json').write_bytes(
            runtime_members['runtime/runtime-pack.json'])
        packages = rebind_notice_origins(stage, pins)
        add_guest_providers(stage, packages['netwasm.toolchain'][2])
        add_http_example(stage, pins['libraries']['packageVersion'])
        framework = stage / 'compiler/_framework'
        shutil.copytree(args.compiler_framework, framework)
        workers = sorted(args.workers.glob('*.mjs'))
        required = {'compiler-worker.mjs', 'tools-worker.mjs', 'lld-worker.mjs', 'guest-worker.mjs'}
        if not required.issubset({path.name for path in workers}):
            raise ValueError('Release worker set is incomplete')
        (stage / 'workers').mkdir()
        for path in workers:
            shutil.copyfile(path, stage / 'workers' / path.name)
        assets, bundles = PREPARE.pack_staged_assets(stage)
        identity = {'schemaVersion': 3, 'pins': pins, 'assets': assets, 'bundles': bundles}
        digest = sha256(encoded(identity))
        document = {**identity, 'id': digest, 'rawBytes': sum(asset['bytes'] for asset in assets.values()),
                    'bundleBytes': sum(bundle['bytes'] for bundle in bundles.values())}
        (stage / 'asset-manifest.json').write_bytes(encoded(document))
        destination = args.output / digest
        if destination.exists():
            shutil.rmtree(destination)
        stage.rename(destination)
        index = {'id': digest, 'manifestSha256': sha256((destination / 'asset-manifest.json').read_bytes())}
        (args.output / 'index.json').write_bytes(encoded(index))
    PREPARE.verify_staged(destination)
    print(json.dumps({**index, 'rawBytes': document['rawBytes'], 'bundleBytes': document['bundleBytes']}))


if __name__ == '__main__':
    main()
