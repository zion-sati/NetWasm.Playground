#!/usr/bin/env python3
"""Transparent desktop spike wrapper; retain tool arguments and temporary inputs."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main():
    config = json.loads(Path(os.environ["NETWASM_CAPTURE_CONFIG"]).read_text())
    name = os.environ.get("NETWASM_CAPTURE_TOOL", Path(sys.argv[0]).name)
    tool = config["tools"][name]
    destination = Path(config["output"])
    destination.mkdir(parents=True, exist_ok=True)
    invocation = Path(tempfile.mkdtemp(prefix=name + "-", dir=destination))
    arguments = sys.argv[1:]
    inputs = []
    outputs = []
    for index, argument in enumerate(arguments):
        if index and arguments[index - 1] in ("-o", "--output"):
            outputs.append(Path(argument))
            continue
        candidate = Path(argument.removeprefix("@"))
        if candidate.is_file():
            retained = invocation / (str(index) + "-" + candidate.name)
            shutil.copyfile(candidate, retained)
            inputs.append({"argumentIndex": index, "path": str(candidate),
                           "retained": retained.name,
                           "sha256": hashlib.sha256(retained.read_bytes()).hexdigest()})
    result = subprocess.run([tool, *arguments], check=False)
    for index, output in enumerate(outputs):
        if output.is_file():
            shutil.copyfile(output, invocation / ("output-" + str(index) + "-" + output.name))
    (invocation / "invocation.json").write_text(json.dumps({
        "tool": tool, "cwd": os.getcwd(), "arguments": arguments,
        "inputs": inputs, "exitCode": result.returncode,
    }, indent=2) + "\n")
    return result.returncode


if __name__ == "__main__":
    sys.exit(main())
