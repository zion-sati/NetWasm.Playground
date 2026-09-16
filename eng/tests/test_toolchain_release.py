import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("toolchain_release", ROOT / "eng/toolchain-release.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ToolchainReleaseVersionTests(unittest.TestCase):
    def test_release_coordinates_follow_playground_version(self):
        metadata = MODULE.release_metadata()
        package = json.loads((ROOT / "package.json").read_text())

        self.assertEqual(package["version"], metadata["version"])
        self.assertEqual(f'v{metadata["version"]}', metadata["tag"])
        self.assertEqual(
            f'netwasm-playground-toolchain-{metadata["tag"]}.tar.gz',
            metadata["asset"]["name"],
        )
        self.assertTrue(metadata["asset"]["url"].endswith(
            f'/{metadata["tag"]}/{metadata["asset"]["name"]}'
        ))

    def test_publishing_the_release_triggers_pages_for_that_tag(self):
        workflow = (ROOT / ".github/workflows/pages.yml").read_text()

        self.assertIn("release:\n    types: [published]", workflow)
        self.assertIn("github.event.release.tag_name", workflow)


if __name__ == "__main__":
    unittest.main()
