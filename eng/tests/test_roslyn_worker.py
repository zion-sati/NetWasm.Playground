import importlib.util
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("roslyn_worker", ROOT / "eng/roslyn-worker.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class VerifiedPackageMemberTests(unittest.TestCase):
    def test_accepts_stable_and_prerelease_package_versions(self):
        for version in ("0.2.0", "0.2.1-preview.1"):
            with self.subTest(version=version), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                relative = Path("packages/example.package") / version / "tools/tool.dll"
                archive = root / "packages/example.package" / version / f"example.package.{version}.nupkg"
                archive.parent.mkdir(parents=True)
                with zipfile.ZipFile(archive, "w") as package:
                    package.writestr("tools/tool.dll", b"public package bytes")
                extracted = root / relative
                extracted.parent.mkdir(parents=True)
                extracted.write_bytes(b"public package bytes")

                self.assertEqual(extracted, MODULE.verified_package_member(root, relative))

    def test_rejects_an_extraction_that_differs_from_the_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            relative = Path("packages/example.package/0.2.0/tools/tool.dll")
            archive = root / "packages/example.package/0.2.0/example.package.0.2.0.nupkg"
            archive.parent.mkdir(parents=True)
            with zipfile.ZipFile(archive, "w") as package:
                package.writestr("tools/tool.dll", b"archive")
            extracted = root / relative
            extracted.parent.mkdir(parents=True)
            extracted.write_bytes(b"different")

            with self.assertRaisesRegex(RuntimeError, "differs from public archive"):
                MODULE.verified_package_member(root, relative)

    def test_rejects_paths_outside_the_package_cache(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for relative in ("../private/tool.dll", "/packages/example/0.2.0/tool.dll"):
                with self.subTest(relative=relative), self.assertRaisesRegex(
                    RuntimeError, "Unapproved trusted package path"
                ):
                    MODULE.verified_package_member(root, relative)


if __name__ == "__main__":
    unittest.main()
