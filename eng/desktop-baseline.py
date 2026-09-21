#!/usr/bin/env python3
"""Capture a published-package Hello World baseline in a fresh isolated run."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def fetch(url, destination):
    with urllib.request.urlopen(url) as response:
        destination.write_bytes(response.read())


def fingerprint(path):
    return {"bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def verify(run):
    receipt = json.loads((run / "receipt.json").read_text())
    for section in ("packages", "artifacts", "toolCaptures"):
        for relative, expected in receipt[section].items():
            if fingerprint(run / relative) != expected:
                raise RuntimeError(f"Baseline evidence changed: {relative}")
    if fingerprint(run / "publish/NetWasmApp.wasm") != receipt["component"]:
        raise RuntimeError("The downloadable component changed")
    print("PASS: baseline receipt and retained files match")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run_directory", type=Path)
    parser.add_argument("--wasm-ld", type=Path)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    run = args.run_directory.resolve()
    if args.verify:
        verify(run)
        return
    if args.wasm_ld is None:
        parser.error("--wasm-ld is required for a new capture")
    run.mkdir(parents=True, exist_ok=False)
    if shutil.disk_usage(run).free < 100 * 1024 ** 3:
        raise RuntimeError("The run requires at least 100 GiB free space")
    pins = json.loads((ROOT / "eng/upstream-sources.json").read_text())
    core = pins["sources"]["netwasm"]
    fetch(f"https://raw.githubusercontent.com/zion-sati/NetWasm/{core['commit']}/eng/toolchain.json",
          run / "toolchain.json")
    toolchain = json.loads((run / "toolchain.json").read_text())
    version = core["packageVersion"]
    fetch(f"https://api.nuget.org/v3-flatcontainer/netwasm.templates/{version}/netwasm.templates.{version}.nupkg",
          run / "templates.nupkg")
    app = run / "app"
    app.mkdir()
    with zipfile.ZipFile(run / "templates.nupkg") as archive:
        for name in ("NetWasmApp.csproj", "Program.cs", "global.json"):
            (app / name).write_bytes(archive.read("content/NetWasm.App/" + name))
    settings = json.loads((app / "global.json").read_text())
    settings["sdk"] = {"version": toolchain["dotnetSdk"], "rollForward": "disable",
                       "allowPrerelease": False}
    (app / "global.json").write_text(json.dumps(settings, indent=2) + "\n")
    (run / "NuGet.Config").write_text(
        '<configuration><packageSources><clear/><add key="nuget.org" '
        'value="https://api.nuget.org/v3/index.json"/></packageSources>'
        '<fallbackPackageFolders><clear/></fallbackPackageFolders></configuration>\n')
    env = dict(os.environ, NUGET_PACKAGES=str(run / "packages"),
               NUGET_HTTP_CACHE_PATH=str(run / "http-cache"),
               NETWASM_CAPTURE_CONFIG=str(run / "capture-config.json"))
    commands = []

    def execute(command, name, cwd=app):
        start = time.monotonic()
        result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True)
        (run / (name + ".log")).write_text(result.stdout + result.stderr)
        commands.append({"arguments": command, "cwd": str(cwd),
                         "exitCode": result.returncode,
                         "seconds": time.monotonic() - start})
        (run / "commands.json").write_text(json.dumps(commands, indent=2) + "\n")
        if result.returncode:
            raise RuntimeError(f"{name} failed; inspect {run / (name + '.log')}")
        return result.stdout.strip()

    identities = {"dotnet": execute(["dotnet", "--version"], "dotnet-version"),
                  "lld": execute([str(args.wasm_ld.absolute()), "--version"], "lld-version"),
                  "wasmtime": execute(["wasmtime", "--version"], "wasmtime-version")}
    if toolchain["llvmLld"]["commit"] not in identities["lld"]:
        raise RuntimeError("LLD does not match the pinned source commit")
    if identities["dotnet"] != toolchain["dotnetSdk"]:
        raise RuntimeError("The selected SDK does not match the pin")
    if not identities["wasmtime"].startswith("wasmtime " + toolchain["wasmtime"] + " "):
        raise RuntimeError("Wasmtime does not match the pin")
    print("Restoring published packages", flush=True)
    execute(["dotnet", "restore", "--configfile", str(run / "NuGet.Config"),
             "-p:RestoreFallbackFolders=", "-p:RestoreAdditionalProjectSources=",
             "-p:RestoreAdditionalProjectFallbackFolders=", "-p:DisableImplicitLibraryPacksFolder=true",
             "-p:DisableImplicitNuGetFallbackFolder=true", "-p:NuGetAudit=false"], "restore")
    assets = json.loads((app / "obj/project.assets.json").read_text())
    if set(assets["project"]["restore"]["sources"]) != {"https://api.nuget.org/v3/index.json"}:
        raise RuntimeError("Restore used an unexpected source")
    if {str(Path(folder).resolve()) for folder in assets["packageFolders"]} != {str(run / "packages")}:
        raise RuntimeError("Restore used an unexpected package folder")
    host_tool_bins = list((run / "packages").glob(f"netwasm.hosttools.*/{version}/tools/bin"))
    if len(host_tool_bins) != 1:
        raise RuntimeError("Expected one restored native host-tools package")
    tools = {"wasm-ld": str(args.wasm_ld.absolute()),
             "wasm-merge": str(host_tool_bins[0] / "wasm-merge"),
             "wasm-opt": str(host_tool_bins[0] / "wasm-opt")}
    wrappers = run / "wrappers"
    wrappers.mkdir()
    (run / "capture-config.json").write_text(json.dumps({
        "tools": tools, "output": str(run / "captured-tools"), "python": sys.executable,
        "pythonAdapter": str(ROOT / "eng/capture-tool.py")}, indent=2))
    (wrappers / "wasm-ld").symlink_to(ROOT / "eng/capture-tool.py")
    for name in ("wasm-merge", "wasm-opt"):
        (wrappers / name).symlink_to(ROOT / "eng/capture-tool.py")
    properties = {"NetWasmWasmLdPath": "wasm-ld",
                  "NetWasmNativeBinaryenWasmMergePath": "wasm-merge",
                  "NetWasmNativeBinaryenWasmOptPath": "wasm-opt"}
    (run / "capture.targets").write_text(
        '<Project><Target Name="CaptureDesktopToolBoundaries" '
        'AfterTargets="NetWasmSdkResolveBuildEnvironment"><PropertyGroup>' +
        ''.join(f'<{key}>{wrappers / value}</{key}>' for key, value in properties.items()) +
        '</PropertyGroup></Target></Project>')
    print("Publishing and capturing real tool boundaries", flush=True)
    execute(["dotnet", "publish", "-c", "Release", "--no-restore", "-o", str(run / "publish"),
             "-p:CustomAfterMicrosoftCommonTargets=" + str(run / "capture.targets"), "-v:diag"], "publish")
    component = run / "publish/NetWasmApp.wasm"
    output = execute(["wasmtime", "run", str(component)], "wasmtime-run")
    if output != "42":
        raise RuntimeError("The real component did not print 42")
    invocations = [json.loads(path.read_text()) for path in (run / "captured-tools").glob("*/invocation.json")]
    for name in ("wasm-ld", "wasm-opt"):
        if not any(Path(item["tool"]).name == name and item["inputs"] and item["exitCode"] == 0
                   for item in invocations):
            raise RuntimeError(f"Missing successful {name} boundary")
    receipt = {"schemaVersion": 1, "pins": pins, "toolchain": toolchain,
               "identities": identities, "stdout": output, "component": fingerprint(component),
               "packages": {str(path.relative_to(run)): fingerprint(path)
                            for path in (run / "packages").glob("*/*/*.nupkg")},
               "toolCaptures": {str(path.relative_to(run)): fingerprint(path)
                                for path in (run / "captured-tools").rglob("*") if path.is_file()},
               "artifacts": {str(path.relative_to(run)): fingerprint(path)
                             for path in app.rglob("*") if path.is_file()
                             and path.suffix in (".dll", ".wasm", ".json", ".cs", ".csproj")}}
    (run / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    verify(run)
    print(f"PASS: stdout={output}, component={component.stat().st_size} bytes", flush=True)


if __name__ == "__main__":
    main()
