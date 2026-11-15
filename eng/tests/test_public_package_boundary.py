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
        self.assertIn('rebind_notice_origins(stage, release_pins)', script)
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
                'native-wasm-opt/wasm-opt.js': b'native-tool-script',
                'native-wasm-opt/wasm-opt.wasm': b'native-tool-module',
                'native-wasm-opt/build-receipt.json': b'{}',
                'native-wasm-opt/LICENSE.upstream': b'license',
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
            self.assertTrue((stage / 'native-wasm-opt/wasm-opt.js').exists())
            self.assertFalse((stage / 'native-wasm-opt/wasm-opt.wasm').exists())
            self.assertEqual('tools', assets['native-wasm-opt/wasm-opt.wasm']['bundle'])

            (stage / bundles['compiler']['path']).write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError, 'Staged bundle mismatch'):
                PREPARE_WEB.verify_bundle_layout(stage, manifest)

    def test_nativeaot_candidate_is_pinned(self):
        upstream = json.loads((ROOT / 'eng/upstream-sources.json').read_text())
        candidate = upstream['nativeAotLlvmCandidate']
        self.assertEqual('https://github.com/dotnet/runtimelab', candidate['repository'])
        self.assertRegex(candidate['commit'], r'^[0-9a-f]{40}$')
        self.assertEqual('3.1.56', candidate['emscriptenVersion'])

        project = ET.parse(
            ROOT / 'eng/nativeaot-compiler-host/NativeAotCompilerHost.csproj').getroot()
        constants = project.findtext('.//DefineConstants', default='').split(';')
        self.assertIn('NATIVEAOT_LLVM', constants)
        self.assertNotIn('FRONTEND_CACHE_TRANSPORT', constants)
        packages = {item.attrib['Include']: item.attrib['Version']
                    for item in project.findall('.//PackageReference')}
        self.assertEqual('[$(NativeAotLlvmVersion)]',
                         packages['Microsoft.DotNet.ILCompiler.LLVM'])
        self.assertEqual('[$(NetWasmCompilerPackageVersion)]',
                         packages['NetWasm.Compiler.Browser'])

        builder = (ROOT / 'eng/build-nativeaot-compiler.py').read_text()
        self.assertIn("upstream['nativeAotLlvmCandidate']", builder)
        self.assertIn("candidate['sdkImage']", builder)
        self.assertIn('emcc --version', builder)

    def test_threaded_browser_wasm_opt_is_pinned_as_a_background_bundle_asset(self):
        upstream = json.loads((ROOT / 'eng/upstream-sources.json').read_text())
        candidate = upstream['browserWasmOpt']
        self.assertEqual('https://github.com/zion-sati/NetWasm.NativeTools',
                         candidate['repository'])
        self.assertRegex(candidate['sourceCommit'], r'^[0-9a-f]{40}$')
        self.assertRegex(candidate['sha256'], r'^[0-9a-f]{64}$')
        self.assertEqual(132, int(candidate['binaryenVersion']))
        self.assertIn(candidate['tag'], candidate['url'])
        self.assertIn(candidate['asset'], candidate['url'])
        script = (ROOT / 'eng/rebuild-public-toolchain.py').read_text()
        self.assertIn('add_browser_wasm_opt(stage', script)
        self.assertIn("pins['browserWasmOpt']", script)
        self.assertIn("{'wasm-opt.js', 'wasm-opt.wasm', 'build-receipt.json', 'LICENSE.upstream'}", script)
        self.assertEqual('tools', PREPARE_WEB.bundle_role('native-wasm-opt/wasm-opt.wasm'))
        self.assertIsNone(PREPARE_WEB.bundle_role('native-wasm-opt/wasm-opt.js'))
        self.assertIsNone(PREPARE_WEB.bundle_role('native-wasm-opt/build-receipt.json'))

    def test_candidate_compiler_feed_is_explicit_and_not_the_release_default(self):
        release = (ROOT / ".github/workflows/release.yml").read_text()
        self.assertNotIn("--candidate-feed", release)

        ci = (ROOT / ".github/workflows/ci.yml").read_text()
        self.assertIn("bash eng/qualify-released-toolchain.sh", ci)
        self.assertNotIn("qualify-csharp15-candidate.sh", ci)
        self.assertNotIn("candidate/netwasm", ci)
        qualifier = (ROOT / "eng/qualify-released-toolchain.sh").read_text()
        self.assertIn("eng/build-nativeaot-compiler.py", qualifier)
        self.assertIn("NETWASM_NATIVEAOT_EMSDK", qualifier)
        self.assertIn("eng/rebuild-public-toolchain.py", qualifier)
        self.assertNotIn("--candidate-feed", qualifier)

        rebuilder_help = subprocess.check_output(
            ["python3", str(ROOT / "eng/rebuild-public-toolchain.py"), "--help"],
            text=True)
        self.assertIn("--candidate-feed", rebuilder_help)
        self.assertIn("--candidate-version", rebuilder_help)
        self.assertIn("--candidate-commit", rebuilder_help)
        self.assertIn("--candidate-libraries-version", rebuilder_help)
        self.assertIn("--candidate-fluentvalidation-version", rebuilder_help)
        self.assertIn("--runtime-plan", rebuilder_help)

        incomplete = subprocess.run([
            "python3", str(ROOT / "eng/rebuild-public-toolchain.py"),
            "--compiler-framework", ".", "--candidate-feed", ".",
            "--candidate-version", "0.0.0-ci.1",
        ], text=True, capture_output=True)
        self.assertEqual(2, incomplete.returncode)
        self.assertIn("must be supplied together", incomplete.stderr)
        self.assertNotIn("--candidate-feed", release)

    def test_compiler_framework_inputs_are_owned_by_the_upstream_manifest(self):
        upstream = json.loads((ROOT / "eng/upstream-sources.json").read_text())
        sources = upstream["sources"]
        members = upstream["compilerFramework"]["members"]

        self.assertEqual(
            {"json", "di", "logging"},
            set(members),
        )
        for member in members.values():
            self.assertIn(member["source"], sources)
            self.assertRegex(member["package"], r"^[a-z0-9.-]+$")
            self.assertNotIn("..", Path(member["path"]).parts)
            self.assertRegex(member["sha256"], r"^[0-9a-f]{64}$")

        compiler_builder = (ROOT / "eng/build-nativeaot-compiler.py").read_text()
        self.assertNotIn("PACKAGES =", compiler_builder)
        self.assertIn("upstream['compilerFramework']['members']", compiler_builder)



if __name__ == "__main__":
    unittest.main()
