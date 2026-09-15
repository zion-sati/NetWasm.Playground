#!/usr/bin/env python3
"""Exercise the preapproved packaged TUnit generators in a Chromium .NET worker."""

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

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).resolve().parent


def fingerprint(path):
    return {"bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def verify(run):
    receipt = json.loads((run / "receipt.json").read_text())
    for relative, expected in receipt["files"].items():
        if fingerprint(run / relative) != expected:
            raise RuntimeError("Generator fixture evidence changed")
    result = json.loads((run / "worker-test.json").read_text())
    if [item["success"] for item in result["results"]] != [True, True, False, False, True]:
        raise RuntimeError("Generator recovery evidence did not pass")
    print("PASS: packaged generator fixture and produced-source hashes verified", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("desktop_baseline", type=Path)
    parser.add_argument("staged_tunit_packages", type=Path)
    parser.add_argument("verified_roslyn_run", type=Path)
    parser.add_argument("run_directory", type=Path)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    baseline = args.desktop_baseline.resolve()
    staged = args.staged_tunit_packages.resolve()
    reusable = args.verified_roslyn_run.resolve()
    run = args.run_directory.resolve()
    if args.verify:
        verify(run)
        return
    run.mkdir(parents=True, exist_ok=True)
    if any(run.iterdir()):
        raise RuntimeError("The generator run directory must be empty")
    if shutil.disk_usage(run).free < 100 * 1024 ** 3:
        raise RuntimeError("At least 100 GiB free space is required")
    package_receipt = json.loads((staged / "packages.json").read_text())
    for name, expected in package_receipt.items():
        if fingerprint(staged / name) != {key: expected[key] for key in ("bytes", "sha256")}:
            raise RuntimeError("Staged public TUnit archive failed verification")
        if expected["url"] != "https://api.nuget.org/v3-flatcontainer/" + name.removesuffix(".0.1.0.nupkg") + "/0.1.0/" + name:
            raise RuntimeError("Unexpected TUnit package origin")
    approved = staged / "netwasm.tunit.core/analyzers/dotnet/roslyn4.14/cs/TUnit.Core.SourceGenerator.dll"
    # Verify the extracted executable against the already verified public archive.
    import zipfile
    with zipfile.ZipFile(staged / "netwasm.tunit.core.0.1.0.nupkg") as archive:
        original = archive.read("analyzers/dotnet/roslyn4.14/cs/TUnit.Core.SourceGenerator.dll")
    if approved.read_bytes() != original:
        raise RuntimeError("Approved generator does not match its public package")
    for package, relative in (
        ("netwasm.tunit.core", "lib/NetWasm,Version=v0.1/TUnit.Core.dll"),
        ("netwasm.tunit.assertions", "lib/NetWasm,Version=v0.1/TUnit.Assertions.dll"),
    ):
        with zipfile.ZipFile(staged / (package + ".0.1.0.nupkg")) as archive:
            original = archive.read(relative)
        if (staged / package / relative).read_bytes() != original:
            raise RuntimeError("Target TUnit metadata does not match its public package")
    desktop = json.loads((baseline / "receipt.json").read_text())
    host = json.loads((ROOT / "eng/browser-host.json").read_text())
    host_option = "-p:RuntimeFrameworkVersion=" + host["runtimeFrameworkVersion"]
    generator_option = "-p:TrustedGeneratorAssembly=" + str(approved)
    app = run / "app"
    shutil.copytree(FIXTURE, app)
    (app / "global.json").write_text(json.dumps({"sdk": {
        "version": desktop["toolchain"]["dotnetSdk"], "rollForward": "disable"}}, indent=2))
    env = dict(os.environ, NUGET_PACKAGES=str(reusable / "packages"),
               NUGET_HTTP_CACHE_PATH=str(run / "http-cache"))
    commands = []

    def execute(command, name, cwd=app):
        started = time.monotonic()
        with (run / (name + ".stdout")).open("w") as stdout, (run / (name + ".stderr")).open("w") as stderr:
            result = subprocess.run(command, cwd=cwd, env=env, stdout=stdout, stderr=stderr)
        commands.append({"command": command, "exitCode": result.returncode,
                         "seconds": time.monotonic() - started})
        (run / "commands.json").write_text(json.dumps(commands, indent=2))
        if result.returncode:
            raise RuntimeError(name + " failed; local logs retain the exact failure")

    execute(["python3", str(ROOT / "eng/desktop-baseline.py"), str(baseline), "--verify"],
            "baseline-verify", ROOT)
    execute(["python3", str(ROOT / "eng/roslyn-worker.py"), str(baseline), str(reusable), "--verify"],
            "roslyn-verify", ROOT)
    execute(["dotnet", "restore", host_option, generator_option, "--configfile", str(baseline / "NuGet.Config"),
             "-p:DisableImplicitLibraryPacksFolder=true", "-p:DisableImplicitNuGetFallbackFolder=true",
             "-p:RestoreFallbackFolders="], "restore")
    assets = json.loads((app / "obj/project.assets.json").read_text())
    if set(assets["project"]["restore"]["sources"]) != {"https://api.nuget.org/v3/index.json"} or assets["project"]["restore"].get("fallbackFolders"):
        raise RuntimeError("Unexpected restore source or fallback folder")
    if {Path(path).resolve() for path in assets["packageFolders"]} != {reusable / "packages"}:
        raise RuntimeError("Unexpected host package cache")
    execute(["dotnet", "publish", host_option, generator_option, "-c", "Debug", "--no-restore", "-o", str(run / "publish")], "publish")
    web = run / "publish/wwwroot"
    for name in ("index.html", "generator-worker.mjs"):
        shutil.copyfile(app / name, web / name)
    reference_inputs = {
        "NetWasm.CoreLib.dll": baseline / "packages/netwasm.ref/0.1.0/ref/NetWasm,Version=v0.1/NetWasm.CoreLib.dll",
        "TUnit.Core.dll": staged / "netwasm.tunit.core/lib/NetWasm,Version=v0.1/TUnit.Core.dll",
        "TUnit.Assertions.dll": staged / "netwasm.tunit.assertions/lib/NetWasm,Version=v0.1/TUnit.Assertions.dll",
    }
    for name, path in reference_inputs.items():
        shutil.copyfile(path, web / name)
    (web / "assets.json").write_text(json.dumps({"schemaVersion": 1,
        "references": list(reference_inputs),
        "files": {str(path.relative_to(web)): fingerprint(path)
                  for path in sorted(web.rglob("*")) if path.is_file()}}, indent=2))
    source = """using System.Threading.Tasks;
using TUnit.Assertions;
using TUnit.Core;
namespace GeneratorProbe;
public sealed class Tests
{
    [Test]
    public async Task AnswerIsFortyTwo()
    {
        await Assert.That(6 * 7).IsEqualTo(42);
    }
}
"""
    (run / "inputs.json").write_text(json.dumps({"source": source, "compilerHost": host,
        "toolchain": desktop["toolchain"], "generator": fingerprint(approved),
        "generatorPackage": package_receipt["netwasm.tunit.core.0.1.0.nupkg"],
        "publicInputVerification": {"desktopReceipt": True, "roslynReceipt": True,
                                    "extractedGenerator": True, "extractedTargetMetadata": True},
        "references": {name: fingerprint(path) for name, path in reference_inputs.items()},
        "desktopReceiptSha256": fingerprint(baseline / "receipt.json")["sha256"]}, indent=2))
    (run / "node_modules").symlink_to(reusable / "node_modules", target_is_directory=True)
    shutil.copyfile(FIXTURE / "test-worker.mjs", run / "test-worker.mjs")
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(web))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        env["GENERATOR_PROBE_URL"] = f"http://127.0.0.1:{server.server_port}"
        execute(["node", "test-worker.mjs"], "worker-test", run)
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
    shutil.copyfile(app / "obj/project.assets.json", run / "host-project.assets.json")
    shutil.copyfile(app / "bin/Debug/net10.0/NetWasm.Playground.GeneratorProbe.runtimeconfig.json",
                    run / "host-runtimeconfig.json")
    retained = [*web.rglob("*"), *app.glob("*"), *run.glob("managed-*.dll"),
                *run.glob("generated-*/*.g.cs"), *run.glob("*.json"),
                *run.glob("*.stdout"), *run.glob("*.stderr"), run / "test-worker.mjs"]
    (run / "receipt.json").write_text(json.dumps({"schemaVersion": 1,
        "files": {str(path.relative_to(run)): fingerprint(path) for path in retained if path.is_file()}}, indent=2))
    shutil.rmtree(app / "bin")
    shutil.rmtree(app / "obj")
    verify(run)


if __name__ == "__main__":
    main()
