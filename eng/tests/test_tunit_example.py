import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("tunit_example", ROOT / "eng/tunit-example.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class TUnitRecipeInputsTests(unittest.TestCase):
    def test_core_and_tunit_package_versions_are_independent(self):
        pins = {"sources": {
            "netwasm": {"packageVersion": "0.2.0"},
            "tunit": {"packageVersion": "0.2.1"},
        }}

        recipe = MODULE.make_recipe_inputs(pins, "a" * 40, {})

        self.assertIn("netwasm.runtime.wasm32/0.2.0/", recipe["coreLibImplementation"])
        self.assertIn("netwasm.toolchain/0.2.0/", recipe["compilerWitBinary"])
        self.assertIn("netwasm.toolchain/0.2.0/", recipe["componentWitBinary"])
        self.assertIn("netwasm.tunit/0.2.1/", recipe["generatedProgram"])
        self.assertIn("netwasm.tunit.core/0.2.1/", recipe["trustedGenerator"])
        self.assertEqual({
            "id": "NetWasm.TUnit.Templates",
            "version": "0.2.1",
            "source": MODULE.FEED,
        }, recipe["templatePackage"])

    def test_template_archive_comes_from_exact_public_version(self):
        self.assertEqual(
            "https://api.nuget.org/v3-flatcontainer/netwasm.tunit.templates/0.2.1/"
            "netwasm.tunit.templates.0.2.1.nupkg",
            MODULE.template_package_url("0.2.1"),
        )


if __name__ == "__main__":
    unittest.main()
