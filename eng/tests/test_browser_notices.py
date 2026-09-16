import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("browser_notices", ROOT / "eng/browser-notices.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BrowserNoticeVersionTests(unittest.TestCase):
    def test_released_package_versions_follow_public_pins(self):
        versions = MODULE.current_package_versions()

        self.assertEqual("0.2.0", versions["netwasm.toolchain"])
        self.assertEqual("0.2.1", versions["netwasm.tunit"])
        self.assertEqual("0.2.1", versions["netwasm.tunit.assertions"])
        self.assertEqual("0.2.1", versions["netwasm.tunit.core"])

    def test_normalization_rejects_stale_release_coordinates(self):
        files = {"notice": {"source": {
            "kind": "nuget",
            "package": "netwasm.toolchain",
            "version": "0.1.0",
            "url": "https://api.nuget.org/v3-flatcontainer/netwasm.toolchain/0.1.0/"
                   "netwasm.toolchain.0.1.0.nupkg",
        }}}

        with self.assertRaisesRegex(ValueError, "released pin"):
            MODULE.normalized_catalog_files(files, True)


if __name__ == "__main__":
    unittest.main()
