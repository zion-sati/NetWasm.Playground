import copy
import importlib.util
from pathlib import Path, PurePosixPath
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('rebuild', ROOT / 'eng/rebuild-public-toolchain.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def target(collector):
    def asset(name):
        return {'path': f'wasm32/{collector}/{name}', 'sha256': 'a' * 64}
    return {'target': 'wasm32', 'garbageCollector': collector,
            'systemLibraries': {'names': ['libc.a']},
            'runtimeArchive': asset('runtime.a'), 'collectorArchive': asset('gc.a'),
            'allowedUndefinedSymbols': asset('allowed.txt'),
            'speed': {'runtimeArchive': asset('speed/runtime.a'), 'collectorArchive': asset('speed/gc.a')}}


class RuntimeVariantTests(unittest.TestCase):
    def test_all_collectors_and_profiles_are_retained(self):
        targets = [target(name) for name in ['Compact', 'NetWasm', 'Boehm', 'Bump']]
        assets = MODULE.runtime_variant_assets(targets)
        self.assertEqual(20, len(assets))
        for item in targets:
            self.assertIn(PurePosixPath(item['speed']['collectorArchive']['path']), assets)
            self.assertIn(PurePosixPath(item['allowedUndefinedSymbols']['path']), assets)

    def test_invalid_and_conflicting_variants_fail(self):
        original = target('Compact')
        cases = [[], [original, original]]
        for path in ['../escape', 'wasm64/gc.a']:
            invalid = copy.deepcopy(original)
            invalid['collectorArchive']['path'] = path
            cases.append([invalid])
        invalid = copy.deepcopy(original)
        invalid['speed']['collectorArchive']['sha256'] = 'bad'
        cases.append([invalid])
        other = target('Bump')
        other['systemLibraries'] = {'names': ['different.a']}
        cases.append([original, other])
        for case in cases:
            with self.assertRaises(ValueError):
                MODULE.runtime_variant_assets(case)

    def test_shared_assets_are_deduplicated_only_when_hashes_agree(self):
        targets = [target(name) for name in ['Compact', 'NetWasm', 'Boehm', 'Bump']]
        for item in targets:
            item['allowedUndefinedSymbols'] = {'path': 'wasm32/shared.txt', 'sha256': 'b' * 64}
        self.assertEqual(17, len(MODULE.runtime_variant_assets(targets)))
        targets[-1]['allowedUndefinedSymbols']['sha256'] = 'c' * 64
        with self.assertRaises(ValueError):
            MODULE.runtime_variant_assets(targets)


if __name__ == '__main__':
    unittest.main()
