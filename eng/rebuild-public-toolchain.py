#!/usr/bin/env python3
"""Rebuild the release toolchain from a pinned public base and clean compiler host."""
import argparse
import base64
import hashlib
import io
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ARCHIVES = {}
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


def verified_archive(package, version):
    key = (package, version)
    if key in ARCHIVES:
        return ARCHIVES[key]
    url = f'https://api.nuget.org/v3-flatcontainer/{package}/{version}/{package}.{version}.nupkg'
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
    payload = download(url, package_size)
    if len(payload) != package_size or base64.b64encode(hashlib.sha512(payload).digest()).decode() != catalog['packageHash']:
        raise ValueError(f'NuGet package changed: {package}/{version}')
    ARCHIVES[key] = (url, payload, catalog['packageHash'])
    return ARCHIVES[key]


def package_members(package, version, members):
    _, payload, _ = verified_archive(package, version)
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
        url, archive, restore_hash = verified_archive(package, version)
        packages[package] = (version, url, archive, restore_hash)
    for target, entry in origins['files'].items():
        source = entry['source']
        source_family = next((family for family in ('netwasm', 'libraries')
                              if source.get('kind') == 'git' and
                              source.get('repository') == pins[family]['repository']), None)
        if source_family:
            commit = pins[source_family]['commit']
            repository = source['repository'].removeprefix('https://github.com/')
            notice = download(f"https://raw.githubusercontent.com/{repository}/{commit}/{source['path']}",
                              64 * 1024)
            (stage / 'notices' / target).write_bytes(notice)
            source['commit'] = commit
            entry.update(bytes=len(notice), sha256=sha256(notice))
            continue
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
        member: 'b4e4ee180a33509d6148a6ee0d76a3fa5ab556f8792471ce52584ac05a092433',
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


ASSEMBLY_PACKAGES = {
    'Microsoft.Extensions.DependencyInjection.Abstractions.dll': 'netwasm.microsoft.extensions.dependencyinjection.abstractions',
    'Microsoft.Extensions.DependencyInjection.dll': 'netwasm.microsoft.extensions.dependencyinjection',
    'NetWasm.TUnit.Runner.dll': 'netwasm.tunit',
    'System.IO.Hashing.dll': 'netwasm.system.io.hashing',
    'System.IO.Pipelines.dll': 'netwasm.system.io.pipelines',
    'System.Linq.dll': 'netwasm.system.linq',
    'System.Memory.dll': 'netwasm.system.memory',
    'System.Text.Encodings.Web.dll': 'netwasm.system.text.encodings.web',
    'System.Text.Json.dll': 'netwasm.system.text.json',
    'System.Text.RegularExpressions.dll': 'netwasm.system.text.regularexpressions',
    'TUnit.Assertions.dll': 'netwasm.tunit.assertions',
    'TUnit.Core.dll': 'netwasm.tunit.core',
}


def public_member(package, version, member):
    _, archive, _ = verified_archive(package, version)
    with zipfile.ZipFile(io.BytesIO(archive)) as package_zip:
        return package_zip.read(member)


def refresh_public_assets(stage, pins):
    """Replace every versioned compiler input in the pinned reusable browser base."""
    core = pins['netwasm']['packageVersion']
    libraries = pins['libraries']['packageVersion']
    tunit = pins['tunit']['packageVersion']

    def replace(relative, package, version, member):
        destination = stage / relative
        if not destination.is_file():
            raise ValueError(f'Public base lacks expected asset: {relative}')
        destination.write_bytes(public_member(package, version, member))

    replace('compiler/target-reference.dll', 'netwasm.ref', core,
            'ref/NetWasm,Version=v0.1/NetWasm.CoreLib.dll')
    replace('compiler/target-implementation.dll', 'netwasm.runtime.wasm32', core,
            'runtime/NetWasm.CoreLib.dll')
    replace('compiler/compiler.wit.wasm', 'netwasm.toolchain', core,
            'tools/wit-packages/compiler.wit.wasm')
    replace('async-command.wit.wasm', 'netwasm.toolchain', core,
            'tools/wit-packages/async-command.wit.wasm')
    runtime = json.loads(public_member('netwasm.runtime.pack', core, 'runtime/runtime-pack.json'))
    target = next((item for item in runtime.get('targets', []) if item.get('target') == 'wasm32'), None)
    if target is None or not isinstance(target.get('systemLibraries', {}).get('names'), list):
        raise ValueError('Public runtime pack lacks wasm32 system libraries')
    replace('compiler/runtime-pack.json', 'netwasm.runtime.pack', core, 'runtime/runtime-pack.json')
    replace('runtime/wasm32/libnetwasm-runtime.a', 'netwasm.runtime.pack', core,
            'runtime/wasm32/libnetwasm-runtime.a')
    for name in target['systemLibraries']['names']:
        if not re.fullmatch(r'[A-Za-z0-9_.-]+\.a', name):
            raise ValueError(f'Invalid public runtime library: {name}')
        replace(f'runtime/wasm32/system/{name}', 'netwasm.runtime.pack', core,
                f'runtime/wasm32/system-libraries/{name}')

    for name, package in ASSEMBLY_PACKAGES.items():
        version = tunit if package.startswith('netwasm.tunit') else libraries
        member = f'lib/NetWasm,Version=v0.1/{name}'
        for role in ('references', 'implementations'):
            replace(f'{role}/{name}', package, version, member)
    actual = {path.name for path in (stage / 'references').glob('*.dll')}
    if actual != set(ASSEMBLY_PACKAGES):
        raise ValueError(f'Unexpected reusable browser reference set: {sorted(actual ^ set(ASSEMBLY_PACKAGES))}')

    for recipe_path in sorted((stage / 'recipes').glob('*.json')):
        if recipe_path.name == 'tunit-support.json':
            continue
        recipe = json.loads(recipe_path.read_text())
        recipe['version'] = tunit if recipe['id'] == 'tunit' else libraries
        recipe_path.write_bytes(encoded(recipe))

    inputs_path = stage / 'compiler/inputs.json'
    inputs = json.loads(inputs_path.read_text())
    inputs['referenceSha256'] = sha256((stage / 'compiler/target-reference.dll').read_bytes())
    inputs['browserCompilerPackage']['version'] = core
    inputs['toolchain'] = json.loads(download(
        f"https://raw.githubusercontent.com/zion-sati/NetWasm/{pins['netwasm']['commit']}/eng/toolchain.json",
        128 * 1024))
    inputs.pop('desktopReceiptSha256', None)
    for item in inputs['expectedRuntimePlan']['inputs']:
        if not item['path'].startswith('/netwasm-link/runtime/'):
            raise ValueError('Unexpected public runtime plan path')
        relative = safe_path(item['path'].removeprefix('/netwasm-link/'))
        item['sha256'] = sha256(stage.joinpath(*relative.parts).read_bytes())
    inputs_path.write_bytes(encoded(inputs))


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
        refresh_public_assets(stage, pins)
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
