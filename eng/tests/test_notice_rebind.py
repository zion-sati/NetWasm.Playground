import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('rebuild', ROOT / 'eng/rebuild-public-toolchain.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class NoticeRebindTests(unittest.TestCase):
    def test_notices_the_catalog_no_longer_lists_are_removed(self):
        catalogued = next(iter(MODULE.NOTICES.PUBLIC_CATALOG['files']))
        with tempfile.TemporaryDirectory() as temporary:
            stage = Path(temporary)
            for name in (catalogued, 'bdwgc/AUTHORS'):
                path = stage / 'notices' / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('notice')
            origins = {'files': {catalogued: {}, 'bdwgc/AUTHORS': {}}}

            MODULE.drop_uncatalogued_notices(stage, origins)

            self.assertEqual([catalogued], list(origins['files']))
            self.assertTrue((stage / 'notices' / catalogued).is_file())
            self.assertFalse((stage / 'notices/bdwgc/AUTHORS').exists())


if __name__ == '__main__':
    unittest.main()
