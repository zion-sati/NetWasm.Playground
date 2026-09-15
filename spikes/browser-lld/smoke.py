#!/usr/bin/env python3
"""Run the real browser LLD boundary using verified desktop and build caches."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = Path(__file__).resolve().parent
UPSTREAM_FILES = ["eng/build-browser-lld.py", *[
    "src/NetWasm.Toolchain/Browser/LLD/" + name
    for name in ("CMakeLists.txt", "browser-lld.cpp", "netwasm-lld.mjs", "README.md")]]


def fingerprint(path):
    with path.open("rb") as stream:
        return {"bytes": path.stat().st_size,
                "sha256": hashlib.file_digest(stream, "sha256").hexdigest()}


def read_json(path):
    return json.loads(path.read_text())


def verify(run):
    receipt = read_json(run / "receipt.json")
    for name, expected in receipt["files"].items():
        if fingerprint(run / name) != expected:
            raise RuntimeError(f"Browser evidence changed: {name}")
    build = read_json(run / "build-receipt.json")
    origin = read_json(run / "public-origin.json")
    if fingerprint(run / "upstream-source/eng/toolchain.json")["sha256"] != build["toolchainManifestSha256"]:
        raise RuntimeError("Published toolchain manifest does not match the builder")
    if fingerprint(run / "upstream-source/eng/build-browser-lld.py")["sha256"] != build["builderSha256"]:
        raise RuntimeError("Published builder does not match the built assets")
    for name, expected in build["adapterSources"].items():
        actual = fingerprint(run / "upstream-source/src/NetWasm.Toolchain/Browser/LLD" / name)
        if actual["sha256"] != expected:
            raise RuntimeError(f"Published LLD adapter changed: {name}")
    for name, expected in build["assets"].items():
        if fingerprint(run / "assets" / name) != expected:
            raise RuntimeError(f"Built LLD asset changed: {name}")
    if receipt["browserLinkerCommit"] != origin["commit"]:
        raise RuntimeError("Public source pin changed")
    capture = read_json(run / "desktop-link-capture.json")
    desktop = read_json(run / "desktop-receipt.json")
    capture_relative = receipt["desktopCaptureRelative"]
    if fingerprint(run / "desktop-link-capture.json") != desktop["toolCaptures"][capture_relative]:
        raise RuntimeError("Authoritative desktop link capture changed")
    expected_arguments = list(capture["arguments"])
    expected_native = list(expected_arguments)
    for item in capture["inputs"]:
        expected_arguments[item["argumentIndex"]] = "/netwasm-link/" + item["retained"]
        expected_native[item["argumentIndex"]] = "fixture/" + item["retained"]
    expected_arguments[-1] = "/netwasm-link/runtime.wasm"
    expected_native[-1] = "native/runtime.wasm"
    if read_json(run / "fixture/arguments.json") != expected_arguments or read_json(run / "native-arguments.json") != expected_native:
        raise RuntimeError("Normalized flags differ from the authoritative desktop link capture")
    inputs = read_json(run / "fixture/inputs.json")
    for item in inputs:
        if fingerprint(run / "fixture" / item["filename"]) != {"bytes": item["bytes"], "sha256": item["sha256"]}:
            raise RuntimeError("Selected runtime archive changed")
    result = read_json(run / "browser-test.json")
    native = fingerprint(run / "native/runtime.wasm")
    if native != {"bytes": result["nativeBytes"], "sha256": result["nativeHash"]}:
        raise RuntimeError("Matched native output changed")
    sequence = result["results"]
    if len(sequence) != 4 or [item["success"] for item in sequence] != [True, True, False, True]:
        raise RuntimeError("Browser success/failure/recovery evidence is incomplete")
    if [item["instances"] for item in sequence] != [1, 2, 3, 4]:
        raise RuntimeError("Browser did not create a fresh linker for every invocation")
    for item in [*sequence, result["afterTermination"]]:
        if not item["success"]:
            continue
        output = fingerprint(run / f"browser-runtime-{item['id']}.wasm")
        if output != native or output != {"bytes": item["byteLength"], "sha256": item["sha256"]}:
            raise RuntimeError("Browser/native runtime bytes differ")
    if result["cancellation"] != {"entered": True, "terminated": True, "resultReceived": False}:
        raise RuntimeError("Actual linker entry/cancellation evidence is incomplete")
    if not result["afterTermination"]["success"] or result["errors"]:
        raise RuntimeError("Browser recovery or error checks failed")
    if any(request["method"] != "GET" or request["hasBody"] for request in result["requests"]):
        raise RuntimeError("Browser fixture made an unexpected network write")
    print("PASS: public inputs, actual browser linking, failure/recovery and cancellation evidence verified")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("desktop_baseline", type=Path)
    parser.add_argument("build_cache", type=Path)
    parser.add_argument("run_directory", type=Path)
    parser.add_argument("--public-source", type=Path)
    parser.add_argument("--wasm-ld", type=Path)
    parser.add_argument("--playwright-cache", type=Path,
                        help="Existing verified cache containing node_modules/playwright")
    parser.add_argument("--verify", action="store_true")
    args = parser.parse_args()
    run = args.run_directory.resolve()
    if args.verify:
        verify(run)
        return
    if not all((args.public_source, args.wasm_ld, args.playwright_cache)):
        parser.error("a new run requires --public-source, --wasm-ld and --playwright-cache")
    baseline = args.desktop_baseline.resolve()
    build_cache = args.build_cache.resolve()
    subprocess.run([sys.executable, str(ROOT / "eng/desktop-baseline.py"), str(baseline), "--verify"], check=True)
    desktop = read_json(baseline / "receipt.json")
    pins = read_json(ROOT / "eng/upstream-sources.json")["sources"]["netwasm"]
    if desktop["pins"]["sources"]["netwasm"]["commit"] != pins["commit"]:
        raise RuntimeError("Desktop baseline does not match the released source pin")
    build = read_json(build_cache / "build-receipt.json")
    if build["llvm"] != desktop["toolchain"]["llvmLld"] or build["emscripten"] != desktop["toolchain"]["emscripten"]:
        raise RuntimeError("Browser build and desktop toolchain pins differ")
    node = subprocess.check_output(["node", "--version"], text=True).strip().removeprefix("v")
    if node != desktop["toolchain"]["node"] or build["node"] != node:
        raise RuntimeError("Node does not match the exact public toolchain pin")
    node_modules = args.playwright_cache.resolve() / "node_modules"
    for package in ("playwright", "playwright-core"):
        if read_json(node_modules / package / "package.json")["version"] != desktop["toolchain"]["playwright"]:
            raise RuntimeError("Reused Playwright does not match the exact public pin")
    native_version = subprocess.check_output([str(args.wasm_ld.absolute()), "--version"], text=True).strip()
    if build["llvm"]["commit"] not in native_version or not native_version.startswith("LLD " + build["llvm"]["version"] + " "):
        raise RuntimeError("Native LLD does not match the browser LLVM source pin")
    for name, expected in build["assets"].items():
        if fingerprint(build_cache / "assets" / name) != expected:
            raise RuntimeError(f"Build asset verification failed before staging: {name}")
    llvm_source = read_json(build_cache / "llvm-source.json")
    if llvm_source != build["source"] or llvm_source["commit"] != build["llvm"]["commit"]:
        raise RuntimeError("LLVM public source receipt does not match the browser build")
    if llvm_source["url"] != "https://codeload.github.com/llvm/llvm-project/tar.gz/" + build["llvm"]["commit"]:
        raise RuntimeError("LLVM source origin is not the expected public repository")
    run.mkdir(parents=True, exist_ok=False)
    if shutil.disk_usage(run).free < 100 * 1024 ** 3:
        raise RuntimeError("At least 100 GiB free space is required")
    origin_root = run / "upstream-source"
    source = args.public_source.resolve()
    for name in ["eng/toolchain.json", *UPSTREAM_FILES]:
        committed = subprocess.check_output(["git", "show", f"{pins['browserLinkerCommit']}:{name}"], cwd=source)
        destination = origin_root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(committed)
    manifest_url = pins["repository"].replace("https://github.com/", "https://raw.githubusercontent.com/") + "/" + pins["browserLinkerCommit"] + "/eng/toolchain.json"
    with urllib.request.urlopen(manifest_url, timeout=30) as response:
        published = response.read()
    if published != (origin_root / "eng/toolchain.json").read_bytes():
        raise RuntimeError("Pinned commit is not available with matching bytes from its public origin")
    toolchain = read_json(origin_root / "eng/toolchain.json")
    if toolchain != desktop["toolchain"]:
        raise RuntimeError("Published browser and desktop toolchain manifests differ")
    if fingerprint(origin_root / "eng/toolchain.json")["sha256"] != build["toolchainManifestSha256"]:
        raise RuntimeError("Published manifest does not match the built toolchain")
    if fingerprint(origin_root / "eng/build-browser-lld.py")["sha256"] != build["builderSha256"]:
        raise RuntimeError("Published builder does not match the built assets")
    for name, expected in build["adapterSources"].items():
        if fingerprint(origin_root / "src/NetWasm.Toolchain/Browser/LLD" / name)["sha256"] != expected:
            raise RuntimeError("Built adapter does not match the exact published source")
    (run / "public-origin.json").write_text(json.dumps({"repository": pins["repository"],
        "commit": pins["browserLinkerCommit"], "manifestUrl": manifest_url}, indent=2) + "\n")
    for name in ("build-receipt.json", "llvm-source.json"):
        shutil.copy2(build_cache / name, run / name)
    shutil.copy2(baseline / "receipt.json", run / "desktop-receipt.json")
    for name in ("worker.mjs", "test-browser.mjs", "index.html"):
        shutil.copy2(FIXTURE / name, run / name)
    (run / "sources").mkdir()
    for path in FIXTURE.iterdir():
        if path.is_file():
            shutil.copy2(path, run / "sources" / path.name)
    shutil.copytree(build_cache / "assets", run / "assets")
    (run / "node_modules").symlink_to(node_modules, target_is_directory=True)
    captures = sorted((baseline / "captured-tools").glob("wasm-ld-*/invocation.json"))
    if len(captures) != 1:
        raise RuntimeError("Expected exactly one authoritative desktop LLD capture")
    capture = read_json(captures[0])
    shutil.copy2(captures[0], run / "desktop-link-capture.json")
    if len(capture["inputs"]) != 6:
        raise RuntimeError("Expected the six selected native runtime inputs")
    arguments = list(capture["arguments"])
    native_arguments = list(arguments)
    inputs = []
    (run / "fixture").mkdir()
    for item in capture["inputs"]:
        filename = item["retained"]
        if Path(filename).name != filename or filename in (".", ".."):
            raise RuntimeError("Unsafe captured input filename")
        original = captures[0].parent / filename
        actual = fingerprint(original)
        if actual["sha256"] != item["sha256"] or arguments[item["argumentIndex"]] != item["path"]:
            raise RuntimeError("Captured runtime input hash or argument changed")
        shutil.copy2(original, run / "fixture" / filename)
        path = "/netwasm-link/" + filename
        arguments[item["argumentIndex"]] = path
        native_arguments[item["argumentIndex"]] = "fixture/" + filename
        inputs.append({"argumentIndex": item["argumentIndex"], "path": path, "filename": filename, **actual})
    if arguments[-2] != "-o":
        raise RuntimeError("Unexpected captured output argument")
    arguments[-1] = "/netwasm-link/runtime.wasm"
    native_arguments[-1] = "native/runtime.wasm"
    (run / "fixture/arguments.json").write_text(json.dumps(arguments, indent=2) + "\n")
    (run / "fixture/inputs.json").write_text(json.dumps(inputs, indent=2) + "\n")
    (run / "native-arguments.json").write_text(json.dumps(native_arguments, indent=2) + "\n")
    (run / "native-tool.json").write_text(json.dumps({"version": native_version}, indent=2) + "\n")
    (run / "native").mkdir()
    with (run / "native-link.log").open("w") as output:
        subprocess.run([str(args.wasm_ld.absolute()), *native_arguments], cwd=run,
                       stdout=output, stderr=subprocess.STDOUT, timeout=120, check=True)
    with (run / "browser-run.log").open("w") as output:
        subprocess.run(["node", "test-browser.mjs"], cwd=run,
                       stdout=output, stderr=subprocess.STDOUT, timeout=240, check=True)
    files = {str(path.relative_to(run)): fingerprint(path) for path in sorted(run.rglob("*"))
             if path.is_file() and not path.is_symlink() and "node_modules" not in path.parts}
    (run / "receipt.json").write_text(json.dumps({"schemaVersion": 1,
        "browserLinkerCommit": pins["browserLinkerCommit"],
        "desktopCaptureRelative": str(captures[0].relative_to(baseline)), "files": files,
        "boundary": "actual browser runtime link; complete C# component pipeline remains separate"}, indent=2) + "\n")
    verify(run)


if __name__ == "__main__":
    main()
