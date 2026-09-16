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
    def test_compiler_host_uses_exact_public_packages_without_project_references(self):
        project = ET.parse(
            ROOT / "spikes/netwasm-worker/CompilerProbe.csproj").getroot()

        self.assertEqual([], project.findall(".//ProjectReference"))
        references = {
            item.attrib["Include"]: item.attrib["Version"]
            for item in project.findall(".//PackageReference")
        }
        self.assertEqual({
            "NetWasm.Compiler.Browser": "[$(NetWasmCompilerPackageVersion)]",
            "NetWasm.Runtime.Pack": "[$(NetWasmCompilerPackageVersion)]",
        }, references)

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
