import importlib.util
import hashlib
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("toolchain_release", ROOT / "eng/toolchain-release.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
PREPARE_SPEC = importlib.util.spec_from_file_location("prepare_web", ROOT / "eng/prepare-web.py")
PREPARE = importlib.util.module_from_spec(PREPARE_SPEC)
PREPARE_SPEC.loader.exec_module(PREPARE)


class ToolchainReleaseVersionTests(unittest.TestCase):
    def test_release_verifier_accepts_sha_named_bundle_manifest(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stage = root / 'stage'
            fixtures = {
                'compiler/compiler.wasm': b'compiler',
                'lld/linker.wasm': b'linker',
                'jco/guest.wasm': b'guest',
                'command.wit.wasm': b'tools',
            }
            for relative, payload in fixtures.items():
                path = stage / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(payload)
            assets, bundles = PREPARE.pack_staged_assets(stage)
            identity = {'schemaVersion': 3, 'pins': {}, 'assets': assets, 'bundles': bundles}
            digest = hashlib.sha256(PREPARE.encoded(identity)).hexdigest()
            (stage / 'asset-manifest.json').write_bytes(PREPARE.encoded({**identity, 'id': digest}))
            destination = root / digest
            stage.rename(destination)
            manifest_sha = hashlib.sha256((destination / 'asset-manifest.json').read_bytes()).hexdigest()
            (root / 'index.json').write_bytes(PREPARE.encoded({'id': digest, 'manifestSha256': manifest_sha}))

            MODULE.verify_staged(root)

            for role, receipt in bundles.items():
                self.assertEqual(f'bundles/{role}.{receipt["sha256"]}.bin', receipt['path'])

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
        self.assertNotIn("index", metadata)
        self.assertEqual({"name", "url"}, set(metadata["asset"]))

    def test_tag_builds_the_release_then_calls_pages_for_that_tag(self):
        release = (ROOT / ".github/workflows/release.yml").read_text()
        pages = (ROOT / ".github/workflows/pages.yml").read_text()

        self.assertIn("tags: ['v*']", release)
        self.assertIn("python3 eng/build-release-compiler.py", release)
        self.assertIn("dotnet workload install wasm-tools --version 10.0.302 --skip-manifest-update", release)
        self.assertIn("Build content-addressed browser toolchain manifest", release)
        self.assertIn("python3 eng/rebuild-public-toolchain.py", release)
        self.assertIn("uses: ./.github/workflows/pages.yml", release)
        self.assertIn("workflow_call:", pages)
        self.assertIn("toolchain_id: ${{ steps.toolchain.outputs.id }}", pages)
        self.assertIn("EXPECTED_TOOLCHAIN_ID: ${{ needs.build-and-test.outputs.toolchain_id }}", pages)

if __name__ == "__main__":
    unittest.main()
