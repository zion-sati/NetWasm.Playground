#!/usr/bin/env python3
"""Resolve exact GitHub Actions jobs, deployments and evidence artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re


COMMIT = re.compile(r"[0-9a-f]{40}")
SHA256 = re.compile(r"[0-9a-f]{64}")
LIVE_BROWSERS = ("chromium", "firefox", "webkit")


def read_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=True, indent=2) + "\n",
        encoding="utf-8",
    )


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def positive_integer(value: object, description: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise ValueError(f"{description} must be a positive integer.")
    return value


def job_rows(document: object) -> list[dict[str, object]]:
    if not isinstance(document, dict):
        raise ValueError("Actions jobs document is invalid.")
    jobs = document.get("jobs")
    if not isinstance(jobs, list) or any(not isinstance(item, dict) for item in jobs):
        raise ValueError("Actions jobs document is invalid.")
    return jobs


def resolve_job(
    jobs_path: Path,
    *,
    name: str,
    run_id: int,
    run_attempt: int,
    head_sha: str,
    require_success: bool,
) -> dict[str, object]:
    jobs = job_rows(read_json(jobs_path))
    matches = [item for item in jobs if item.get("name") == name]
    if len(matches) != 1:
        raise ValueError(f"Actions job name is missing or ambiguous: {name}")
    job = matches[0]
    positive_integer(job.get("id"), "Actions job ID")
    if (
        job.get("run_id") != run_id
        or job.get("run_attempt") != run_attempt
        or job.get("head_sha") != head_sha
    ):
        raise ValueError(f"Actions job identity is invalid: {name}")
    if require_success:
        if job.get("status") != "completed" or job.get("conclusion") != "success":
            raise ValueError(f"Actions job did not succeed: {name}")
    elif job.get("status") not in {"queued", "in_progress", "completed"}:
        raise ValueError(f"Actions job status is invalid: {name}")
    return job


def normalize_url(value: str) -> str:
    return value if value.endswith("/") else value + "/"


def deployment_record(
    *,
    jobs_path: Path,
    deployments_path: Path,
    statuses_directory: Path,
    repository: str,
    run_id: int,
    run_attempt: int,
    job_name: str,
    head_sha: str,
    workflow_ref: str,
    actor_id: int,
    expected_url: str,
) -> dict[str, object]:
    job = resolve_job(
        jobs_path,
        name=job_name,
        run_id=run_id,
        run_attempt=run_attempt,
        head_sha=head_sha,
        require_success=False,
    )
    job_id = positive_integer(job.get("id"), "Deployment job ID")
    deployments = read_json(deployments_path)
    if not isinstance(deployments, list) or any(
        not isinstance(item, dict) for item in deployments
    ):
        raise ValueError("GitHub deployments document is invalid.")
    log_url = f"https://github.com/{repository}/actions/runs/{run_id}/job/{job_id}"
    expected_url = normalize_url(expected_url)
    matches: list[dict[str, object]] = []
    for deployment in deployments:
        creator = deployment.get("creator")
        deployment_id = deployment.get("id")
        if (
            not isinstance(deployment_id, int)
            or isinstance(deployment_id, bool)
            or deployment_id < 1
            or deployment.get("sha") != head_sha
            or deployment.get("ref") != workflow_ref
            or deployment.get("task") != "deploy"
            or deployment.get("environment") != "github-pages"
            or not isinstance(creator, dict)
            or creator.get("id") != actor_id
        ):
            continue
        statuses_path = statuses_directory / f"{deployment_id}.json"
        if not statuses_path.is_file():
            continue
        statuses = read_json(statuses_path)
        if not isinstance(statuses, list) or any(
            not isinstance(item, dict) for item in statuses
        ):
            raise ValueError("GitHub deployment statuses are invalid.")
        success = [
            item for item in statuses
            if item.get("state") == "success"
            and item.get("environment") == "github-pages"
            and normalize_url(str(item.get("environment_url", ""))) == expected_url
            and item.get("log_url") == log_url
            and isinstance(item.get("creator"), dict)
            and item["creator"].get("id") == actor_id
        ]
        if len(success) == 1:
            matches.append(deployment)
    if len(matches) != 1:
        raise ValueError("GitHub Pages deployment is missing or ambiguous.")
    return {
        "id": matches[0]["id"],
        "environment": "github-pages",
        "url": expected_url,
        "runId": run_id,
        "runAttempt": run_attempt,
        "jobId": job_id,
    }


def artifact_rows(document: object) -> list[dict[str, object]]:
    if not isinstance(document, dict):
        raise ValueError("Actions artifacts document is invalid.")
    artifacts = document.get("artifacts")
    if not isinstance(artifacts, list) or any(
        not isinstance(item, dict) for item in artifacts
    ):
        raise ValueError("Actions artifacts document is invalid.")
    return artifacts


def evidence_artifact_name(
    browser: str, run_id: int, run_attempt: int, job_id: int
) -> str:
    if browser not in LIVE_BROWSERS:
        raise ValueError("Delivery evidence browser is invalid.")
    return f"delivery-evidence-playground-{browser}-{run_id}-{run_attempt}-{job_id}"


def completion_metadata(
    *,
    jobs_path: Path,
    artifacts_path: Path,
    evidence_directory: Path,
    deployment_path: Path,
    repository: str,
    run_id: int,
    run_attempt: int,
    producer_job_name: str,
    live_job_prefix: str,
    head_sha: str,
    dispatch_attempt_identity: str,
    site_identity_sha256: str,
    toolchain_id: str,
    toolchain_manifest_sha256: str,
) -> dict[str, object]:
    if COMMIT.fullmatch(head_sha) is None or any(
        SHA256.fullmatch(value) is None
        for value in (
            dispatch_attempt_identity,
            site_identity_sha256,
            toolchain_id,
            toolchain_manifest_sha256,
        )
    ):
        raise ValueError("Completion identity digest is invalid.")
    producer = resolve_job(
        jobs_path,
        name=producer_job_name,
        run_id=run_id,
        run_attempt=run_attempt,
        head_sha=head_sha,
        require_success=False,
    )
    producer_id = positive_integer(producer.get("id"), "Completion producer job ID")
    deployment = read_json(deployment_path)
    if not isinstance(deployment, dict):
        raise ValueError("Completion deployment is invalid.")
    artifacts = artifact_rows(read_json(artifacts_path))
    checks = []
    for browser in LIVE_BROWSERS:
        job = resolve_job(
            jobs_path,
            name=f"{live_job_prefix} ({browser})",
            run_id=run_id,
            run_attempt=run_attempt,
            head_sha=head_sha,
            require_success=True,
        )
        job_id = positive_integer(job.get("id"), "Live browser job ID")
        artifact_name = evidence_artifact_name(
            browser, run_id, run_attempt, job_id
        )
        matches = [item for item in artifacts if item.get("name") == artifact_name]
        if len(matches) != 1:
            raise ValueError(f"Live evidence artifact is missing: {browser}")
        artifact = matches[0]
        artifact_id = positive_integer(
            artifact.get("id"), "Live evidence artifact ID"
        )
        workflow_run = artifact.get("workflow_run")
        if (
            artifact.get("expired") is not False
            or not isinstance(workflow_run, dict)
            or workflow_run.get("id") != run_id
            or workflow_run.get("head_sha") != head_sha
        ):
            raise ValueError(f"Live evidence artifact identity is invalid: {browser}")
        evidence_path = evidence_directory / browser / "delivery-evidence.json"
        evidence = read_json(evidence_path)
        expected = {
            "schemaVersion": 1,
            "status": "PASS",
            "stage": "playground",
            "repository": repository,
            "runId": run_id,
            "runAttempt": run_attempt,
            "dispatchAttemptIdentity": dispatch_attempt_identity,
            "deployment": deployment,
            "jobId": job_id,
            "browser": browser,
            "siteIdentitySha256": site_identity_sha256,
            "toolchainId": toolchain_id,
            "toolchainManifestSha256": toolchain_manifest_sha256,
        }
        if evidence != expected:
            raise ValueError(f"Live evidence body does not match: {browser}")
        checks.append({
            "browser": browser,
            "status": "PASS",
            "jobId": job_id,
            "siteIdentitySha256": site_identity_sha256,
            "toolchainId": toolchain_id,
            "toolchainManifestSha256": toolchain_manifest_sha256,
            "evidence": {
                "artifactId": artifact_id,
                "artifactName": artifact_name,
                "fileName": "delivery-evidence.json",
                "sha256": sha256(evidence_path),
            },
        })
    if len({producer_id, int(deployment["jobId"]), *(c["jobId"] for c in checks)}) != 5:
        raise ValueError("Delivery workflow job identities are duplicated.")
    return {
        "producerJobId": producer_id,
        "deployment": deployment,
        "liveChecks": checks,
    }


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)

    job = commands.add_parser("job-id")
    job.add_argument("--jobs", type=Path, required=True)
    job.add_argument("--name", required=True)
    job.add_argument("--run-id", type=int, required=True)
    job.add_argument("--run-attempt", type=int, required=True)
    job.add_argument("--head-sha", required=True)
    job.add_argument("--github-output", type=Path)

    deployment = commands.add_parser("deployment")
    deployment.add_argument("--jobs", type=Path, required=True)
    deployment.add_argument("--deployments", type=Path, required=True)
    deployment.add_argument("--statuses-directory", type=Path, required=True)
    deployment.add_argument("--repository", required=True)
    deployment.add_argument("--run-id", type=int, required=True)
    deployment.add_argument("--run-attempt", type=int, required=True)
    deployment.add_argument("--job-name", required=True)
    deployment.add_argument("--head-sha", required=True)
    deployment.add_argument("--workflow-ref", required=True)
    deployment.add_argument("--actor-id", type=int, required=True)
    deployment.add_argument("--expected-url", required=True)
    deployment.add_argument("--output", type=Path, required=True)
    deployment.add_argument("--github-output", type=Path)

    completion = commands.add_parser("completion-metadata")
    completion.add_argument("--jobs", type=Path, required=True)
    completion.add_argument("--artifacts", type=Path, required=True)
    completion.add_argument("--evidence-directory", type=Path, required=True)
    completion.add_argument("--deployment", type=Path, required=True)
    completion.add_argument("--repository", required=True)
    completion.add_argument("--run-id", type=int, required=True)
    completion.add_argument("--run-attempt", type=int, required=True)
    completion.add_argument("--producer-job-name", required=True)
    completion.add_argument("--live-job-prefix", required=True)
    completion.add_argument("--head-sha", required=True)
    completion.add_argument("--dispatch-attempt-identity", required=True)
    completion.add_argument("--site-identity-sha256", required=True)
    completion.add_argument("--toolchain-id", required=True)
    completion.add_argument("--toolchain-manifest-sha256", required=True)
    completion.add_argument("--output", type=Path, required=True)
    return root


def main() -> int:
    arguments = parser().parse_args()
    if arguments.command == "job-id":
        job = resolve_job(
            arguments.jobs,
            name=arguments.name,
            run_id=arguments.run_id,
            run_attempt=arguments.run_attempt,
            head_sha=arguments.head_sha,
            require_success=False,
        )
        job_id = positive_integer(job.get("id"), "Actions job ID")
        if arguments.github_output is not None:
            with arguments.github_output.open("a", encoding="utf-8") as stream:
                stream.write(f"job_id={job_id}\n")
        else:
            print(job_id)
    elif arguments.command == "deployment":
        value = deployment_record(
            jobs_path=arguments.jobs,
            deployments_path=arguments.deployments,
            statuses_directory=arguments.statuses_directory,
            repository=arguments.repository,
            run_id=arguments.run_id,
            run_attempt=arguments.run_attempt,
            job_name=arguments.job_name,
            head_sha=arguments.head_sha,
            workflow_ref=arguments.workflow_ref,
            actor_id=arguments.actor_id,
            expected_url=arguments.expected_url,
        )
        write_json(arguments.output, value)
        if arguments.github_output is not None:
            with arguments.github_output.open("a", encoding="utf-8") as stream:
                stream.write(f"deployment_id={value['id']}\n")
                stream.write(f"deployment_job_id={value['jobId']}\n")
    elif arguments.command == "completion-metadata":
        write_json(arguments.output, completion_metadata(
            jobs_path=arguments.jobs,
            artifacts_path=arguments.artifacts,
            evidence_directory=arguments.evidence_directory,
            deployment_path=arguments.deployment,
            repository=arguments.repository,
            run_id=arguments.run_id,
            run_attempt=arguments.run_attempt,
            producer_job_name=arguments.producer_job_name,
            live_job_prefix=arguments.live_job_prefix,
            head_sha=arguments.head_sha,
            dispatch_attempt_identity=arguments.dispatch_attempt_identity,
            site_identity_sha256=arguments.site_identity_sha256,
            toolchain_id=arguments.toolchain_id,
            toolchain_manifest_sha256=arguments.toolchain_manifest_sha256,
        ))
    else:
        raise AssertionError(arguments.command)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
