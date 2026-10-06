import importlib.util
import hashlib
import io
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

    def test_release_coordinates_follow_the_github_release_tag(self):
        metadata = MODULE.release_metadata('v0.5.0-preview.1')

        self.assertEqual('0.5.0-preview.1', metadata["version"])
        self.assertEqual('v0.5.0-preview.1', metadata["tag"])
        self.assertEqual(
            f'netwasm-playground-toolchain-{metadata["tag"]}.tar.gz',
            metadata["asset"]["name"],
        )
        self.assertTrue(metadata["asset"]["url"].endswith(
            f'/{metadata["tag"]}/{metadata["asset"]["name"]}'
        ))
        self.assertNotIn("index", metadata)
        self.assertEqual({"name", "url"}, set(metadata["asset"]))

    def test_latest_stable_release_is_resolved_from_github(self):
        payload = io.BytesIO(json.dumps({
            'tag_name': 'v0.5.0', 'draft': False, 'prerelease': False,
        }).encode())

        metadata = MODULE.latest_release_metadata(lambda request: payload)

        self.assertEqual('v0.5.0', metadata['tag'])

    def test_github_release_builds_the_toolchain_then_calls_pages(self):
        release = (ROOT / ".github/workflows/release.yml").read_text()
        pages = (ROOT / ".github/workflows/pages.yml").read_text()

        self.assertIn("release:\n    types: [published]", release)
        self.assertIn("Existing published GitHub Release tag to retry", release)
        self.assertIn("Reuse published browser toolchain when resuming", release)
        self.assertIn("--output source/public/toolchain", release)
        self.assertGreaterEqual(release.count("steps.published.outputs.found != 'true'"), 6)
        self.assertNotIn("Published toolchain asset differs from this release build", release)
        self.assertIn("python3 source/eng/build-nativeaot-compiler.py", release)
        self.assertIn("nativeaot-compiler-receipt.json", release)
        self.assertNotIn("dotnet workload install wasm-tools", release)
        self.assertIn("Build content-addressed browser toolchain manifest", release)
        self.assertIn("python3 source/eng/rebuild-public-toolchain.py", release)
        self.assertIn("Retain exact browser toolchain archive", release)
        pages = (ROOT / '.github/workflows/pages.yml').read_text()
        self.assertIn('playground_version: ${{ inputs.version || steps.released-toolchain.outputs.version }}', pages)
        self.assertEqual(2, pages.count('EXPECTED_PLAYGROUND_VERSION: ${{ needs.build-site.outputs.playground_version }}'))
        deployment = (ROOT / 'eng/browser-smoke/deployment.mjs').read_text()
        self.assertIn('process.env.EXPECTED_PLAYGROUND_VERSION ??', deployment)
        self.assertIn("release_archive_sha256: ${{ needs.build-release.outputs.release_archive_sha256 }}", release)
        self.assertIn("uses: ./.github/workflows/pages.yml", release)
        self.assertIn("workflow_call:", pages)
        self.assertIn("source_ref: ${{ needs.build-release.outputs.source_ref }}", release)
        self.assertIn("PLAYGROUND_VERSION: ${{ inputs.version || steps.released-toolchain.outputs.version }}", pages)
        self.assertIn("Download exact browser toolchain archive", pages)
        self.assertIn("actual_sha256 != expected_sha256", pages)
        self.assertIn("toolchain_id: ${{ steps.toolchain.outputs.id }}", pages)
        self.assertIn("EXPECTED_TOOLCHAIN_ID: ${{ needs.build-site.outputs.toolchain_id }}", pages)

    def test_pages_qualifies_one_site_in_three_parallel_browser_lanes(self):
        pages = (ROOT / ".github/workflows/pages.yml").read_text()
        multifile = (ROOT / "eng/browser-smoke/multifile.mjs").read_text()

        self.assertEqual(2, pages.count("browser: [chromium, firefox, webkit]"))
        self.assertIn("name: Retain exact production site", pages)
        self.assertIn("name: Download exact production site", pages)
        self.assertIn("needs: [build-site, predeploy]", pages)
        self.assertEqual(2, pages.count("bash eng/run-browser-lane.sh"))
        self.assertNotIn("rebuild-public-toolchain.py", pages)
        self.assertIn("import { browserType } from './engine.mjs';", multifile)
        self.assertNotIn("import { chromium } from 'playwright';", multifile)

if __name__ == "__main__":
    unittest.main()
