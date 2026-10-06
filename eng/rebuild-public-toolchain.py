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
CANDIDATE_FEED = None
CANDIDATE_VERSION = None
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


def verify_nativeaot_compiler(folder, expected_toolchain, expected_netwasm_version):
    receipt_path = folder / 'nativeaot-compiler-receipt.json'
    receipt = json.loads(receipt_path.read_text())
    if set(receipt) != {'schemaVersion', 'netwasmVersion', 'nativeAotLlvm', 'files'} or \
            receipt['schemaVersion'] != 1 or receipt['netwasmVersion'] != expected_netwasm_version or \
            receipt['nativeAotLlvm'] != expected_toolchain or not isinstance(receipt['files'], dict):
        raise ValueError('NativeAOT compiler receipt does not match the pinned toolchain')
    expected_files = set(receipt['files']) | {receipt_path.name}
    actual_files = {path.name for path in folder.iterdir() if path.is_file()}
    if actual_files != expected_files or not any(name.endswith('.wasm') for name in receipt['files']) or \
            not any(name.endswith(('.js', '.mjs')) for name in receipt['files']):
        raise ValueError('NativeAOT compiler output inventory is incomplete')
    for name, expected in receipt['files'].items():
        path = folder / name
        if set(expected) != {'bytes', 'sha256'} or path.stat().st_size != expected['bytes'] or \
                sha256(path.read_bytes()) != expected['sha256']:
            raise ValueError(f'NativeAOT compiler output changed: {name}')


def add_browser_wasm_opt(stage, pin):
    required_pin_fields = {'repository', 'tag', 'sourceCommit', 'asset', 'url', 'bytes',
                           'sha256', 'binaryenVersion', 'effectiveVersion'}
    if set(pin) != required_pin_fields or \
            pin['repository'] != 'https://github.com/zion-sati/NetWasm.NativeTools' or \
            not re.fullmatch(r'[a-f0-9]{40}', pin['sourceCommit']) or \
            not re.fullmatch(r'[a-f0-9]{64}', pin['sha256']) or \
            not isinstance(pin['bytes'], int) or pin['bytes'] < 1 or pin['bytes'] > 32 * 1024 * 1024:
        raise ValueError('Invalid browser wasm-opt release pin')
    expected_url = (f"{pin['repository']}/releases/download/{pin['tag']}/{pin['asset']}")
    if pin['url'] != expected_url:
        raise ValueError('Browser wasm-opt release URL does not match its coordinates')
    payload = download(pin['url'], pin['bytes'])
    if len(payload) != pin['bytes'] or sha256(payload) != pin['sha256']:
        raise ValueError('Pinned browser wasm-opt release changed')
    expected_files = {'wasm-opt.js', 'wasm-opt.wasm', 'build-receipt.json', 'LICENSE.upstream'}
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        infos = archive.infolist()
        if {info.filename for info in infos} != expected_files or \
                len(infos) != len(expected_files) or any(info.is_dir() for info in infos):
            raise ValueError('Browser wasm-opt release inventory changed')
        files = {info.filename: archive.read(info) for info in infos}
    try:
        receipt = json.loads(files['build-receipt.json'])
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError('Invalid browser wasm-opt build receipt') from error
    if receipt.get('schemaVersion') != 1 or receipt.get('adaptationVersion') != 1 or \
            receipt.get('sourceCommit') != pin['sourceCommit'] or \
            receipt.get('binaryenVersion') != pin['binaryenVersion'] or \
            receipt.get('effectiveVersion') != pin['effectiveVersion'] or \
            receipt.get('buildTarget') != 'wasm-opt' or \
            receipt.get('maximumWorkerCount') != 8 or receipt.get('pthreadPoolBuildSize') != 8 or \
            receipt.get('reservedProcessorCount') != 2 or \
            receipt.get('binaryenCoresEnvironmentVariable') != 'BINARYEN_CORES' or \
            receipt.get('javascriptSize') != len(files['wasm-opt.js']) or \
            receipt.get('wasmSize') != len(files['wasm-opt.wasm']) or \
            receipt.get('javascriptSha256') != sha256(files['wasm-opt.js']) or \
            receipt.get('wasmSha256') != sha256(files['wasm-opt.wasm']) or \
            len(files['LICENSE.upstream']) < 1024:
        raise ValueError('Browser wasm-opt build receipt does not match its release')
    destination = stage / 'native-wasm-opt'
    destination.mkdir()
    for name, contents in files.items():
        (destination / name).write_bytes(contents)


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


def package_archive(package, version):
    if CANDIDATE_FEED is not None and version == CANDIDATE_VERSION:
        expected = f'{package}.{version}.nupkg'.lower()
        matches = [path for path in CANDIDATE_FEED.glob('*.nupkg')
                   if path.name.lower() == expected]
        if len(matches) != 1:
            raise ValueError(f'Candidate feed lacks one exact package: {package}/{version}')
        if matches[0].stat().st_size > 256 * 1024 * 1024:
            raise ValueError(f'Candidate package exceeds the size limit: {package}/{version}')
        return matches[0].read_bytes()
    return verified_archive(package, version)[1]


def package_members(package, version, members):
    payload = package_archive(package, version)
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        extracted = {name: archive.read(name) for name in members}
    for name, expected in members.items():
        if sha256(extracted[name]) != expected:
            raise ValueError(f'Public package member changed: {package}/{name}')
    return extracted


def rebind_notice_origins(stage, pins):
    origins_path = stage / 'notices/origins.json'
    origins = json.loads(origins_path.read_text())
    source_families = {source['repository']: family for family, source in pins.items()}
    for target, catalog_entry in NOTICES.PUBLIC_CATALOG['files'].items():
        source = catalog_entry['source']
        if target not in origins['files'] and source.get('repository') in source_families:
            origins['files'][target] = json.loads(json.dumps(catalog_entry))
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
        catalog_entry = NOTICES.PUBLIC_CATALOG['files'].get(target)
        if catalog_entry is not None:
            entry['covers'] = catalog_entry['covers']
        source = entry['source']
        if catalog_entry is not None:
            catalog_source = catalog_entry['source']
            same_nuget_source = (source.get('kind') == catalog_source.get('kind') == 'nuget' and
                                  source.get('package') == catalog_source.get('package'))
            same_git_source = (source.get('kind') == catalog_source.get('kind') == 'git' and
                                source.get('repository') == catalog_source.get('repository'))
            if same_nuget_source or same_git_source:
                source['path'] = catalog_source['path']
        source_family = (source_families.get(source.get('repository'))
                         if source.get('kind') == 'git' else None)
        if source_family:
            commit = pins[source_family]['commit']
            repository = source['repository'].removeprefix('https://github.com/')
            notice = download(f"https://raw.githubusercontent.com/{repository}/{commit}/{source['path']}",
                              64 * 1024)
            notice_path = stage / 'notices' / target
            notice_path.parent.mkdir(parents=True, exist_ok=True)
            notice_path.write_bytes(notice)
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


def add_component_host(stage):
    subprocess.run(['node', str(ROOT / 'eng/bundle-toolchain-modules.mjs'), str(stage),
                    '--hosting-only'], check=True)


def add_http_example(stage, library_version):
    member = 'lib/NetWasm,Version=v0.1/System.Net.Http.dll'
    assembly = package_members('netwasm.system.net.http', library_version, {
        member: 'b35165fe34a6f179af6af3f6971af8e4f6999b0f07c4258c45413d662b25f528',
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
    'Microsoft.Extensions.Logging.Abstractions.dll': 'netwasm.microsoft.extensions.logging.abstractions',
    'Microsoft.Extensions.Logging.dll': 'netwasm.microsoft.extensions.logging',
    'Microsoft.Extensions.Options.dll': 'netwasm.microsoft.extensions.options',
    'Microsoft.Extensions.Primitives.dll': 'netwasm.microsoft.extensions.primitives',
    'NetWasm.TUnit.Runner.dll': 'netwasm.tunit',
    'System.IO.Hashing.dll': 'netwasm.system.io.hashing',
    'System.IO.Pipelines.dll': 'netwasm.system.io.pipelines',
    'System.Linq.AsyncEnumerable.dll': 'netwasm.system.linq.asyncenumerable',
    'System.Linq.dll': 'netwasm.system.linq',
    'System.Memory.dll': 'netwasm.system.memory',
    'System.Text.Encodings.Web.dll': 'netwasm.system.text.encodings.web',
    'System.Text.Json.dll': 'netwasm.system.text.json',
    'System.Text.RegularExpressions.dll': 'netwasm.system.text.regularexpressions',
    'System.Xml.ReaderWriter.dll': 'netwasm.system.xml',
    'TUnit.Assertions.dll': 'netwasm.tunit.assertions',
    'TUnit.Core.dll': 'netwasm.tunit.core',
    'FluentValidation.dll': 'netwasm.fluentvalidation',
}

HOSTING_MODULES = PREPARE.HOSTING_MODULES


def public_member(package, version, member):
    archive = package_archive(package, version)
    with zipfile.ZipFile(io.BytesIO(archive)) as package_zip:
        return package_zip.read(member)


def add_compiler_wit_inventories(stage, version):
    with tempfile.TemporaryDirectory(prefix='.compiler-wit-', dir=stage.parent) as temporary:
        temporary = Path(temporary)
        runner = temporary / 'run-wasm-tools.mjs'
        module = temporary / 'wasm-tools.wasm'
        runner.write_bytes(public_member(
            'netwasm.toolchain', version, 'tools/wasm-tools/run-wasm-tools.mjs'))
        module.write_bytes(public_member(
            'netwasm.toolchain', version, 'tools/wasm-tools/wasm-tools.wasm'))
        wit = stage / 'compiler/compiler.wit.wasm'
        normalized = subprocess.run([
            'node', '--no-warnings', str(runner), str(module), 'component', 'wit',
            str(wit), '--json', '--no-docs',
        ], cwd=temporary, capture_output=True, check=False)
        if normalized.returncode != 0:
            raise ValueError(
                'Could not normalize compiler WIT: '
                f'{normalized.stderr.decode(errors="replace").strip()}')
        try:
            json.loads(normalized.stdout)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError('Invalid normalized compiler WIT') from error
        (stage / 'compiler/compiler-wit.json').write_bytes(normalized.stdout)
        for world, name in (
                ('netwasm:platform/platform@1.0.0', 'compiler-wit-platform.wat'),
                ('netwasm:platform/async-platform@1.0.0', 'compiler-wit-async-platform.wat')):
            result = subprocess.run([
                'node', '--no-warnings', str(runner), str(module), 'component', 'embed',
                str(wit), '--world', world, '--dummy', '-t',
            ], cwd=temporary, capture_output=True, check=False)
            if result.returncode != 0:
                raise ValueError(
                    f'Could not derive compiler WIT core bindings for {world}: '
                    f'{result.stderr.decode(errors="replace").strip()}')
            if not result.stdout.startswith(b'(module') or len(result.stdout) > 1024 * 1024:
                raise ValueError(f'Invalid compiler WIT core bindings for {world}')
            (stage / 'compiler' / name).write_bytes(result.stdout)


def refresh_public_assets(stage, pins, runtime_plan=None, candidate_toolchain=None):
    """Replace every versioned compiler input in the pinned reusable browser base."""
    core = pins['netwasm']['packageVersion']
    libraries = pins['libraries']['packageVersion']
    tunit = pins['tunit']['packageVersion']
    fluentvalidation = pins['fluentvalidation']['packageVersion']

    def assembly_version(package):
        if package.startswith('netwasm.tunit'):
            return tunit
        if package == 'netwasm.fluentvalidation':
            return fluentvalidation
        return libraries

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
    add_compiler_wit_inventories(stage, core)
    replace('async-command.wit.wasm', 'netwasm.toolchain', core,
            'tools/wit-packages/async-command.wit.wasm')
    hosting_directory = stage / 'hosting'
    hosting_directory.mkdir(exist_ok=True)
    for name in HOSTING_MODULES:
        (hosting_directory / name).write_bytes(public_member(
            'netwasm.hosting', core, f'tools/netwasm/hosting/{name}'))
    runtime = json.loads(public_member('netwasm.runtime.pack', core, 'runtime/runtime-pack.json'))
    target = next((item for item in runtime.get('targets', []) if item.get('target') == 'wasm32'), None)
    if target is None or not isinstance(target.get('systemLibraries', {}).get('names'), list):
        raise ValueError('Public runtime pack lacks wasm32 system libraries')
    replace('compiler/runtime-pack.json', 'netwasm.runtime.pack', core, 'runtime/runtime-pack.json')
    runtime_directory = stage / 'runtime/wasm32'
    if not runtime_directory.is_dir():
        raise ValueError('Public base lacks the wasm32 runtime directory')
    runtime_files = {}
    for field in ('runtimeArchive', 'collectorArchive', 'allowedUndefinedSymbols'):
        asset = target.get(field)
        if (not isinstance(asset, dict) or set(asset) != {'path', 'sha256'} or
                not isinstance(asset['path'], str) or not isinstance(asset['sha256'], str) or
                not re.fullmatch(r'[a-f0-9]{64}', asset['sha256'])):
            raise ValueError(f'Public runtime pack has an invalid {field}')
        relative = safe_path(asset['path'])
        if len(relative.parts) < 2 or relative.parts[0] != 'wasm32':
            raise ValueError(f'Public runtime pack has an invalid wasm32 asset path: {asset["path"]}')
        payload = public_member('netwasm.runtime.pack', core, f'runtime/{relative.as_posix()}')
        if sha256(payload) != asset['sha256']:
            raise ValueError(f'Public runtime pack asset changed: {asset["path"]}')
        runtime_files[PurePosixPath(*relative.parts[1:])] = payload
    for existing in runtime_directory.iterdir():
        if existing.name == 'system':
            if not existing.is_dir():
                raise ValueError('Public base runtime system-library entry is not a directory')
        elif existing.is_dir():
            shutil.rmtree(existing)
        elif existing.is_file():
            existing.unlink()
        else:
            raise ValueError(f'Unexpected public base runtime entry: {existing.name}')
    for relative, payload in runtime_files.items():
        destination = runtime_directory.joinpath(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(payload)
    system_names = target['systemLibraries']['names']
    system_assets = target['systemLibraries'].get('assets')
    if len(system_names) != len(set(system_names)):
        raise ValueError('Public runtime pack contains duplicate wasm32 system libraries')
    if not isinstance(system_assets, list) or len(system_assets) != len(system_names):
        raise ValueError('Public runtime pack has an incomplete wasm32 system-library closure')
    for name, asset in zip(system_names, system_assets):
        expected_path = f'wasm32/system-libraries/{name}'
        if (not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+\.a', name) or
                not isinstance(asset, dict) or set(asset) != {'path', 'sha256'} or
                asset.get('path') != expected_path or
                not isinstance(asset.get('sha256'), str) or
                not re.fullmatch(r'[a-f0-9]{64}', asset['sha256'])):
            raise ValueError(f'Invalid public runtime library: {name}')
    system_directory = runtime_directory / 'system'
    if not system_directory.is_dir():
        raise ValueError('Public base lacks the wasm32 system-library directory')
    for existing in system_directory.iterdir():
        if not existing.is_file() or not re.fullmatch(r'[A-Za-z0-9_.-]+\.a', existing.name):
            raise ValueError(f'Unexpected public base system-library entry: {existing.name}')
        if existing.name not in system_names:
            existing.unlink()
    for name, asset in zip(system_names, system_assets):
        payload = public_member('netwasm.runtime.pack', core, f'runtime/{asset["path"]}')
        if sha256(payload) != asset['sha256']:
            raise ValueError(f'Public runtime system library changed: {name}')
        (system_directory / name).write_bytes(payload)

    for name, package in ASSEMBLY_PACKAGES.items():
        version = assembly_version(package)
        member = f'lib/NetWasm,Version=v0.1/{name}'
        assembly = public_member(package, version, member)
        for role in ('references', 'implementations'):
            destination = stage / role / name
            destination.parent.mkdir(exist_ok=True)
            destination.write_bytes(assembly)
    actual = {path.name for path in (stage / 'references').glob('*.dll')}
    if actual != set(ASSEMBLY_PACKAGES):
        raise ValueError(f'Unexpected reusable browser reference set: {sorted(actual ^ set(ASSEMBLY_PACKAGES))}')

    library_recipes = {
        'async-linq': ['System.Linq.AsyncEnumerable.dll', 'System.Linq.dll'],
        'pipelines': ['System.IO.Pipelines.dll', 'System.Memory.dll'],
        'web-encoding': ['System.Text.Encodings.Web.dll'],
        'xml': ['System.Xml.ReaderWriter.dll'],
        'fluentvalidation': ['FluentValidation.dll', 'System.Linq.dll',
                             'System.Text.RegularExpressions.dll'],
        'logging': ['Microsoft.Extensions.Logging.Abstractions.dll', 'Microsoft.Extensions.Logging.dll',
                    'Microsoft.Extensions.Options.dll', 'Microsoft.Extensions.Primitives.dll',
                    'Microsoft.Extensions.DependencyInjection.Abstractions.dll',
                    'Microsoft.Extensions.DependencyInjection.dll'],
    }
    for recipe_id, assemblies in library_recipes.items():
        paths = {name: f'references/{name}' for name in assemblies}
        implementations = {name: f'implementations/{name}' for name in assemblies}
        packages = sorted({ASSEMBLY_PACKAGES[name] for name in assemblies})
        (stage / 'recipes' / f'{recipe_id}.json').write_bytes(encoded({
            'schemaVersion': 1, 'id': recipe_id, 'references': paths,
            'implementations': implementations, 'packages': packages, 'version': libraries}))

    for recipe_path in sorted((stage / 'recipes').glob('*.json')):
        if recipe_path.name == 'tunit-support.json':
            continue
        recipe = json.loads(recipe_path.read_text())
        recipe['version'] = (tunit if recipe['id'] == 'tunit' else
                             fluentvalidation if recipe['id'] == 'fluentvalidation' else libraries)
        recipe_path.write_bytes(encoded(recipe))

    inputs_path = stage / 'compiler/inputs.json'
    inputs = json.loads(inputs_path.read_text())
    inputs['referenceSha256'] = sha256((stage / 'compiler/target-reference.dll').read_bytes())
    inputs['browserCompilerPackage']['version'] = core
    inputs['toolchain'] = candidate_toolchain or json.loads(download(
        f"https://raw.githubusercontent.com/zion-sati/NetWasm/{pins['netwasm']['commit']}/eng/toolchain.json",
        128 * 1024))
    inputs.pop('desktopReceiptSha256', None)
    if runtime_plan is not None:
        if (not isinstance(runtime_plan, dict) or
                set(runtime_plan) != {'arguments', 'optimizationArguments', 'inputs', 'maximumMemorySizeBytes'} or
                not isinstance(runtime_plan['arguments'], list) or
                not isinstance(runtime_plan['optimizationArguments'], list) or
                not isinstance(runtime_plan['inputs'], list) or
                not isinstance(runtime_plan['maximumMemorySizeBytes'], int) or
                runtime_plan['maximumMemorySizeBytes'] <= 0 or
                runtime_plan['maximumMemorySizeBytes'] % 65536 != 0):
            raise ValueError('Candidate runtime plan has an unexpected shape')
        if (len(runtime_plan['arguments']) > 256 or len(runtime_plan['optimizationArguments']) > 256 or
                any(not isinstance(argument, str) or len(argument) > 4096
                    for argument in runtime_plan['arguments'] + runtime_plan['optimizationArguments'])):
            raise ValueError('Candidate runtime plan has invalid arguments')
        paths = set()
        for item in runtime_plan['inputs']:
            if (not isinstance(item, dict) or set(item) != {'path', 'sha256'} or
                    not isinstance(item['path'], str) or
                    not isinstance(item['sha256'], str) or
                    not re.fullmatch(r'[a-f0-9]{64}', item['sha256']) or
                    item['path'] in paths):
                raise ValueError('Candidate runtime plan has invalid inputs')
            paths.add(item['path'])
        inputs['expectedRuntimePlan'] = runtime_plan
    else:
        # This capture belongs to the previous release base. Production plans
        # each link from the refreshed runtime manifest and application layout.
        inputs.pop('expectedRuntimePlan', None)
    if 'expectedRuntimePlan' in inputs:
        for item in inputs['expectedRuntimePlan']['inputs']:
            if not item['path'].startswith('/netwasm-link/runtime/'):
                raise ValueError('Unexpected public runtime plan path')
            relative = safe_path(item['path'].removeprefix('/netwasm-link/'))
            item['sha256'] = sha256(stage.joinpath(*relative.parts).read_bytes())
    inputs_path.write_bytes(encoded(inputs))


def main():
    global CANDIDATE_FEED, CANDIDATE_VERSION
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--compiler-framework', type=Path, required=True)
    parser.add_argument('--workers', type=Path, default=ROOT / 'src/workers')
    parser.add_argument('--output', type=Path, default=ROOT / 'public/toolchain')
    parser.add_argument('--candidate-feed', type=Path)
    parser.add_argument('--candidate-version')
    parser.add_argument('--candidate-commit')
    parser.add_argument('--candidate-tunit-version')
    parser.add_argument('--candidate-tunit-commit')
    parser.add_argument('--runtime-plan', type=Path,
                        help='Actual candidate compiler runtime plan captured from a preliminary toolchain')
    parser.add_argument('--candidate-toolchain-manifest', type=Path,
                        help='Local eng/toolchain.json paired with a local compiler candidate')
    args = parser.parse_args()
    candidate_values = (args.candidate_feed, args.candidate_version, args.candidate_commit)
    if any(candidate_values) != all(candidate_values):
        parser.error('--candidate-feed, --candidate-version and --candidate-commit must be supplied together')
    if args.candidate_commit and not re.fullmatch(r'[a-f0-9]{40}', args.candidate_commit):
        parser.error('--candidate-commit must be a full Git SHA')
    if args.candidate_version and not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+', args.candidate_version):
        parser.error('--candidate-version must be an exact prerelease version')
    tunit_values = (args.candidate_tunit_version, args.candidate_tunit_commit)
    if any(tunit_values) != all(tunit_values) or any(tunit_values) and not args.candidate_feed:
        parser.error('--candidate-tunit-version and --candidate-tunit-commit require each other and a candidate feed')
    if args.candidate_tunit_version and not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+', args.candidate_tunit_version):
        parser.error('--candidate-tunit-version must be an exact prerelease version')
    if args.candidate_tunit_commit and not re.fullmatch(r'[a-f0-9]{40}', args.candidate_tunit_commit):
        parser.error('--candidate-tunit-commit must be a full Git SHA')
    if args.candidate_feed and not args.candidate_feed.is_dir():
        parser.error('--candidate-feed must be an existing directory')
    if args.runtime_plan and not args.candidate_feed:
        parser.error('--runtime-plan is only valid with a candidate feed')
    if args.candidate_toolchain_manifest and not args.candidate_feed:
        parser.error('--candidate-toolchain-manifest is only valid with a candidate feed')
    CANDIDATE_FEED = args.candidate_feed.resolve() if args.candidate_feed else None
    CANDIDATE_VERSION = args.candidate_version
    runtime_plan = json.loads(args.runtime_plan.read_text()) if args.runtime_plan else None
    candidate_toolchain = (json.loads(args.candidate_toolchain_manifest.read_text())
                           if args.candidate_toolchain_manifest else None)
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
        upstream = json.loads((ROOT / 'eng/upstream-sources.json').read_text())
        release_pins = upstream['sources']
        pins = json.loads(json.dumps(release_pins))
        if CANDIDATE_FEED is not None:
            pins['netwasm']['packageVersion'] = CANDIDATE_VERSION
            pins['netwasm']['commit'] = args.candidate_commit
        if args.candidate_tunit_version:
            pins['tunit']['packageVersion'] = args.candidate_tunit_version
            pins['tunit']['commit'] = args.candidate_tunit_commit
        verify_nativeaot_compiler(args.compiler_framework, upstream['nativeAotLlvmCandidate'],
                                  pins['netwasm']['packageVersion'])
        pins['nativeAotLlvmCompilerHost'] = upstream['nativeAotLlvmCandidate']
        add_browser_wasm_opt(stage, upstream['browserWasmOpt'])
        pins['browserWasmOpt'] = upstream['browserWasmOpt']
        refresh_public_assets(stage, pins, runtime_plan, candidate_toolchain)
        rebind_notice_origins(stage, release_pins)
        add_guest_providers(stage, package_archive('netwasm.toolchain', pins['netwasm']['packageVersion']))
        add_component_host(stage)
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
