import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "prepare_web", ROOT / "eng/prepare-web.py")
assert SPEC is not None and SPEC.loader is not None
PREPARE_WEB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE_WEB)


class PublicPackageBoundaryTests(unittest.TestCase):
    def test_release_rebuilder_uses_pinned_public_release_archive(self):
        base = json.loads((ROOT / 'eng/toolchain-base.json').read_text())
        script = (ROOT / 'eng/rebuild-public-toolchain.py').read_text()

        self.assertEqual(2, base['schemaVersion'])
        self.assertRegex(base['archive']['url'],
                         r'^https://github\.com/zion-sati/NetWasm\.Playground/releases/download/v[0-9]')
        self.assertEqual(64, len(base['archive']['sha256']))
        self.assertIn('RELEASE.verify_staged(base_toolchain)', script)
        self.assertIn("Public package member changed", script)
        self.assertIn("identity = {'schemaVersion': 3, 'pins': pins", script)
        self.assertIn('rebind_notice_origins(stage, pins)', script)
        self.assertIn("registration5-semver1", script)
        self.assertIn("NOTICES.verify(stage / 'notices')", script)
        self.assertNotIn('playground.netwasm.com/toolchain/', json.dumps(base))

    def test_stager_packs_payloads_into_four_verified_phase_bundles(self):
        with tempfile.TemporaryDirectory() as temporary:
            stage = Path(temporary)
            fixtures = {
                'compiler/a.wasm': b'compiler',
                'lld/b.wasm': b'linker',
                'jco/c.wasm': b'guest',
                'command.wit.wasm': b'tools',
                'wasm-opt.js': b'tool-script',
                'workers/worker.mjs': b'export {};',
                'notices/LICENSE.txt': b'license',
            }
            for relative, payload in fixtures.items():
                path = stage / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(payload)

            assets, bundles = PREPARE_WEB.pack_staged_assets(stage)
            manifest = {'schemaVersion': 3, 'assets': assets, 'bundles': bundles}
            PREPARE_WEB.verify_bundle_layout(stage, manifest)

            self.assertEqual({'compiler', 'linker', 'tools', 'guest'}, set(bundles))
            for role, receipt in bundles.items():
                self.assertEqual(
                    f'bundles/{role}.{receipt["sha256"]}.bin', receipt['path'])
                self.assertTrue((stage / receipt['path']).exists())
            self.assertFalse((stage / 'compiler/a.wasm').exists())
            self.assertFalse((stage / 'wasm-opt.js').exists())
            self.assertTrue((stage / 'workers/worker.mjs').exists())
            self.assertTrue((stage / 'notices/LICENSE.txt').exists())

            (stage / bundles['compiler']['path']).write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'Staged bundle mismatch'):
                PREPARE_WEB.verify_bundle_layout(stage, manifest)

    def test_compiler_host_uses_exact_public_packages_without_project_references(self):
        project = ET.parse(
            ROOT / "eng/compiler-host/CompilerProbe.csproj").getroot()

        self.assertEqual([], project.findall(".//ProjectReference"))
        references = {
            item.attrib["Include"]: item.attrib["Version"]
            for item in project.findall(".//PackageReference")
        }
        self.assertEqual({
            "NetWasm.Compiler.Browser": "[$(NetWasmCompilerPackageVersion)]",
            "NetWasm.Runtime.Pack": "[$(NetWasmCompilerPackageVersion)]",
        }, references)
        define_constants = project.findtext(".//DefineConstants", default="")
        self.assertIn("FRONTEND_CACHE_TRANSPORT", define_constants.split(";"))
        self.assertEqual("net11.0", project.findtext(".//TargetFramework"))
        self.assertEqual("11.0.0-rc.1.26425.128", json.loads(
            (ROOT / "eng/browser-host.json").read_text())["runtimeFrameworkVersion"])

        release_builder = (ROOT / 'eng/build-release-compiler.py').read_text()
        self.assertIn("11.0.100-rc.1.26425.128", release_builder)
        self.assertIn("'-p:DefineConstants=FRONTEND_CACHE_TRANSPORT'", release_builder)
        self.assertIn("'-p:WasmBuildNative=true'", release_builder)
        self.assertIn("'-p:RunAOTCompilation=false'", release_builder)
        self.assertIn("'-p:PublishTrimmed=false'", release_builder)
        self.assertIn("'-p:ILLinkTreatWarningsAsErrors=false'", release_builder)

    def test_candidate_compiler_feed_is_explicit_and_not_the_release_default(self):
        help_text = subprocess.check_output(
            ["python3", str(ROOT / "eng/build-release-compiler.py"), "--help"],
            text=True)

        self.assertIn("--candidate-feed", help_text)
        self.assertIn("--candidate-version", help_text)
        release = (ROOT / ".github/workflows/release.yml").read_text()
        self.assertNotIn("--candidate-feed", release)

    def test_asset_stager_has_no_source_checkout_option(self):
        help_text = subprocess.check_output(
            ["python3", str(ROOT / "eng/prepare-web.py"), "--help"],
            text=True)

        self.assertNotIn("--source", help_text)

    def test_package_origin_requires_receipt_bound_nuget_org_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            baseline = Path(temporary)
            package = baseline / "packages/netwasm.toolchain/1.2.3"
            package.mkdir(parents=True)
            metadata = package / ".nupkg.metadata"
            metadata.write_text(json.dumps({
                "version": 2,
                "source": "https://api.nuget.org/v3/index.json",
            }))
            archive = package / "netwasm.toolchain.1.2.3.nupkg"
            archive.write_bytes(b"public-package-fixture")
            receipt = {"packages": {
                str(archive.relative_to(baseline)): PREPARE_WEB.fingerprint(archive)
            }}

            actual = PREPARE_WEB.verify_nuget_package(
                baseline, receipt, "NetWasm.Toolchain", "1.2.3")
            self.assertEqual(package, actual)

            metadata.write_text(json.dumps({
                "version": 2,
                "source": "local-feed",
            }))
            with self.assertRaisesRegex(ValueError, "did not originate from NuGet.org"):
                PREPARE_WEB.verify_nuget_package(
                    baseline, receipt, "NetWasm.Toolchain", "1.2.3")


if __name__ == "__main__":
    unittest.main()
