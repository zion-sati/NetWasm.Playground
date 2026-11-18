import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zipfile

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


def package_with(path, notice):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as archive:
        archive.writestr(path, notice)
    return buffer.getvalue()


class PublicPackageNoticeTests(unittest.TestCase):
    NOTICE = b'third-party notices'
    ARCHIVE = package_with('THIRD-PARTY-NOTICES.TXT', NOTICE)
    URL = 'https://api.nuget.org/v3-flatcontainer/example/1.0.0/example.1.0.0.nupkg'

    def catalog(self, archive=None, notice=None):
        archive, notice = archive or self.ARCHIVE, notice or self.NOTICE
        public = {'bytes': len(notice), 'covers': ['implementations/Example.*'],
                  'sha256': hashlib.sha256(notice).hexdigest(),
                  'source': {'kind': 'nuget', 'package': 'example', 'version': '1.0.0', 'url': self.URL,
                             'archiveSha256': hashlib.sha256(archive).hexdigest(), 'path': 'THIRD-PARTY-NOTICES.TXT'}}
        rebuilt = {'bytes': 1, 'covers': [], 'sha256': '0' * 64,
                   'source': {'kind': 'nuget', 'package': 'netwasm.toolchain', 'version': '0.1.0'}}
        git = {'bytes': 1, 'covers': [], 'sha256': '0' * 64,
               'source': {'kind': 'git', 'repository': 'https://github.com/example/example', 'path': 'LICENSE'}}
        return {'files': {'dotnet/example/THIRD-PARTY-NOTICES.TXT': public, 'binaryen/LICENSE': rebuilt,
                          'example/LICENSE': git}}

    def bind(self, origins, fetched, catalog=None):
        calls = []
        def fetch(package, version):
            calls.append((package, version))
            return fetched
        with tempfile.TemporaryDirectory() as temporary, \
                mock.patch.object(MODULE.NOTICES, 'PUBLIC_CATALOG', catalog or self.catalog()):
            stage = Path(temporary)
            for target, notice in origins.pop('_files', {}).items():
                (stage / 'notices' / target).parent.mkdir(parents=True, exist_ok=True)
                (stage / 'notices' / target).write_bytes(notice)
            MODULE.bind_public_package_notices(stage, origins, {'netwasm.toolchain'}, fetch)
            written = {path.relative_to(stage / 'notices').as_posix(): path.read_bytes()
                       for path in (stage / 'notices').rglob('*') if path.is_file()} \
                if (stage / 'notices').exists() else {}
        return calls, written

    def test_a_notice_the_base_lacks_comes_from_its_pinned_package(self):
        origins = {'files': {}}
        calls, written = self.bind(origins, (self.URL, self.ARCHIVE, 'hash'))
        self.assertEqual([('example', '1.0.0')], calls)
        self.assertEqual({'dotnet/example/THIRD-PARTY-NOTICES.TXT': self.NOTICE}, written)
        self.assertEqual(self.catalog()['files']['dotnet/example/THIRD-PARTY-NOTICES.TXT'],
                         origins['files']['dotnet/example/THIRD-PARTY-NOTICES.TXT'])
        self.assertEqual(['dotnet/example/THIRD-PARTY-NOTICES.TXT'], list(origins['files']))

    def test_a_notice_the_base_carries_as_catalogued_is_kept(self):
        entry = self.catalog()['files']['dotnet/example/THIRD-PARTY-NOTICES.TXT']
        origins = {'files': {'dotnet/example/THIRD-PARTY-NOTICES.TXT': entry},
                   '_files': {'dotnet/example/THIRD-PARTY-NOTICES.TXT': self.NOTICE}}
        calls, written = self.bind(origins, None)
        self.assertEqual([], calls)
        self.assertEqual({'dotnet/example/THIRD-PARTY-NOTICES.TXT': self.NOTICE}, written)

    def test_a_package_or_notice_that_differs_from_the_catalog_fails(self):
        with self.assertRaisesRegex(ValueError, 'Public package differs from the notice catalog'):
            self.bind({'files': {}}, (self.URL, package_with('THIRD-PARTY-NOTICES.TXT', b'other'), 'hash'))
        with self.assertRaisesRegex(ValueError, 'Public package differs from the notice catalog'):
            self.bind({'files': {}}, ('https://example.test/example.nupkg', self.ARCHIVE, 'hash'))
        archive = package_with('THIRD-PARTY-NOTICES.TXT', b'changed notice')
        with self.assertRaisesRegex(ValueError, 'Notice changed in public package'):
            self.bind({'files': {}}, (self.URL, archive, 'hash'), self.catalog(archive=archive))


if __name__ == '__main__':
    unittest.main()
