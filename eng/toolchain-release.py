#!/usr/bin/env python3
"""Package or install the immutable browser toolchain used by Pages builds."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import sys
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
METADATA = ROOT / 'eng/toolchain-release.json'


def release_metadata():
    metadata = json.loads(METADATA.read_text())
    if metadata.get('status') != 'ready':
        reason = metadata.get('reason', 'No deployable browser toolchain is configured.')
        raise ValueError(f'Browser toolchain release is not ready: {reason}')
    version = metadata.get('version')
    tag = f'v{version}'
    asset_name = f'netwasm-playground-toolchain-{tag}.tar.gz'
    if metadata.get('tag') != tag or metadata.get('asset', {}).get('name') != asset_name:
        raise ValueError('Browser toolchain release coordinates do not match its version')
    expected_url = f'https://github.com/zion-sati/NetWasm.Playground/releases/download/{tag}/{asset_name}'
    if metadata['asset'].get('url') != expected_url:
        raise ValueError('Browser toolchain release URL does not match its version')
    return metadata


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def verify_staged(folder, metadata):
    index_path = folder / 'index.json'
    index = json.loads(index_path.read_text())
    if index != metadata['index']:
        raise ValueError('Toolchain index does not match release metadata')
    manifest_path = folder / index['id'] / 'asset-manifest.json'
    if sha256(manifest_path) != index['manifestSha256']:
        raise ValueError('Toolchain manifest hash mismatch')
    manifest = json.loads(manifest_path.read_text())
    if manifest['id'] != index['id']:
        raise ValueError('Toolchain content identity mismatch')
    for relative, expected in manifest['assets'].items():
        asset = manifest_path.parent / relative
        if asset.stat().st_size != expected['bytes'] or sha256(asset) != expected['sha256']:
            raise ValueError(f'Toolchain asset mismatch: {relative}')
        if 'gzip' in expected:
            compressed = manifest_path.parent / expected['gzip']['path']
            if compressed.stat().st_size != expected['gzip']['bytes'] or sha256(compressed) != expected['gzip']['sha256']:
                raise ValueError(f'Toolchain compressed asset mismatch: {relative}')
    print(f"PASS: verified {len(manifest['assets'])} immutable toolchain assets")


def pack(source, output):
    metadata = release_metadata()
    verify_staged(source, metadata)
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


def install(output, archive=None):
    metadata = release_metadata()
    output = output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='toolchain-release-', dir=output.parent) as temporary:
        temporary = Path(temporary)
        bundle = archive.resolve() if archive else temporary / metadata['asset']['name']
        if archive is None:
            with urllib.request.urlopen(metadata['asset']['url']) as response, bundle.open('wb') as destination:
                shutil.copyfileobj(response, destination)
        if bundle.stat().st_size != metadata['asset']['bytes'] or sha256(bundle) != metadata['asset']['sha256']:
            raise ValueError('Toolchain release archive mismatch')
        stage = temporary / 'extracted'
        stage.mkdir()
        with tarfile.open(bundle, 'r:gz') as package:
            members = package.getmembers()
            for member in members:
                path = PurePosixPath(member.name)
                if member.issym() or member.islnk() or path.is_absolute() or '..' in path.parts or path.parts[:1] != ('toolchain',):
                    raise ValueError(f'Unsafe toolchain archive member: {member.name}')
            package.extractall(stage, filter='data')
        extracted = stage / 'toolchain'
        verify_staged(extracted, metadata)
        if output.exists():
            shutil.rmtree(output)
        extracted.rename(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    package = commands.add_parser('pack')
    package.add_argument('--source', type=Path, default=ROOT / 'public/toolchain')
    package.add_argument('--output', type=Path, required=True)
    installer = commands.add_parser('install')
    installer.add_argument('--output', type=Path, default=ROOT / 'public/toolchain')
    installer.add_argument('--archive', type=Path)
    args = parser.parse_args()
    try:
        if args.command == 'pack':
            pack(args.source.resolve(), args.output.resolve())
        else:
            install(args.output, args.archive)
    except ValueError as error:
        print(f'ERROR: {error}', file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
