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

    def test_coordinator_dispatch_builds_one_authenticated_toolchain_candidate(self):
        release = (ROOT / ".github/workflows/release.yml").read_text()
        pages = (ROOT / ".github/workflows/pages.yml").read_text()

        self.assertNotIn("tags: ['v*']", release)
        for required_input in (
            "coordinated_stage", "preparation_sha256", "source_commit",
            "infrastructure_commit", "dispatch_attempt_identity",
            "upstream_receipts", "retained_candidates",
        ):
            self.assertIn(f"      {required_input}:", release)
        self.assertIn("python3 bootstrap/eng/release-receiver.py", release)
        self.assertIn("python3 eng/build-release-compiler.py", release)
        self.assertIn("dotnet workload install wasm-tools --skip-manifest-update", release)
        self.assertIn("Build content-addressed browser toolchain", release)
        self.assertIn("python3 eng/rebuild-public-toolchain.py", release)
        self.assertIn("playground-toolchain-payload-${{ github.run_id }}", release)
        self.assertIn(
            "delivery-candidate-receipt-playground-toolchain-candidate-",
            release,
        )
        self.assertIn("cancel-in-progress: false", release)
        self.assertIn("uses: ./.github/workflows/pages.yml", release)
        self.assertIn("workflow_call:", pages)
        self.assertIn("production: true", release)
        self.assertIn("Download resolved toolchain candidate", pages)
        self.assertIn("playground-site-payload-${{ github.run_id }}", pages)
        self.assertIn("delivery-completion-playground-${{ github.run_id }}", pages)

    def test_pages_qualifies_one_site_in_three_parallel_browser_lanes(self):
        pages = (ROOT / ".github/workflows/pages.yml").read_text()

        self.assertEqual(2, pages.count("browser: [chromium, firefox, webkit]"))
        self.assertIn("name: Retain exact production site", pages)
        self.assertIn("name: Download exact production site", pages)
        self.assertIn("needs: [prepare-site, stage-site, predeploy]", pages)
        self.assertEqual(2, pages.count("bash eng/run-browser-lane.sh"))
        self.assertNotIn("rebuild-public-toolchain.py", pages)
        self.assertIn("cancel-in-progress: ${{ !inputs.production }}", pages)
        self.assertIn("name: Record immutable live evidence", pages)
        self.assertIn("name: Retain immutable delivery completion", pages)

if __name__ == "__main__":
    unittest.main()
