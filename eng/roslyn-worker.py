#!/usr/bin/env python3
"""Build and exercise the interpreter-first Roslyn worker against a desktop receipt."""

import argparse
import functools
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parent.parent


def fingerprint(path):
    return {"bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def verify(run):
    receipt = json.loads((run / "receipt.json").read_text())
    for relative, expected in receipt["files"].items():
        if fingerprint(run / relative) != expected:
            raise RuntimeError(f"Browser evidence changed: {relative}")
    result = json.loads((run / "worker-test.json").read_text())
    for index, compilation in enumerate(result["results"]):
        if compilation["success"]:
            pe = fingerprint(run / f"managed-{index}.dll")
            if pe != {"bytes": compilation["bytes"], "sha256": compilation["sha256"]}:
                raise RuntimeError("Managed output does not match browser result")
            if "applicationSha256" in compilation:
                module = fingerprint(run / f"application-{index}.wasm")
                if module != {"bytes": compilation["applicationBytes"],
                              "sha256": compilation["applicationSha256"]}:
                    raise RuntimeError("Application module does not match browser result")
    if "desktopComparison" in receipt:
        comparison = receipt["desktopComparison"]
        first = result["results"][0]
        if first["applicationSha256"] != comparison["applicationSha256"]:
            raise RuntimeError("Browser application differs from desktop fixture")
        if camel_case(first["interopManifest"]) != comparison["interopManifest"]:
            raise RuntimeError("Browser interop manifest differs from desktop fixture")
        if first["staticDataEnd"] != comparison["staticDataEnd"]:
            raise RuntimeError("Browser static data differs from desktop fixture")
        inputs = json.loads((run / "inputs.json").read_text())
        if inputs.get("expectedRuntimePlan"):
            plan = camel_case(first["runtimeLinkPlan"])
            if plan["arguments"] != inputs["expectedRuntimePlan"]["arguments"] or plan["inputs"] != inputs["expectedRuntimePlan"]["inputs"]:
                raise RuntimeError("Browser runtime plan differs from captured desktop linker policy")
    print("PASS: browser fixture hashes and managed output match", flush=True)


def camel_case(value):
    if isinstance(value, dict):
        return {key[0].lower() + key[1:]: camel_case(item) for key, item in value.items()}
    if isinstance(value, list):
        return [camel_case(item) for item in value]
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("desktop_baseline", type=Path)
    parser.add_argument("run_directory", type=Path)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--compiler-source", type=Path,
                        help="Published public NetWasm checkout for the real compiler probe")
    args = parser.parse_args()
    baseline = args.desktop_baseline.resolve()
    run = args.run_directory.resolve()
    if args.verify:
        verify(run)
        return
    subprocess.run(["python3", str(ROOT / "eng/desktop-baseline.py"), str(baseline), "--verify"], check=True)
    receipt = json.loads((baseline / "receipt.json").read_text())
    host = json.loads((ROOT / "eng/browser-host.json").read_text())
    runtime_option = "-p:RuntimeFrameworkVersion=" + host["runtimeFrameworkVersion"]
    run.mkdir(parents=True, exist_ok=False)
    if shutil.disk_usage(run).free < 100 * 1024 ** 3:
        raise RuntimeError("At least 100 GiB free space is required")
    app = run / "app"
    fixture = ROOT / "spikes" / ("netwasm-worker" if args.compiler_source else "roslyn-worker")
    source_options = []
    compiler_pin = None
    if args.compiler_source:
        compiler_source = args.compiler_source.resolve()
        compiler_pin = json.loads((ROOT / "eng/upstream-sources.json").read_text())["sources"]["netwasm"]["browserCompilerCommit"]
        actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=compiler_source, text=True).strip()
        if actual != compiler_pin:
            raise RuntimeError("Compiler source does not match published browser compiler pin")
        if subprocess.check_output(["git", "diff", "HEAD", "--", "src", "eng", "Directory.Build.props"], cwd=compiler_source):
            raise RuntimeError("Compiler source has uncommitted build changes")
        if subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "--",
                                    "src", "eng", "Directory.Build.props"], cwd=compiler_source):
            raise RuntimeError("Compiler source has untracked build inputs")
        source_options = ["-p:BrowserCompilerSource=" + str(compiler_source)]
    shutil.copytree(fixture, app)
    (app / "global.json").write_text(json.dumps({"sdk": {
        "version": receipt["toolchain"]["dotnetSdk"], "rollForward": "disable"}}, indent=2))
    env = dict(os.environ, NUGET_PACKAGES=str(run / "packages"),
               NUGET_HTTP_CACHE_PATH=str(run / "http-cache"))
    commands = []

    def execute(command, name, cwd=app):
        start = time.monotonic()
        result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True)
        (run / (name + ".log")).write_text(result.stdout + result.stderr)
        commands.append({"command": command, "exitCode": result.returncode,
                         "seconds": time.monotonic() - start})
        (run / "commands.json").write_text(json.dumps(commands, indent=2))
        if result.returncode:
            raise RuntimeError(f"{name} failed; inspect {run / (name + '.log')}")

    print("Restoring and publishing the untrimmed interpreter compiler host", flush=True)
    execute(["dotnet", "restore", runtime_option, *source_options, "--configfile", str(baseline / "NuGet.Config"),
             "-p:DisableImplicitLibraryPacksFolder=true", "-p:DisableImplicitNuGetFallbackFolder=true",
             "-p:RestoreFallbackFolders=", "-p:NuGetAudit=false"], "restore")
    assets = json.loads((app / "obj/project.assets.json").read_text())
    if set(assets["project"]["restore"]["sources"]) != {"https://api.nuget.org/v3/index.json"}:
        raise RuntimeError("Unexpected restore source")
    if compiler_pin:
        pending = [app / "obj/project.assets.json"]
        checked = set()
        while pending:
            project = pending.pop().resolve()
            if project in checked:
                continue
            checked.add(project)
            resolved = json.loads(project.read_text())
            snapshots = run / "restore-assets"
            snapshots.mkdir(exist_ok=True)
            shutil.copyfile(project, snapshots / (project.parent.parent.name + ".json"))
            if {Path(folder).resolve() for folder in resolved["packageFolders"]} != {run / "packages"}:
                raise RuntimeError("Compiler restore did not use the isolated package cache")
            restore = resolved["project"]["restore"]
            if set(restore["sources"]) != {"https://api.nuget.org/v3/index.json"} or restore.get("fallbackFolders"):
                raise RuntimeError("Unexpected compiler restore source or fallback folder")
            for framework in restore["frameworks"].values():
                for reference in framework.get("projectReferences", {}):
                    pending.append(Path(reference).parent / "obj/project.assets.json")
        (run / "restore-provenance.json").write_text(json.dumps({
            "projectsChecked": len(checked), "sources": ["https://api.nuget.org/v3/index.json"],
            "fallbackFolders": [], "packageCache": "packages"}, indent=2))
    execute(["dotnet", "publish", runtime_option, *source_options, "-c", "Debug", "--no-restore", "-o", str(run / "publish")], "publish")
    shutil.copyfile(app / "bin/Debug/net10.0/NetWasm.Playground.CompilerProbe.runtimeconfig.json",
                    run / "host-runtimeconfig.json")
    web = run / "publish/wwwroot"
    for name in ("index.html", "compiler-worker.mjs"):
        shutil.copyfile(app / name, web / name)
    version = receipt["pins"]["sources"]["netwasm"]["packageVersion"]
    reference = baseline / f"packages/netwasm.ref/{version}/ref/NetWasm,Version=v0.1/NetWasm.CoreLib.dll"
    shutil.copyfile(reference, web / "target-reference.dll")
    if compiler_pin:
        shutil.copyfile(baseline / f"packages/netwasm.runtime.pack/{version}/runtime/runtime-pack.json",
                        web / "runtime-pack.json")
        shutil.copyfile(baseline / f"packages/netwasm.runtime.wasm32/{version}/runtime/NetWasm.CoreLib.dll",
                        web / "target-implementation.dll")
        tools = baseline / f"packages/netwasm.toolchain/{version}/tools"
        shutil.copyfile(tools / "wit-packages/compiler.wit.wasm", web / "compiler.wit.wasm")
        wit = subprocess.run(["node", str(tools / "wasm-tools/run-wasm-tools.mjs"),
                              str(tools / "wasm-tools/wasm-tools.wasm"), "component", "wit",
                              str(web / "compiler.wit.wasm"), "--json", "--no-docs"],
                             capture_output=True, text=True, check=True)
        (web / "compiler-wit.json").write_text(wit.stdout)
    source = (baseline / "app/Program.cs").read_text()
    generated = baseline / "app/obj/Release/netwasm0.1"
    support = [{"path": str(path.relative_to(baseline / "app")), "text": path.read_text()}
               for path in sorted(generated.glob("*.cs"))]
    (web / "support.json").write_text(json.dumps(support))
    expected_runtime_plan = None
    if compiler_pin:
        captures = sorted((baseline / "captured-tools").glob("wasm-ld-*/invocation.json"))
        if len(captures) != 1:
            raise RuntimeError("Expected one authoritative desktop runtime link capture")
        capture = json.loads(captures[0].read_text())
        arguments = list(capture["arguments"])
        runtime_inputs = []
        for asset in capture["inputs"]:
            relative = asset["path"].split(f"/netwasm.runtime.pack/{version}/runtime/", 1)[1]
            path = "/netwasm-link/runtime/" + relative
            arguments[asset["argumentIndex"]] = path
            runtime_inputs.append({"path": path, "sha256": asset["sha256"]})
        arguments[-1] = "/netwasm-link/runtime.wasm"
        expected_runtime_plan = {"arguments": arguments, "inputs": runtime_inputs}
    (run / "inputs.json").write_text(json.dumps({
        "source": source, "support": support, "assemblyName": "NetWasmApp",
        "referenceSha256": hashlib.sha256(reference.read_bytes()).hexdigest(),
        "desktopReceiptSha256": hashlib.sha256((baseline / "receipt.json").read_bytes()).hexdigest(),
        "toolchain": receipt["toolchain"], "compilerHost": host,
        "browserCompilerCommit": compiler_pin,
        "expectedRuntimePlan": expected_runtime_plan}, indent=2))
    execute(["npm", "install", "--no-save", "--package-lock=false",
             "playwright@" + receipt["toolchain"]["playwright"]], "playwright-install", run)
    shutil.copyfile(fixture / "test-worker.mjs", run / "test-worker.mjs")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(web))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        env["COMPILER_PROBE_URL"] = f"http://127.0.0.1:{server.server_port}"
        print("Testing actual source compilation and recovery in Chromium", flush=True)
        execute(["node", "test-worker.mjs"], "worker-test", run)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    retained = [*web.rglob("*"), *app.glob("*"), *run.glob("managed-*.dll"),
                *run.glob("application-*.wasm"), *run.glob("*.json"), *run.glob("*.log"), run / "test-worker.mjs",
                *(run / "restore-assets").glob("*.json"),
                *(run / "packages").glob("*/*/*.nupkg")]
    evidence = {"schemaVersion": 1,
        "files": {str(path.relative_to(run)): fingerprint(path)
                  for path in retained if path.is_file()}}
    if compiler_pin:
        desktop = baseline / "app/bin/Release/netwasm0.1"
        evidence["desktopComparison"] = {
            "applicationSha256": fingerprint(desktop / "NetWasmApp.core.wasm")["sha256"],
            "interopManifest": json.loads((desktop / "interop.json").read_text()),
            "staticDataEnd": json.loads((desktop / "runtime-layout.json").read_text())["applicationStaticDataEnd"]}
    (run / "receipt.json").write_text(json.dumps(evidence, indent=2))
    verify(run)
    print("PASS: browser Roslyn compilation, changed source, diagnostics and recovery", flush=True)


if __name__ == "__main__":
    main()
