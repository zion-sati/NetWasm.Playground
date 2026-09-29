#!/usr/bin/env python3
"""Package or install the immutable browser toolchain used by Pages builds."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = 'zion-sati/NetWasm.Playground'
LATEST_RELEASE = f'https://api.github.com/repos/{REPOSITORY}/releases/latest'


def release_metadata(tag):
    if not isinstance(tag, str) or not tag.startswith('v'):
        raise ValueError('Browser toolchain release tag is invalid')
    version = tag[1:]
    import re
    if re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?', version) is None:
        raise ValueError('Browser toolchain release tag is invalid')
    asset_name = f'netwasm-playground-toolchain-{tag}.tar.gz'
    return {
        'version': version,
        'tag': tag,
        'asset': {
            'name': asset_name,
            'url': f'https://github.com/{REPOSITORY}/releases/download/{tag}/{asset_name}',
        },
    }


def latest_release_metadata(fetch=urllib.request.urlopen):
    request = urllib.request.Request(
        LATEST_RELEASE, headers={'Accept': 'application/vnd.github+json',
                                 'User-Agent': 'NetWasm.Playground-toolchain-installer'})
    with fetch(request) as response:
        release = json.load(response)
    if release.get('draft') or release.get('prerelease'):
        raise ValueError('GitHub latest release is not a published stable release')
    return release_metadata(release.get('tag_name'))


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def staged_path(root, relative):
    if not isinstance(relative, str) or '\\' in relative or '\x00' in relative:
        raise ValueError(f'Unsafe toolchain path: {relative}')
    path = PurePosixPath(relative)
    if path.is_absolute() or not path.parts or any(part in {'', '.', '..'} for part in path.parts):
        raise ValueError(f'Unsafe toolchain path: {relative}')
    return root.joinpath(*path.parts)


def verify_staged(folder):
    index_path = folder / 'index.json'
    index = json.loads(index_path.read_text())
    if set(index) != {'id', 'manifestSha256'} or not all(
            isinstance(index[key], str) and len(index[key]) == 64 and
            all(character in '0123456789abcdef' for character in index[key])
            for key in ('id', 'manifestSha256')):
        raise ValueError('Toolchain index is invalid')
    manifest_path = folder / index['id'] / 'asset-manifest.json'
    if sha256(manifest_path) != index['manifestSha256']:
        raise ValueError('Toolchain manifest hash mismatch')
    manifest = json.loads(manifest_path.read_text())
    if manifest['id'] != index['id']:
        raise ValueError('Toolchain content identity mismatch')
    assets, bundle_receipts = manifest.get('assets'), manifest.get('bundles')
    schema = manifest.get('schemaVersion')
    legacy_bundles = {'bundles/compiler.bin', 'bundles/linker.bin', 'bundles/tools.bin', 'bundles/guest.bin'}
    bundle_roles = {'compiler', 'linker', 'tools', 'guest'}
    if not isinstance(assets, dict) or not isinstance(bundle_receipts, dict) or not (
            (schema == 2 and set(bundle_receipts) == legacy_bundles) or
            (schema == 3 and set(bundle_receipts) == bundle_roles)):
        raise ValueError('Toolchain bundle manifest mismatch')
    identity = {key: manifest[key] for key in ('schemaVersion', 'pins', 'assets', 'bundles')}
    if hashlib.sha256(encoded(identity)).hexdigest() != index['id']:
        raise ValueError('Toolchain content identity mismatch')
    bundles = {}
    counts = {name: 0 for name in bundle_receipts}
    raw_bytes = {name: 0 for name in bundle_receipts}
    for name, expected in bundle_receipts.items():
        if not isinstance(expected, dict) or not isinstance(expected.get('bytes'), int) or expected['bytes'] < 1 or \
                not isinstance(expected.get('sha256'), str) or len(expected['sha256']) != 64 or \
                any(character not in '0123456789abcdef' for character in expected['sha256']):
            raise ValueError(f'Invalid toolchain bundle receipt: {name}')
        relative = expected.get('path', name)
        if schema == 3 and relative != f"bundles/{name}.{expected['sha256']}.bin":
            raise ValueError(f'Invalid toolchain bundle path: {name}')
        path = staged_path(manifest_path.parent, relative)
        if path.stat().st_size != expected['bytes'] or sha256(path) != expected['sha256']:
            raise ValueError(f'Toolchain bundle mismatch: {relative}')
        bundles[name] = path.read_bytes()
    for relative, expected in assets.items():
        if not isinstance(expected, dict) or not isinstance(expected.get('bytes'), int) or expected['bytes'] < 0 or \
                not isinstance(expected.get('sha256'), str) or len(expected['sha256']) != 64:
            raise ValueError(f'Invalid toolchain asset receipt: {relative}')
        staged_path(manifest_path.parent, relative)
        bundle = expected.get('bundle')
        if bundle is None:
            asset = staged_path(manifest_path.parent, relative)
            if asset.stat().st_size != expected['bytes'] or sha256(asset) != expected['sha256']:
                raise ValueError(f'Toolchain asset mismatch: {relative}')
        else:
            offset, length = expected.get('offset'), expected.get('bytes')
            if bundle not in bundles or not isinstance(offset, int) or offset < 0 or not isinstance(length, int) or length < 0:
                raise ValueError(f'Toolchain asset range mismatch: {relative}')
            payload = bundles[bundle][offset:offset + length]
            if len(payload) != length or hashlib.sha256(payload).hexdigest() != expected['sha256']:
                raise ValueError(f'Toolchain bundled asset mismatch: {relative}')
            counts[bundle] += 1
            raw_bytes[bundle] += length
    for name, expected in bundle_receipts.items():
        if counts[name] != expected.get('assets') or raw_bytes[name] != expected.get('rawBytes'):
            raise ValueError(f'Toolchain bundle inventory mismatch: {name}')
    print(f"PASS: verified {len(assets)} immutable assets in {len(bundles)} bundles")


def pack(source, output):
    verify_staged(source)
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('wb') as raw:
        with gzip.GzipFile(filename='', mode='wb', fileobj=raw, compresslevel=9, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
                for path in sorted(item for item in source.rglob('*') if item.is_file()):
                    relative = PurePosixPath('toolchain') / path.relative_to(source).as_posix()
                    info = tarfile.TarInfo(str(relative))
                    info.size = path.stat().st_size
                    info.mode = 0o644
                    info.mtime = info.uid = info.gid = 0
                    info.uname = info.gname = ''
                    with path.open('rb') as stream:
                        archive.addfile(info, stream)
    print(json.dumps({'archive': str(output), 'bytes': output.stat().st_size, 'sha256': sha256(output)}))


def install(output, archive=None, tag=None):
    metadata = None if archive else (
        release_metadata(tag) if tag else latest_release_metadata()
    )
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='toolchain-release-', dir=output.parent) as temporary:
        temporary = Path(temporary)
        bundle = archive.resolve() if archive else temporary / metadata['asset']['name']
        if archive is None:
            with urllib.request.urlopen(metadata['asset']['url']) as response, bundle.open('wb') as destination:
                shutil.copyfileobj(response, destination)
        stage = temporary / 'extracted'
        stage.mkdir()
        with tarfile.open(bundle, 'r:gz') as package:
            members = package.getmembers()
            for member in members:
                path = PurePosixPath(member.name)
                if not (member.isfile() or member.isdir()) or path.is_absolute() or '..' in path.parts or path.parts[:1] != ('toolchain',):
                    raise ValueError(f'Unsafe toolchain archive member: {member.name}')
            package.extractall(stage, filter='data')
        extracted = stage / 'toolchain'
        verify_staged(extracted)
        if output.exists():
            shutil.rmtree(output)
        extracted.rename(output)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    package = commands.add_parser('pack')
    package.add_argument('--source', type=Path, default=ROOT / 'public/toolchain')
    package.add_argument('--output', type=Path, required=True)
    installer = commands.add_parser('install')
    installer.add_argument('--output', type=Path, default=ROOT / 'public/toolchain')
    installer.add_argument('--archive', type=Path)
    installer.add_argument('--tag')
    installer.add_argument('--github-output', type=Path)
    args = parser.parse_args()
    try:
        if args.command == 'pack':
            pack(args.source.resolve(), args.output.resolve())
        else:
            metadata = install(args.output, args.archive, args.tag)
            if args.github_output is not None:
                if metadata is None:
                    raise ValueError('--github-output requires a released toolchain download')
                with args.github_output.open('a', encoding='utf-8') as stream:
                    stream.write(f"version={metadata['version']}\n")
                    stream.write(f"tag={metadata['tag']}\n")
    except ValueError as error:
        print(f'ERROR: {error}', file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
