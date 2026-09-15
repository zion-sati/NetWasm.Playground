#!/usr/bin/env python3
"""Package, run and download actual C# components in browser workers."""
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

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).resolve().parent


def fingerprint(path):
    return {"bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def verify(run):
    receipt = json.loads((run / "receipt.json").read_text())
    for name, expected in receipt["files"].items():
        if fingerprint(run / name) != expected:
            raise ValueError(f"Component receipt mismatch: {name}")
    result = json.loads((run / "browser-test.json").read_text())
    if result.get("passed") is not True:
        raise ValueError("Browser component smoke did not pass")
    native = json.loads((run / "wasmtime-test.json").read_text())
    for index in [0, 1, 3, 4, 5, 7]:
        expected = {"bytes": result["results"][index]["componentBytes"], "sha256": result["results"][index]["componentSha256"]}
        if fingerprint(run / f"component-{index}.wasm") != expected or fingerprint(run / f"download-{index}.wasm") != expected:
            raise ValueError("Executed/downloaded bytes differ")
        if index == 5:
            if native[str(index)]["exitCode"] == 0 or not native[str(index)]["stderr"] or result["results"][index].get("code") != "guest-trap":
                raise ValueError("Wasmtime/browser trap behavior differs")
        elif native[str(index)]["exitCode"] != result["results"][index]["exitCode"] or native[str(index)]["stdout"] != result["results"][index]["stdout"] or (index != 4 and native[str(index)]["stderr"]):
            raise ValueError("Wasmtime/browser output differs")
    print("PASS: actual browser component, guest execution, download and Wasmtime receipts match")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("linked_run", type=Path)
    parser.add_argument("run", type=Path)
    parser.add_argument("--wasmtime", type=Path)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    baseline, linked, run = [path.resolve() for path in [args.baseline, args.linked_run, args.run]]
    if args.verify:
        verify(run); return
    if not args.wasmtime:
        parser.error("a new run requires --wasmtime")
    subprocess.run(["python3", str(ROOT / "eng/desktop-baseline.py"), str(baseline), "--verify"], check=True)
    subprocess.run(["python3", str(ROOT / "spikes/browser-link/run.py"), "unused", "unused", "unused", "unused", str(linked), "--verify"], check=True)
    desktop = json.loads((baseline / "receipt.json").read_text())
    wasmtime = args.wasmtime.absolute()
    version = subprocess.check_output([str(wasmtime), "--version"], text=True).strip()
    if not version.startswith("wasmtime " + desktop["toolchain"]["wasmtime"] + " "):
        raise ValueError("Wasmtime version differs from public toolchain pin")
    if shutil.disk_usage(run.parent).free < 100 * 1024 ** 3:
        raise RuntimeError("At least 100 GiB free required")
    run.mkdir(parents=True, exist_ok=False)
    site = run / "site"
    shutil.copytree(linked / "site", site)
    for name in ["guest-worker.mjs", "component.mjs", "index.html"]:
        shutil.copyfile(SOURCE / name, site / name)
    tools = baseline / "packages/netwasm.toolchain/0.1.0/tools"
    manifest = json.loads((tools / "toolchain-manifest.json").read_text())
    wit = tools / "wit-packages/command.wit.wasm"
    expected = next(asset["sha256"] for asset in manifest["assets"] if asset["relativePath"] == "tools/wit-packages/command.wit.wasm")
    if fingerprint(wit)["sha256"] != expected:
        raise ValueError("Command WIT differs from public manifest")
    shutil.copyfile(wit, site / "command.wit.wasm")
    inputs = json.loads((linked / "inputs.json").read_text())
    inputs["desktopComponent"] = fingerprint(baseline / "app/bin/Release/netwasm0.1/NetWasmApp.wasm")
    inputs["linkedReceipt"] = fingerprint(linked / "receipt.json")
    inputs["commandWit"] = fingerprint(wit)
    inputs["wasmtime"] = {"version": version, **fingerprint(wasmtime)}
    (run / "inputs.json").write_text(json.dumps(inputs, indent=2) + "\n")
    shutil.copyfile(SOURCE / "test.mjs", run / "test.mjs")
    subprocess.run(["npm", "install", "--prefix", str(run), "--no-save", "--package-lock=false", "--ignore-scripts",
        "--no-audit", "--no-fund", "playwright@" + desktop["toolchain"]["playwright"]], check=True)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(site))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    try:
        result = subprocess.run(["node", "test.mjs"], cwd=run,
            env={**os.environ, "BROWSER_COMPONENT_URL": f"http://127.0.0.1:{server.server_port}"}, capture_output=True, text=True)
        (run / "browser.log").write_text(result.stdout + result.stderr); result.check_returncode()
    finally:
        server.shutdown(); server.server_close(); thread.join()
    native = {}
    for index in [0, 1, 3, 4, 5, 7]:
        result = subprocess.run([str(wasmtime), str(run / f"download-{index}.wasm")], capture_output=True, text=True, timeout=30)
        native[str(index)] = {"exitCode": result.returncode, "stdout": result.stdout, "stderr": result.stderr,
            "component": fingerprint(run / f"download-{index}.wasm")}
    (run / "wasmtime-test.json").write_text(json.dumps(native, indent=2) + "\n")
    shutil.copytree(SOURCE, run / "source")
    retained = [path for folder in [site, run / "source"] for path in folder.rglob("*") if path.is_file()]
    retained += [path for path in run.iterdir() if path.is_file() and path.name != "receipt.json"]
    (run / "receipt.json").write_text(json.dumps({"schemaVersion": 1, "files": {
        str(path.relative_to(run)): fingerprint(path) for path in retained}}, indent=2) + "\n")
    verify(run)


if __name__ == "__main__":
    main()
