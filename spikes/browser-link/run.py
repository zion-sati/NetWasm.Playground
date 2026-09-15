#!/usr/bin/env python3
"""Exercise browser linking using verified compiler, tool and LLD asset receipts."""
import argparse
import functools
import hashlib
import http.server
import json
from pathlib import Path
import shutil
import subprocess
import threading

ROOT = Path(__file__).resolve().parents[2]
SOURCE = Path(__file__).resolve().parent


def fingerprint(path):
    return {"bytes": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def executable_sections(path):
    """Compare validated core binaries while excluding packaging metadata."""
    module = path.read_bytes()
    if module[:8] != b"\0asm\x01\0\0\0":
        raise ValueError("Expected a core WebAssembly module")
    offset = 8
    executable = bytearray(module[:8])
    while offset < len(module):
        start = offset
        section_id = module[offset]
        offset += 1
        size = shift = 0
        while True:
            value = module[offset]
            offset += 1
            size |= (value & 127) << shift
            if not value & 128:
                break
            shift += 7
            if shift >= 35:
                raise ValueError("Invalid section length")
        offset += size
        if offset > len(module):
            raise ValueError("Truncated core module")
        if section_id:
            executable.extend(module[start:offset])
    return {"bytes": len(executable), "sha256": hashlib.sha256(executable).hexdigest()}


def verify(run):
    receipt = json.loads((run / "receipt.json").read_text())
    for name, expected in receipt["files"].items():
        if fingerprint(run / name) != expected:
            raise ValueError(f"Browser link receipt mismatch: {name}")
    results = json.loads((run / "browser-test.json").read_text())
    if results.get("passed") is not True:
        raise ValueError("Browser link smoke did not pass")
    for index, result in enumerate(results["results"]):
        if result.get("success"):
            if fingerprint(run / f"linked-{index}.wasm") != {"bytes": result["linkedBytes"], "sha256": result["linkedSha256"]}:
                raise ValueError("Browser linked output differs from result")
    comparison = json.loads((run / "inputs.json").read_text()).get("desktopExecutableSections")
    if comparison and executable_sections(run / "linked-0.wasm") != comparison:
        raise ValueError("Browser executable sections differ from verified desktop Hello")
    print("PASS: browser link source, asset and output receipts match")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("compiler", type=Path)
    parser.add_argument("tools", type=Path)
    parser.add_argument("lld", type=Path)
    parser.add_argument("run", type=Path)
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    baseline, compiler, tools, lld, run = [path.resolve() for path in [args.baseline, args.compiler, args.tools, args.lld, args.run]]
    if args.verify:
        verify(run)
        return
    subprocess.run(["python3", str(ROOT / "eng/desktop-baseline.py"), str(baseline), "--verify"], check=True)
    subprocess.run(["python3", str(ROOT / "eng/roslyn-worker.py"), str(baseline), str(compiler), "--verify"], check=True)
    subprocess.run(["python3", str(ROOT / "spikes/browser-tools/verify.py"), str(tools)], check=True)
    build = json.loads((lld / "build-receipt.json").read_text())
    pins = json.loads((baseline / "receipt.json").read_text())["toolchain"]
    if build["llvm"] != pins["llvmLld"] or build["emscripten"] != pins["emscripten"] or build["node"] != pins["node"]:
        raise ValueError("LLD build pins differ from the toolchain")
    for name, expected in build["assets"].items():
        if fingerprint(lld / "assets" / name) != expected:
            raise ValueError(f"LLD asset mismatch: {name}")
    if shutil.disk_usage(run.parent).free < 100 * 1024 ** 3:
        raise RuntimeError("At least 100 GiB free space required")
    run.mkdir(parents=True, exist_ok=False)
    site = run / "site"
    shutil.copytree(compiler / "publish/wwwroot", site)
    shutil.copytree(tools / "site", site / "tools")
    shutil.copytree(lld / "assets", site / "lld")
    runtime = baseline / "packages/netwasm.runtime.pack/0.1.0/runtime"
    manifest = json.loads((runtime / "runtime-pack.json").read_text())
    target = next(target for target in manifest["targets"] if target["target"] == "wasm32")
    for asset in [target["runtimeArchive"], *target["linkInputs"]]:
        source = runtime / asset["path"]
        if fingerprint(source)["sha256"] != asset["sha256"]:
            raise ValueError("Public runtime archive hash mismatch")
        destination = site / "runtime" / asset["path"]
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    for name in ["index.html", "pipeline.mjs", "lld-worker.mjs"]:
        shutil.copyfile(SOURCE / name, site / name)
    shutil.copyfile(SOURCE / "test.mjs", run / "test.mjs")
    inputs = json.loads((compiler / "inputs.json").read_text())
    inputs["origins"] = {name: fingerprint(path / "receipt.json") if name != "lld" else fingerprint(path / "build-receipt.json")
                         for name, path in [("baseline", baseline), ("compiler", compiler), ("tools", tools), ("lld", lld)]}
    desktop_core = baseline / "app/bin/Release/netwasm0.1/NetWasmApp.netwasm/NetWasmApp-component.core.wasm"
    inputs["desktopExecutableSections"] = executable_sections(desktop_core)
    (run / "inputs.json").write_text(json.dumps(inputs, indent=2) + "\n")
    subprocess.run(["npm", "install", "--prefix", str(run), "--no-save", "--package-lock=false", "--ignore-scripts",
                    "--no-audit", "--no-fund", "playwright@" + pins["playwright"]], check=True)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(site))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    import os
    try:
        result = subprocess.run(["node", "test.mjs"], cwd=run,
            env={**os.environ, "BROWSER_LINK_URL": f"http://127.0.0.1:{server.server_port}"}, capture_output=True, text=True)
        (run / "browser.log").write_text(result.stdout + result.stderr)
        result.check_returncode()
    finally:
        server.shutdown(); server.server_close(); thread.join()
    sources = run / "source"
    shutil.copytree(SOURCE, sources)
    retained = [path for folder in [site, sources] for path in folder.rglob("*") if path.is_file()]
    retained += [path for path in run.iterdir() if path.is_file() and path.name != "receipt.json"]
    (run / "receipt.json").write_text(json.dumps({"schemaVersion": 1, "files": {
        str(path.relative_to(run)): fingerprint(path) for path in retained}}, indent=2) + "\n")
    verify(run)


if __name__ == "__main__":
    main()
