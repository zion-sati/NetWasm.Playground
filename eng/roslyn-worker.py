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
    print("PASS: browser fixture hashes and managed output match", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("desktop_baseline", type=Path)
    parser.add_argument("run_directory", type=Path)
    parser.add_argument("--verify", action="store_true")
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
    shutil.copytree(ROOT / "spikes/roslyn-worker", app)
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
    execute(["dotnet", "restore", runtime_option, "--configfile", str(baseline / "NuGet.Config"),
             "-p:DisableImplicitLibraryPacksFolder=true", "-p:DisableImplicitNuGetFallbackFolder=true",
             "-p:RestoreFallbackFolders=", "-p:NuGetAudit=false"], "restore")
    assets = json.loads((app / "obj/project.assets.json").read_text())
    if set(assets["project"]["restore"]["sources"]) != {"https://api.nuget.org/v3/index.json"}:
        raise RuntimeError("Unexpected restore source")
    execute(["dotnet", "publish", runtime_option, "-c", "Debug", "--no-restore", "-o", str(run / "publish")], "publish")
    web = run / "publish/wwwroot"
    for name in ("index.html", "compiler-worker.mjs"):
        shutil.copyfile(app / name, web / name)
    version = receipt["pins"]["sources"]["netwasm"]["packageVersion"]
    reference = baseline / f"packages/netwasm.ref/{version}/ref/NetWasm,Version=v0.1/NetWasm.CoreLib.dll"
    shutil.copyfile(reference, web / "target-reference.dll")
    source = (baseline / "app/Program.cs").read_text()
    generated = baseline / "app/obj/Release/netwasm0.1"
    support = [{"path": str(path.relative_to(baseline / "app")), "text": path.read_text()}
               for path in sorted(generated.glob("*.cs"))]
    (web / "support.json").write_text(json.dumps(support))
    (run / "inputs.json").write_text(json.dumps({
        "source": source, "support": support, "assemblyName": "NetWasmApp",
        "referenceSha256": hashlib.sha256(reference.read_bytes()).hexdigest(),
        "desktopReceiptSha256": hashlib.sha256((baseline / "receipt.json").read_bytes()).hexdigest(),
        "toolchain": receipt["toolchain"], "compilerHost": host}, indent=2))
    execute(["npm", "install", "--no-save", "--package-lock=false",
             "playwright@" + receipt["toolchain"]["playwright"]], "playwright-install", run)
    shutil.copyfile(ROOT / "spikes/roslyn-worker/test-worker.mjs", run / "test-worker.mjs")
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
                *run.glob("*.json"), *run.glob("*.log"), run / "test-worker.mjs",
                *(run / "packages").glob("*/*/*.nupkg")]
    (run / "receipt.json").write_text(json.dumps({"schemaVersion": 1,
        "files": {str(path.relative_to(run)): fingerprint(path)
                  for path in retained if path.is_file()}}, indent=2))
    verify(run)
    print("PASS: browser Roslyn compilation, changed source, diagnostics and recovery", flush=True)


if __name__ == "__main__":
    main()
