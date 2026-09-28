#!/usr/bin/env python3
"""Build and verify immutable Playground delivery evidence."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import shutil
import stat
import zipfile


SCRIPT_ROOT = Path(__file__).resolve().parent


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TRAIN = load("playground_release_train", SCRIPT_ROOT / "release-train.py")
COORDINATOR = load(
    "playground_release_coordinator", SCRIPT_ROOT / "release-coordinator.py"
)

CANDIDATE_KINDS = {
    "playground-toolchain-candidate",
    "playground-site-candidate",
}
LIVE_BROWSERS = ("chromium", "firefox", "webkit")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path: Path) -> dict[str, object]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"JSON document is not an object: {path}")
    return value


def write_json(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=True, indent=2) + "\n",
        encoding="utf-8",
    )


def append_outputs(path: Path | None, values: dict[str, object]) -> None:
    if path is None:
        return
    with path.open("a", encoding="utf-8") as stream:
        for name, value in values.items():
            stream.write(f"{name}={value}\n")


def positive_integer(value: str | int, description: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{description} must be a positive integer.") from error
    if isinstance(value, bool) or parsed < 1 or str(parsed) != str(value):
        raise ValueError(f"{description} must be a positive integer.")
    return parsed


def input_context(
    preparation_path: Path, inputs_path: Path, kind: str
) -> tuple[
    dict[str, object], str, dict[str, object], dict[str, object],
    list[dict[str, str]],
]:
    if kind not in TRAIN.DELIVERY_KINDS:
        raise ValueError("Delivery receipt kind is invalid.")
    preparation, digest = TRAIN.read_preparation(preparation_path)
    inputs = read_json(inputs_path)
    stage_name = TRAIN.DELIVERY_KINDS[kind]
    stage = TRAIN.preparation_stage(preparation, stage_name)
    if (
        inputs.get("coordinated_stage") != stage_name
        or inputs.get("preparation_sha256") != digest
        or inputs.get("release_id") != str(stage["releaseId"] or "")
        or inputs.get("release_ref") != stage["ref"]
        or inputs.get("source_commit") != stage["sourceCommit"]
        or inputs.get("infrastructure_commit") != stage["infrastructureCommit"]
        or inputs.get("stage_identity")
        != COORDINATOR.stage_identity(digest, stage_name)
    ):
        raise ValueError("Delivery inputs do not match their preparation.")
    try:
        upstream_value = json.loads(str(inputs["upstream_receipts"]))
    except (KeyError, json.JSONDecodeError) as error:
        raise ValueError("Delivery upstream inputs are invalid.") from error
    expected_stages = stage.get("upstreamStages")
    if not isinstance(upstream_value, list) or not isinstance(expected_stages, list):
        raise ValueError("Delivery upstream inputs are invalid.")
    if [item.get("stage") for item in upstream_value if isinstance(item, dict)] != expected_stages:
        raise ValueError("Delivery upstream inputs are out of order.")
    upstream: list[dict[str, str]] = []
    for item in upstream_value:
        if not isinstance(item, dict) or set(item) != {"stage", "sha256", "fileName"}:
            raise ValueError("Delivery upstream input fields are invalid.")
        stage_value = item.get("stage")
        digest_value = item.get("sha256")
        file_name = item.get("fileName")
        if (
            not isinstance(stage_value, str)
            or not isinstance(digest_value, str)
            or TRAIN.SHA256.fullmatch(digest_value) is None
            or not isinstance(file_name, str)
            or Path(file_name).name != file_name
        ):
            raise ValueError("Delivery upstream input identity is invalid.")
        upstream.append({"stage": stage_value, "sha256": digest_value})
    return preparation, digest, inputs, stage, upstream


def delivery_envelope(
    preparation_path: Path,
    inputs_path: Path,
    kind: str,
    *,
    run_id: int,
    run_attempt: int,
    job_id: int,
    actor_id: int,
) -> tuple[dict[str, object], dict[str, object], str, dict[str, object]]:
    preparation, digest, inputs, stage, upstream = input_context(
        preparation_path, inputs_path, kind
    )
    stage_name = TRAIN.DELIVERY_KINDS[kind]
    anchor_repository, anchor_release_id = TRAIN.stage_state_anchor(
        preparation, stage_name
    )
    dispatch_identity = inputs.get("dispatch_attempt_identity")
    if (
        not isinstance(dispatch_identity, str)
        or TRAIN.SHA256.fullmatch(dispatch_identity) is None
    ):
        raise ValueError("Delivery dispatch identity is invalid.")
    envelope = {
        "schemaVersion": TRAIN.DELIVERY_RECEIPT_SCHEMA_VERSION,
        "kind": kind,
        "stage": stage_name,
        "preparationSha256": digest,
        "stageIdentity": TRAIN.release_stage_identity(digest, stage_name),
        "repository": stage["repository"],
        "sourceCommit": stage["sourceCommit"],
        "infrastructureCommit": stage["infrastructureCommit"],
        "workflowCommit": stage["workflowCommit"],
        "workflowRef": stage["workflowRef"],
        "stateAnchor": {
            "repository": anchor_repository,
            "releaseId": anchor_release_id,
        },
        "upstreamReceipts": upstream,
        "producer": {
            "runId": run_id,
            "runAttempt": run_attempt,
            "jobId": job_id,
            "workflowPath": stage["workflow"],
            "actorId": actor_id,
            "dispatchAttemptIdentity": dispatch_identity,
        },
    }
    return envelope, preparation, digest, inputs


def candidate_receipt(
    *,
    preparation_path: Path,
    inputs_path: Path,
    kind: str,
    archive_path: Path,
    artifact_id: int,
    run_id: int,
    run_attempt: int,
    job_id: int,
    actor_id: int,
    toolchain_index_path: Path,
    site_identity_path: Path | None = None,
    toolchain_receipt_path: Path | None = None,
) -> dict[str, object]:
    if kind not in CANDIDATE_KINDS:
        raise ValueError("Playground candidate kind is invalid.")
    if not archive_path.is_file() or archive_path.stat().st_size < 1:
        raise ValueError("Delivery candidate archive is missing or empty.")
    envelope, preparation, digest, _ = delivery_envelope(
        preparation_path,
        inputs_path,
        kind,
        run_id=run_id,
        run_attempt=run_attempt,
        job_id=job_id,
        actor_id=actor_id,
    )
    toolchain = read_json(toolchain_index_path)
    TRAIN.validate_toolchain_identity(toolchain)
    receipt: dict[str, object] = {
        **envelope,
        "archive": {
            "fileName": archive_path.name,
            "bytes": archive_path.stat().st_size,
            "sha256": sha256(archive_path),
        },
        "artifact": {
            "repository": envelope["repository"],
            "runId": run_id,
            "runAttempt": run_attempt,
            "artifactId": artifact_id,
            "artifactName": TRAIN.delivery_candidate_payload_artifact_name(
                kind, run_id, run_attempt
            ),
        },
        "toolchain": toolchain,
    }
    if kind == "playground-site-candidate":
        if site_identity_path is None or toolchain_receipt_path is None:
            raise ValueError("Playground site candidate dependencies are missing.")
        site_identity = read_json(site_identity_path)
        if site_identity.get("toolchain") != toolchain:
            raise ValueError("Playground site identity uses another toolchain.")
        index_digest = site_identity.get("indexHtmlSha256")
        if not isinstance(index_digest, str) or TRAIN.SHA256.fullmatch(index_digest) is None:
            raise ValueError("Playground site index identity is invalid.")
        toolchain_receipt = read_json(toolchain_receipt_path)
        TRAIN.validate_candidate_receipt(
            toolchain_receipt,
            preparation,
            digest,
            "playground-toolchain-candidate",
        )
        if toolchain_receipt.get("toolchain") != toolchain:
            raise ValueError("Playground site candidate uses another toolchain receipt.")
        receipt.update({
            "toolchainCandidateSha256": sha256(toolchain_receipt_path),
            "site": {
                "identitySha256": sha256(site_identity_path),
                "indexHtmlSha256": index_digest,
            },
        })
    elif site_identity_path is not None or toolchain_receipt_path is not None:
        raise ValueError("Toolchain candidate has unexpected site dependencies.")
    TRAIN.validate_candidate_receipt(receipt, preparation, digest, kind)
    return receipt


def upstream_bytes(
    receipt: dict[str, object], inputs_path: Path, upstream_directory: Path
) -> dict[str, bytes]:
    inputs = read_json(inputs_path)
    try:
        coordinates = json.loads(str(inputs["upstream_receipts"]))
    except (KeyError, json.JSONDecodeError) as error:
        raise ValueError("Delivery upstream inputs are invalid.") from error
    if not isinstance(coordinates, list):
        raise ValueError("Delivery upstream inputs are invalid.")
    result: dict[str, bytes] = {}
    for item in coordinates:
        if not isinstance(item, dict):
            raise ValueError("Delivery upstream input is invalid.")
        name = item.get("fileName")
        stage = item.get("stage")
        digest = item.get("sha256")
        if not isinstance(name, str) or not isinstance(stage, str) or not isinstance(digest, str):
            raise ValueError("Delivery upstream input is invalid.")
        path = upstream_directory / name
        if not path.is_file() or sha256(path) != digest or stage in result:
            raise ValueError("Delivery upstream receipt bytes do not match.")
        result[stage] = path.read_bytes()
    expected = {
        str(item["stage"]): str(item["sha256"])
        for item in receipt.get("upstreamReceipts", [])
        if isinstance(item, dict)
    }
    actual = {
        stage: hashlib.sha256(contents).hexdigest()
        for stage, contents in result.items()
    }
    if expected != actual:
        raise ValueError("Candidate upstream receipts do not match their bytes.")
    return result


def verify_candidate(
    *,
    preparation_path: Path,
    inputs_path: Path,
    receipt_path: Path,
    archive_path: Path,
    kind: str,
    upstream_directory: Path,
    expected_receipt_sha256: str | None = None,
    toolchain_receipt_path: Path | None = None,
) -> dict[str, object]:
    receipt = read_json(receipt_path)
    preparation, digest, _, _, _ = input_context(
        preparation_path, inputs_path, kind
    )
    TRAIN.validate_candidate_receipt(receipt, preparation, digest, kind)
    receipt_digest = sha256(receipt_path)
    if (
        expected_receipt_sha256 is not None
        and receipt_digest != expected_receipt_sha256
    ):
        raise ValueError("Candidate receipt digest does not match retained input.")
    archive = receipt["archive"]
    assert isinstance(archive, dict)
    if (
        archive_path.name != archive.get("fileName")
        or not archive_path.is_file()
        or archive_path.stat().st_size != archive.get("bytes")
        or sha256(archive_path) != archive.get("sha256")
    ):
        raise ValueError("Candidate archive does not match its receipt.")
    upstream_bytes(receipt, inputs_path, upstream_directory)
    if kind == "playground-site-candidate":
        if toolchain_receipt_path is None:
            raise ValueError("Site candidate toolchain receipt is missing.")
        toolchain_receipt = read_json(toolchain_receipt_path)
        TRAIN.validate_candidate_receipt(
            toolchain_receipt,
            preparation,
            digest,
            "playground-toolchain-candidate",
        )
        if (
            sha256(toolchain_receipt_path)
            != receipt.get("toolchainCandidateSha256")
            or toolchain_receipt.get("toolchain") != receipt.get("toolchain")
            or toolchain_receipt.get("upstreamReceipts")
            != receipt.get("upstreamReceipts")
        ):
            raise ValueError("Site candidate does not match its toolchain candidate.")
    elif toolchain_receipt_path is not None:
        raise ValueError("Toolchain candidate has an unexpected dependency.")
    return receipt


def safe_archive_path(name: str) -> PurePosixPath:
    path = PurePosixPath(name)
    if (
        path.is_absolute()
        or any(part in {"", ".", ".."} for part in path.parts)
        or name.endswith("/")
    ):
        raise ValueError(f"Site archive path is unsafe: {name}")
    return path


def pack_directory(source: Path, output: Path) -> None:
    if not source.is_dir():
        raise ValueError("Site source directory does not exist.")
    files = sorted(path for path in source.rglob("*") if path.is_file())
    if not files:
        raise ValueError("Site source directory is empty.")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + ".tmp")
    if temporary.exists():
        temporary.unlink()
    try:
        with zipfile.ZipFile(
            temporary,
            "w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=9,
            strict_timestamps=True,
        ) as archive:
            for path in files:
                if path.is_symlink():
                    raise ValueError(f"Site source contains a symlink: {path}")
                relative = path.relative_to(source).as_posix()
                safe_archive_path(relative)
                info = zipfile.ZipInfo(relative, (1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                info.create_system = 3
                archive.writestr(info, path.read_bytes(), compresslevel=9)
        temporary.replace(output)
    finally:
        if temporary.exists():
            temporary.unlink()


def extract_directory(archive_path: Path, output: Path) -> None:
    if not archive_path.is_file():
        raise ValueError("Site archive does not exist.")
    temporary = output.with_name(output.name + ".tmp")
    if temporary.exists():
        shutil.rmtree(temporary)
    temporary.mkdir(parents=True)
    total = 0
    seen: set[str] = set()
    try:
        with zipfile.ZipFile(archive_path) as archive:
            members = [item for item in archive.infolist() if not item.is_dir()]
            if not members:
                raise ValueError("Site archive is empty.")
            for item in members:
                path = safe_archive_path(item.filename)
                mode = item.external_attr >> 16
                if (
                    item.filename in seen
                    or item.flag_bits & 0x1
                    or stat.S_ISLNK(mode)
                    or item.file_size < 0
                ):
                    raise ValueError("Site archive inventory is invalid.")
                seen.add(item.filename)
                total += item.file_size
                if total > TRAIN.MAX_BUNDLE_CONTENT_BYTES:
                    raise ValueError("Site archive expands beyond its byte limit.")
                destination = temporary.joinpath(*path.parts)
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(item) as source, destination.open("wb") as target:
                    shutil.copyfileobj(source, target, 1024 * 1024)
                if destination.stat().st_size != item.file_size:
                    raise ValueError("Site archive member is truncated.")
        if output.exists():
            shutil.rmtree(output)
        temporary.replace(output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def live_evidence(
    *,
    preparation_path: Path,
    inputs_path: Path,
    deployment_path: Path,
    browser: str,
    run_id: int,
    run_attempt: int,
    job_id: int,
    site_identity_sha256: str,
    toolchain_id: str,
    toolchain_manifest_sha256: str,
) -> dict[str, object]:
    if browser not in LIVE_BROWSERS:
        raise ValueError("Playground live evidence browser is invalid.")
    _, preparation, digest, inputs = delivery_envelope(
        preparation_path,
        inputs_path,
        "playground-completion",
        run_id=run_id,
        run_attempt=run_attempt,
        job_id=job_id,
        actor_id=1,
    )
    del preparation, digest
    deployment = read_json(deployment_path)
    for value, description in (
        (site_identity_sha256, "site identity"),
        (toolchain_id, "toolchain ID"),
        (toolchain_manifest_sha256, "toolchain manifest"),
    ):
        if TRAIN.SHA256.fullmatch(value) is None:
            raise ValueError(f"Playground {description} is invalid.")
    return {
        "schemaVersion": 1,
        "status": "PASS",
        "stage": "playground",
        "repository": TRAIN.preparation_stage(
            TRAIN.read_preparation(preparation_path)[0], "playground"
        )["repository"],
        "runId": run_id,
        "runAttempt": run_attempt,
        "dispatchAttemptIdentity": inputs["dispatch_attempt_identity"],
        "deployment": deployment,
        "jobId": job_id,
        "browser": browser,
        "siteIdentitySha256": site_identity_sha256,
        "toolchainId": toolchain_id,
        "toolchainManifestSha256": toolchain_manifest_sha256,
    }


def completion_receipt(
    *,
    preparation_path: Path,
    inputs_path: Path,
    metadata_path: Path,
    toolchain_receipt_path: Path,
    site_receipt_path: Path,
    run_id: int,
    run_attempt: int,
    actor_id: int,
) -> dict[str, object]:
    metadata = read_json(metadata_path)
    producer_job_id = positive_integer(
        metadata.get("producerJobId"), "Completion producer job ID"
    )
    envelope, preparation, digest, _ = delivery_envelope(
        preparation_path,
        inputs_path,
        "playground-completion",
        run_id=run_id,
        run_attempt=run_attempt,
        job_id=producer_job_id,
        actor_id=actor_id,
    )
    toolchain_receipt = read_json(toolchain_receipt_path)
    site_receipt = read_json(site_receipt_path)
    TRAIN.validate_candidate_receipt(
        toolchain_receipt,
        preparation,
        digest,
        "playground-toolchain-candidate",
    )
    TRAIN.validate_candidate_receipt(
        site_receipt,
        preparation,
        digest,
        "playground-site-candidate",
    )
    if (
        sha256(toolchain_receipt_path)
        != site_receipt.get("toolchainCandidateSha256")
        or toolchain_receipt.get("toolchain") != site_receipt.get("toolchain")
    ):
        raise ValueError("Completion candidates do not match.")
    deployment = metadata.get("deployment")
    live_checks = metadata.get("liveChecks")
    receipt = {
        **envelope,
        "status": "PASS",
        "toolchainCandidateSha256": sha256(toolchain_receipt_path),
        "siteCandidateSha256": sha256(site_receipt_path),
        "deployment": deployment,
        "liveChecks": live_checks,
    }
    TRAIN.validate_completion_receipt(
        receipt, preparation, digest, "playground-completion"
    )
    return receipt


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    candidate = commands.add_parser("candidate")
    candidate.add_argument("--preparation", type=Path, required=True)
    candidate.add_argument("--inputs", type=Path, required=True)
    candidate.add_argument("--kind", choices=sorted(CANDIDATE_KINDS), required=True)
    candidate.add_argument("--archive", type=Path, required=True)
    candidate.add_argument("--artifact-id", required=True)
    candidate.add_argument("--run-id", required=True)
    candidate.add_argument("--run-attempt", required=True)
    candidate.add_argument("--job-id", required=True)
    candidate.add_argument("--actor-id", required=True)
    candidate.add_argument("--toolchain-index", type=Path, required=True)
    candidate.add_argument("--site-identity", type=Path)
    candidate.add_argument("--toolchain-receipt", type=Path)
    candidate.add_argument("--output", type=Path, required=True)
    candidate.add_argument("--github-output", type=Path)

    verify = commands.add_parser("verify-candidate")
    verify.add_argument("--preparation", type=Path, required=True)
    verify.add_argument("--inputs", type=Path, required=True)
    verify.add_argument("--receipt", type=Path, required=True)
    verify.add_argument("--archive", type=Path, required=True)
    verify.add_argument("--kind", choices=sorted(CANDIDATE_KINDS), required=True)
    verify.add_argument("--upstream-directory", type=Path, required=True)
    verify.add_argument("--expected-receipt-sha256")
    verify.add_argument("--toolchain-receipt", type=Path)
    verify.add_argument("--github-output", type=Path)

    pack = commands.add_parser("pack-site")
    pack.add_argument("--source", type=Path, required=True)
    pack.add_argument("--output", type=Path, required=True)

    extract = commands.add_parser("extract-site")
    extract.add_argument("--archive", type=Path, required=True)
    extract.add_argument("--output", type=Path, required=True)

    evidence = commands.add_parser("live-evidence")
    evidence.add_argument("--preparation", type=Path, required=True)
    evidence.add_argument("--inputs", type=Path, required=True)
    evidence.add_argument("--deployment", type=Path, required=True)
    evidence.add_argument("--browser", choices=LIVE_BROWSERS, required=True)
    evidence.add_argument("--run-id", required=True)
    evidence.add_argument("--run-attempt", required=True)
    evidence.add_argument("--job-id", required=True)
    evidence.add_argument("--site-identity-sha256", required=True)
    evidence.add_argument("--toolchain-id", required=True)
    evidence.add_argument("--toolchain-manifest-sha256", required=True)
    evidence.add_argument("--output", type=Path, required=True)

    completion = commands.add_parser("completion")
    completion.add_argument("--preparation", type=Path, required=True)
    completion.add_argument("--inputs", type=Path, required=True)
    completion.add_argument("--metadata", type=Path, required=True)
    completion.add_argument("--toolchain-receipt", type=Path, required=True)
    completion.add_argument("--site-receipt", type=Path, required=True)
    completion.add_argument("--run-id", required=True)
    completion.add_argument("--run-attempt", required=True)
    completion.add_argument("--actor-id", required=True)
    completion.add_argument("--output", type=Path, required=True)
    return root


def main() -> int:
    arguments = parser().parse_args()
    if arguments.command == "candidate":
        receipt = candidate_receipt(
            preparation_path=arguments.preparation,
            inputs_path=arguments.inputs,
            kind=arguments.kind,
            archive_path=arguments.archive,
            artifact_id=positive_integer(arguments.artifact_id, "Artifact ID"),
            run_id=positive_integer(arguments.run_id, "Run ID"),
            run_attempt=positive_integer(arguments.run_attempt, "Run attempt"),
            job_id=positive_integer(arguments.job_id, "Job ID"),
            actor_id=positive_integer(arguments.actor_id, "Actor ID"),
            toolchain_index_path=arguments.toolchain_index,
            site_identity_path=arguments.site_identity,
            toolchain_receipt_path=arguments.toolchain_receipt,
        )
        write_json(arguments.output, receipt)
        append_outputs(arguments.github_output, {
            "receipt_sha256": sha256(arguments.output),
            "archive_name": arguments.archive.name,
            "artifact_name": receipt["artifact"]["artifactName"],
        })
    elif arguments.command == "verify-candidate":
        receipt = verify_candidate(
            preparation_path=arguments.preparation,
            inputs_path=arguments.inputs,
            receipt_path=arguments.receipt,
            archive_path=arguments.archive,
            kind=arguments.kind,
            upstream_directory=arguments.upstream_directory,
            expected_receipt_sha256=arguments.expected_receipt_sha256,
            toolchain_receipt_path=arguments.toolchain_receipt,
        )
        toolchain = receipt["toolchain"]
        assert isinstance(toolchain, dict)
        outputs: dict[str, object] = {
            "receipt_sha256": sha256(arguments.receipt),
            "archive_name": arguments.archive.name,
            "toolchain_id": toolchain["id"],
            "toolchain_manifest_sha256": toolchain["manifestSha256"],
        }
        site = receipt.get("site")
        if isinstance(site, dict):
            outputs.update({
                "site_identity_sha256": site["identitySha256"],
                "index_html_sha256": site["indexHtmlSha256"],
            })
        append_outputs(arguments.github_output, outputs)
    elif arguments.command == "pack-site":
        pack_directory(arguments.source, arguments.output)
    elif arguments.command == "extract-site":
        extract_directory(arguments.archive, arguments.output)
    elif arguments.command == "live-evidence":
        write_json(arguments.output, live_evidence(
            preparation_path=arguments.preparation,
            inputs_path=arguments.inputs,
            deployment_path=arguments.deployment,
            browser=arguments.browser,
            run_id=positive_integer(arguments.run_id, "Run ID"),
            run_attempt=positive_integer(arguments.run_attempt, "Run attempt"),
            job_id=positive_integer(arguments.job_id, "Job ID"),
            site_identity_sha256=arguments.site_identity_sha256,
            toolchain_id=arguments.toolchain_id,
            toolchain_manifest_sha256=arguments.toolchain_manifest_sha256,
        ))
    elif arguments.command == "completion":
        write_json(arguments.output, completion_receipt(
            preparation_path=arguments.preparation,
            inputs_path=arguments.inputs,
            metadata_path=arguments.metadata,
            toolchain_receipt_path=arguments.toolchain_receipt,
            site_receipt_path=arguments.site_receipt,
            run_id=positive_integer(arguments.run_id, "Run ID"),
            run_attempt=positive_integer(arguments.run_attempt, "Run attempt"),
            actor_id=positive_integer(arguments.actor_id, "Actor ID"),
        ))
    else:
        raise AssertionError(arguments.command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
