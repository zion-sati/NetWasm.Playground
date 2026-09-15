#!/usr/bin/env python3
"""Bind/verify compact probe evidence and its staged public tool assets."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('run', type=Path)
parser.add_argument('--record', action='store_true')
args = parser.parse_args()
run = args.run.resolve()
receipt = run / 'receipt.json'
if args.record:
    sources = run / 'source'
    sources.mkdir(exist_ok=True)
    for path in Path(__file__).parent.iterdir():
        if path.is_file():
            shutil.copyfile(path, sources / path.name)
    result = json.loads((run / 'worker-test.json').read_text())
    if result.get('passed') is not True:
        raise ValueError('Browser probe did not pass')
    paths = [path for path in run.iterdir() if path.is_file() and path.name != 'receipt.json']
    paths += [path for directory in ['site', 'source'] for path in (run / directory).rglob('*') if path.is_file()]
    files = {path.relative_to(run).as_posix(): {'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()} for path in paths}
    receipt.write_text(json.dumps({'schema': 1, 'passed': True, 'retention': 'Reusable verified browser-tool assets plus compact source/input/result/failure evidence; node_modules reproducible from package-lock.json.', 'files': files}, indent=2) + '\n')
for name, expected in json.loads(receipt.read_text())['files'].items():
    path = run / name
    if path.stat().st_size != expected['bytes'] or hashlib.sha256(path.read_bytes()).hexdigest() != expected['sha256']:
        raise ValueError(f'Receipt mismatch: {name}')
print('PASS: browser-tool receipt and retained files match')
