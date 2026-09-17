#!/usr/bin/env python3
"""Rebuild the release toolchain from a pinned public base and clean compiler host."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('prepare_web', ROOT / 'eng/prepare-web.py')
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)


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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--compiler-framework', type=Path, required=True)
    parser.add_argument('--workers', type=Path, default=ROOT / 'src/workers')
    parser.add_argument('--output', type=Path, default=ROOT / 'public/toolchain')
    args = parser.parse_args()
    base = json.loads((ROOT / 'eng/toolchain-base.json').read_text())
    if base.get('schemaVersion') != 1 or not base['url'].endswith(base['id'] + '/'):
        raise ValueError('Pinned public base coordinates are invalid')
    manifest_bytes = download(urllib.parse.urljoin(base['url'], 'asset-manifest.json'), 2 * 1024 * 1024)
    if sha256(manifest_bytes) != base['manifestSha256']:
        raise ValueError('Pinned public base manifest changed')
    manifest = json.loads(manifest_bytes)
    if manifest.get('schemaVersion') != 1 or manifest.get('id') != base['id'] or not isinstance(manifest.get('assets'), dict):
        raise ValueError('Pinned public base manifest is invalid')
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.release-staging-', dir=args.output) as temporary:
        stage = Path(temporary)
        entries = [(name, receipt) for name, receipt in manifest['assets'].items()
                   if not name.startswith('compiler/_framework/') and not name.startswith('workers/')]

        def fetch(entry):
            name, receipt = entry
            path = safe_path(name)
            if not isinstance(receipt.get('bytes'), int) or receipt['bytes'] < 0 or not isinstance(receipt.get('sha256'), str):
                raise ValueError(f'Invalid public base receipt: {name}')
            quoted = '/'.join(urllib.parse.quote(part, safe='@._-') for part in path.parts)
            payload = download(urllib.parse.urljoin(base['url'], quoted), receipt['bytes'])
            if len(payload) != receipt['bytes'] or sha256(payload) != receipt['sha256']:
                raise ValueError(f'Pinned public base asset changed: {name}')
            destination = stage.joinpath(*path.parts)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(payload)

        with ThreadPoolExecutor(max_workers=16) as pool:
            list(pool.map(fetch, entries))
        framework = stage / 'compiler/_framework'
        shutil.copytree(args.compiler_framework, framework)
        workers = sorted(args.workers.glob('*.mjs'))
        required = {'compiler-worker.mjs', 'tools-worker.mjs', 'lld-worker.mjs', 'guest-worker.mjs'}
        if not required.issubset({path.name for path in workers}):
            raise ValueError('Release worker set is incomplete')
        (stage / 'workers').mkdir()
        for path in workers:
            shutil.copyfile(path, stage / 'workers' / path.name)
        subprocess.run(['node', str(ROOT / 'eng/bundle-toolchain-modules.mjs'), str(stage)], check=True)
        assets, bundles = PREPARE.pack_staged_assets(stage)
        identity = {'schemaVersion': 2, 'pins': manifest['pins'], 'assets': assets, 'bundles': bundles}
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
