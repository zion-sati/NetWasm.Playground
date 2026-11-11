#!/usr/bin/env python3
"""Packs and verifies the content-addressed browser toolchain assets that
eng/rebuild-public-toolchain.py stages."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def fingerprint(path):
    return {'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


BUNDLE_ROLES = {'compiler', 'linker', 'tools', 'guest'}
# The NetWasm hosting modules the guest workers' bundles start from (eng/bundle-toolchain-modules.mjs).
HOSTING_MODULES = (
    'browser-file-mounts.mjs',
    'component-executor.mjs',
    'output-sink-stream.mjs',
    'provider-module-identity.mjs',
    'timezone-sidecar-zones.mjs',
    'wasi-filesystem.mjs',
    'wasi-http-fetch.mjs',
    'wasi-platform.mjs',
)


def bundle_role(relative):
    path = Path(relative)
    # Background-load the large threaded optimizer module with the existing
    # Brotli-compressed tools bundle. Keep its small JavaScript bootstrap,
    # receipt, and licence addressable for module loading and verification.
    if relative == 'native-wasm-opt/wasm-opt.wasm':
        return 'tools'
    if relative.startswith('native-wasm-opt/'):
        return None
    # Fetched by the guest only for a local-time program in a zone other than UTC.
    if relative.startswith('timezones/'):
        return None
    if relative in {'wasm-merge.js', 'wasm-opt.js', 'path-browserify.js'}:
        return 'tools'
    if relative.startswith('notices/') or path.suffix in {'.js', '.mjs'}:
        return None
    if relative.startswith(('compiler/', 'references/', 'implementations/', 'recipes/')):
        return 'compiler'
    if relative.startswith(('lld/', 'runtime/')):
        return 'linker'
    if relative.startswith(('jco/', 'hosting/')):
        return 'guest'
    return 'tools'


def bundle_path(role, sha256):
    if role not in BUNDLE_ROLES or not isinstance(sha256, str) or len(sha256) != 64 or \
            any(character not in '0123456789abcdef' for character in sha256):
        raise ValueError(f'Invalid bundle identity: {role}')
    return f'bundles/{role}.{sha256}.bin'


def pack_staged_assets(folder):
    assets, grouped = {}, {}
    for path in sorted(folder.rglob('*')):
        if not path.is_file() or path.name == 'asset-manifest.json' or 'bundles' in path.relative_to(folder).parts:
            continue
        relative = path.relative_to(folder).as_posix()
        entry = fingerprint(path)
        bundle = bundle_role(relative)
        if bundle:
            grouped.setdefault(bundle, []).append((relative, path, entry))
        assets[relative] = entry

    bundles = {}
    for role, members in sorted(grouped.items()):
        temporary = folder / 'bundles' / f'.{role}.tmp'
        temporary.parent.mkdir(parents=True, exist_ok=True)
        offset = 0
        with temporary.open('wb') as output:
            for relative, path, entry in members:
                payload = path.read_bytes()
                output.write(payload)
                entry.update({'bundle': role, 'offset': offset})
                offset += len(payload)
        receipt = fingerprint(temporary)
        relative = bundle_path(role, receipt['sha256'])
        destination = folder / relative
        temporary.replace(destination)
        bundles[role] = {'path': relative, **receipt, 'assets': len(members), 'rawBytes': offset}
        for _, path, _ in members:
            path.unlink()
    return assets, bundles


def verify_bundle_layout(folder, manifest):
    assets, bundles = manifest['assets'], manifest.get('bundles')
    if manifest.get('schemaVersion') != 3 or not isinstance(bundles, dict) or not bundles:
        raise ValueError('Staged bundle manifest is invalid')
    if set(bundles) != BUNDLE_ROLES:
        raise ValueError('Staged bundle set is invalid')
    payloads = {}
    for role, expected in bundles.items():
        relative = expected.get('path')
        if relative != bundle_path(role, expected.get('sha256', '')):
            raise ValueError(f'Staged bundle path is invalid: {role}')
        path = folder / relative
        if fingerprint(path) != {key: expected[key] for key in ['bytes', 'sha256']}:
            raise ValueError(f'Staged bundle mismatch: {relative}')
        payloads[role] = path.read_bytes()
    counts = {role: 0 for role in bundles}
    raw_bytes = {role: 0 for role in bundles}
    for relative, expected in assets.items():
        bundle = expected.get('bundle')
        if bundle is None:
            if fingerprint(folder / relative) != {key: expected[key] for key in ['bytes', 'sha256']}:
                raise ValueError(f'Staged asset mismatch: {relative}')
            continue
        if bundle != bundle_role(relative) or bundle not in payloads:
            raise ValueError(f'Invalid staged asset bundle: {relative}')
        offset, length = expected.get('offset'), expected.get('bytes')
        if not isinstance(offset, int) or offset < 0 or not isinstance(length, int) or length < 0:
            raise ValueError(f'Invalid staged asset range: {relative}')
        payload = payloads[bundle][offset:offset + length]
        if len(payload) != length or hashlib.sha256(payload).hexdigest() != expected['sha256']:
            raise ValueError(f'Staged bundled asset mismatch: {relative}')
        counts[bundle] += 1
        raw_bytes[bundle] += length
    for role, expected in bundles.items():
        if counts[role] != expected.get('assets') or raw_bytes[role] != expected.get('rawBytes'):
            raise ValueError(f'Staged bundle inventory mismatch: {role}')


def verify_staged(folder):
    manifest = json.loads((folder / 'asset-manifest.json').read_text())
    verify_bundle_layout(folder, manifest)
    identity = {key: manifest[key] for key in ['schemaVersion', 'pins', 'assets', 'bundles']}
    if hashlib.sha256(encoded(identity)).hexdigest() != manifest['id'] or folder.name != manifest['id']:
        raise ValueError('Staged content identity mismatch')
    print(f"PASS: {len(manifest['assets'])} immutable assets in {len(manifest['bundles'])} bundles verified")

