import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DELIVERY = load("test_delivery_receipt", ROOT / "eng/delivery-receipt.py")
ACTIONS = load("test_actions_delivery", ROOT / "eng/actions-delivery.py")
TRAIN = DELIVERY.TRAIN
COORDINATOR = DELIVERY.COORDINATOR
RECEIVER = load("test_release_receiver", ROOT / "eng/release-receiver.py")


class DeliveryFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        commits = {
            "zion-sati/NetWasm": "a" * 40,
            "zion-sati/TUnit-NetWasm": "b" * 40,
            "zion-sati/NetWasm.Libraries": "c" * 40,
            "zion-sati/NetWasm.Playground": "d" * 40,
            "zion-sati/netwasm.com": "e" * 40,
        }
        release_ids = iter(range(101, 108))
        stages = []
        for name, repository, workflow, upstream, _ in TRAIN.PREPARATION_STAGES:
            website = name == "website"
            stages.append({
                "name": name,
                "repository": repository,
                "workflow": workflow,
                "sourceCommit": commits[repository],
                "infrastructureCommit": commits[repository],
                "workflowCommit": commits[repository],
                "workflowRef": "main" if website else TRAIN.expected_stage_ref(
                    name, "0.5.0"
                ),
                "ref": commits[repository] if website else TRAIN.expected_stage_ref(
                    name, "0.5.0"
                ),
                "releaseId": None if website else next(release_ids),
                "prerelease": name.endswith("-preview"),
                "upstreamStages": list(upstream),
            })
        self.preparation_value = {
            "schemaVersion": 1,
            "version": "0.5.0",
            "stages": stages,
            "policy": {
                "publicationReceiptSchemaVersion": 1,
                "completionStage": "website",
            },
        }
        self.preparation = self.root / "release-preparation.json"
        DELIVERY.write_json(self.preparation, self.preparation_value)
        self.preparation_digest = DELIVERY.sha256(self.preparation)
        self.upstream = self.root / "upstream"
        self.upstream.mkdir()
        upstream_coordinates = []
        for stage in ("core-stable", "tunit-stable", "libraries-stable"):
            path = self.upstream / f"{stage}.json"
            path.write_text(json.dumps({"stage": stage}) + "\n")
            upstream_coordinates.append({
                "stage": stage,
                "sha256": DELIVERY.sha256(path),
                "fileName": path.name,
            })
        playground = TRAIN.preparation_stage(self.preparation_value, "playground")
        self.inputs_value = {
            "coordinated_stage": "playground",
            "preparation_sha256": self.preparation_digest,
            "release_id": str(playground["releaseId"]),
            "release_ref": playground["ref"],
            "source_commit": playground["sourceCommit"],
            "infrastructure_commit": playground["infrastructureCommit"],
            "coordinator_repository": "zion-sati/NetWasm",
            "coordinator_run_id": "600",
            "coordinator_run_attempt": "2",
            "stage_identity": COORDINATOR.stage_identity(
                self.preparation_digest, "playground"
            ),
            "dispatch_attempt_identity": COORDINATOR.dispatch_attempt_identity(
                self.preparation_digest, "playground", "600", "2"
            ),
            "upstream_receipts": json.dumps(
                upstream_coordinates, separators=(",", ":"), sort_keys=True
            ),
            "retained_candidates": "[]",
        }
        self.inputs = self.root / "inputs.json"
        DELIVERY.write_json(self.inputs, self.inputs_value)
        self.toolchain = {
            "id": "1" * 64,
            "manifestSha256": "2" * 64,
        }
        self.toolchain_index = self.root / "index.json"
        DELIVERY.write_json(self.toolchain_index, self.toolchain)
        self.toolchain_archive = self.root / "toolchain.zip"
        self.toolchain_archive.write_bytes(b"exact toolchain bytes")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def make_toolchain_receipt(self) -> Path:
        value = DELIVERY.candidate_receipt(
            preparation_path=self.preparation,
            inputs_path=self.inputs,
            kind="playground-toolchain-candidate",
            archive_path=self.toolchain_archive,
            artifact_id=800,
            run_id=700,
            run_attempt=2,
            job_id=900,
            actor_id=12345,
            toolchain_index_path=self.toolchain_index,
        )
        path = self.root / "toolchain-receipt.json"
        DELIVERY.write_json(path, value)
        return path

    def make_site_receipt(self, toolchain_receipt: Path) -> tuple[Path, Path, Path]:
        source = self.root / "dist"
        source.mkdir()
        (source / "index.html").write_text("<h1>NetWasm</h1>\n")
        (source / "assets").mkdir()
        (source / "assets/app.js").write_text("console.log(42);\n")
        archive = self.root / "site.zip"
        DELIVERY.pack_directory(source, archive)
        identity = self.root / "site-identity.json"
        DELIVERY.write_json(identity, {
            "schemaVersion": 1,
            "sourceCommit": "d" * 40,
            "toolchain": self.toolchain,
            "indexHtmlSha256": hashlib.sha256(
                (source / "index.html").read_bytes()
            ).hexdigest(),
            "entrypoints": ["assets/app.js"],
            "files": {},
        })
        value = DELIVERY.candidate_receipt(
            preparation_path=self.preparation,
            inputs_path=self.inputs,
            kind="playground-site-candidate",
            archive_path=archive,
            artifact_id=801,
            run_id=700,
            run_attempt=2,
            job_id=901,
            actor_id=12345,
            toolchain_index_path=self.toolchain_index,
            site_identity_path=identity,
            toolchain_receipt_path=toolchain_receipt,
        )
        receipt = self.root / "site-receipt.json"
        DELIVERY.write_json(receipt, value)
        return receipt, archive, identity


class DeliveryReceiptTests(DeliveryFixture):
    def test_candidate_chain_round_trips_and_site_archive_is_reproducible(self) -> None:
        toolchain_receipt = self.make_toolchain_receipt()
        DELIVERY.verify_candidate(
            preparation_path=self.preparation,
            inputs_path=self.inputs,
            receipt_path=toolchain_receipt,
            archive_path=self.toolchain_archive,
            kind="playground-toolchain-candidate",
            upstream_directory=self.upstream,
            expected_receipt_sha256=DELIVERY.sha256(toolchain_receipt),
        )
        site_receipt, archive, _ = self.make_site_receipt(toolchain_receipt)
        DELIVERY.verify_candidate(
            preparation_path=self.preparation,
            inputs_path=self.inputs,
            receipt_path=site_receipt,
            archive_path=archive,
            kind="playground-site-candidate",
            upstream_directory=self.upstream,
            toolchain_receipt_path=toolchain_receipt,
        )
        second = self.root / "site-second.zip"
        DELIVERY.pack_directory(self.root / "dist", second)
        self.assertEqual(archive.read_bytes(), second.read_bytes())
        extracted = self.root / "extracted"
        DELIVERY.extract_directory(archive, extracted)
        self.assertEqual(
            (self.root / "dist/assets/app.js").read_bytes(),
            (extracted / "assets/app.js").read_bytes(),
        )

    def test_candidate_rejects_changed_upstream_or_toolchain_dependency(self) -> None:
        toolchain_receipt = self.make_toolchain_receipt()
        site_receipt, archive, _ = self.make_site_receipt(toolchain_receipt)
        (self.upstream / "libraries-stable.json").write_text("changed\n")
        with self.assertRaisesRegex(ValueError, "upstream receipt bytes"):
            DELIVERY.verify_candidate(
                preparation_path=self.preparation,
                inputs_path=self.inputs,
                receipt_path=site_receipt,
                archive_path=archive,
                kind="playground-site-candidate",
                upstream_directory=self.upstream,
                toolchain_receipt_path=toolchain_receipt,
            )
        (self.upstream / "libraries-stable.json").write_text(
            json.dumps({"stage": "libraries-stable"}) + "\n"
        )
        changed = json.loads(toolchain_receipt.read_text())
        changed["toolchain"]["id"] = "9" * 64
        DELIVERY.write_json(toolchain_receipt, changed)
        with self.assertRaisesRegex(ValueError, "toolchain candidate"):
            DELIVERY.verify_candidate(
                preparation_path=self.preparation,
                inputs_path=self.inputs,
                receipt_path=site_receipt,
                archive_path=archive,
                kind="playground-site-candidate",
                upstream_directory=self.upstream,
                toolchain_receipt_path=toolchain_receipt,
            )

    def test_completion_receipt_binds_candidates_deployment_and_three_lanes(self) -> None:
        toolchain_receipt = self.make_toolchain_receipt()
        site_receipt, _, identity = self.make_site_receipt(toolchain_receipt)
        deployment = {
            "id": 1001,
            "environment": "github-pages",
            "url": "https://playground.netwasm.com/",
            "runId": 700,
            "runAttempt": 2,
            "jobId": 902,
        }
        live_checks = []
        for index, browser in enumerate(DELIVERY.LIVE_BROWSERS):
            job_id = 910 + index
            live_checks.append({
                "browser": browser,
                "status": "PASS",
                "jobId": job_id,
                "siteIdentitySha256": DELIVERY.sha256(identity),
                "toolchainId": self.toolchain["id"],
                "toolchainManifestSha256": self.toolchain["manifestSha256"],
                "evidence": {
                    "artifactId": 950 + index,
                    "artifactName": TRAIN.delivery_evidence_artifact_name(
                        "playground-completion",
                        700,
                        2,
                        job_id,
                        browser=browser,
                    ),
                    "fileName": "delivery-evidence.json",
                    "sha256": "8" * 64,
                },
            })
        metadata = self.root / "metadata.json"
        DELIVERY.write_json(metadata, {
            "producerJobId": 903,
            "deployment": deployment,
            "liveChecks": live_checks,
        })
        receipt = DELIVERY.completion_receipt(
            preparation_path=self.preparation,
            inputs_path=self.inputs,
            metadata_path=metadata,
            toolchain_receipt_path=toolchain_receipt,
            site_receipt_path=site_receipt,
            run_id=700,
            run_attempt=2,
            actor_id=12345,
        )
        TRAIN.validate_completion_receipt(
            receipt,
            self.preparation_value,
            self.preparation_digest,
            "playground-completion",
        )


class ActionsDeliveryTests(DeliveryFixture):
    def setUp(self) -> None:
        super().setUp()
        self.run_id = 700
        self.run_attempt = 2
        self.head_sha = "d" * 40
        self.jobs = self.root / "jobs.json"
        jobs = [
            self.job(900, "pages / complete-delivery", "in_progress", None),
            self.job(901, "pages / deploy"),
        ]
        jobs.extend(
            self.job(910 + index, f"pages / verify-live ({browser})")
            for index, browser in enumerate(ACTIONS.LIVE_BROWSERS)
        )
        DELIVERY.write_json(self.jobs, {"jobs": jobs})

    def job(
        self,
        job_id: int,
        name: str,
        status: str = "completed",
        conclusion: str | None = "success",
    ) -> dict[str, object]:
        return {
            "id": job_id,
            "name": name,
            "run_id": self.run_id,
            "run_attempt": self.run_attempt,
            "head_sha": self.head_sha,
            "status": status,
            "conclusion": conclusion,
        }

    def test_resolves_exact_pages_deployment_and_completion_evidence(self) -> None:
        deployments = self.root / "deployments.json"
        DELIVERY.write_json(deployments, [{
            "id": 1001,
            "sha": self.head_sha,
            "ref": "v0.5.0",
            "task": "deploy",
            "environment": "github-pages",
            "creator": {"id": 12345},
        }])
        statuses = self.root / "statuses"
        statuses.mkdir()
        DELIVERY.write_json(statuses / "1001.json", [{
            "state": "success",
            "environment": "github-pages",
            "environment_url": "https://playground.netwasm.com/",
            "log_url": (
                "https://github.com/zion-sati/NetWasm.Playground/actions/runs/"
                "700/job/901"
            ),
            "creator": {"id": 12345},
        }])
        deployment = ACTIONS.deployment_record(
            jobs_path=self.jobs,
            deployments_path=deployments,
            statuses_directory=statuses,
            repository="zion-sati/NetWasm.Playground",
            run_id=self.run_id,
            run_attempt=self.run_attempt,
            job_name="pages / deploy",
            head_sha=self.head_sha,
            workflow_ref="v0.5.0",
            actor_id=12345,
            expected_url="https://playground.netwasm.com/",
        )
        deployment_path = self.root / "deployment.json"
        DELIVERY.write_json(deployment_path, deployment)
        evidence_root = self.root / "evidence"
        artifacts = []
        site_digest = "3" * 64
        for index, browser in enumerate(ACTIONS.LIVE_BROWSERS):
            job_id = 910 + index
            directory = evidence_root / browser
            directory.mkdir(parents=True)
            name = ACTIONS.evidence_artifact_name(
                browser, self.run_id, self.run_attempt, job_id
            )
            DELIVERY.write_json(directory / "delivery-evidence.json", {
                "schemaVersion": 1,
                "status": "PASS",
                "stage": "playground",
                "repository": "zion-sati/NetWasm.Playground",
                "runId": self.run_id,
                "runAttempt": self.run_attempt,
                "dispatchAttemptIdentity": self.inputs_value[
                    "dispatch_attempt_identity"
                ],
                "deployment": deployment,
                "jobId": job_id,
                "browser": browser,
                "siteIdentitySha256": site_digest,
                "toolchainId": self.toolchain["id"],
                "toolchainManifestSha256": self.toolchain["manifestSha256"],
            })
            artifacts.append({
                "id": 950 + index,
                "name": name,
                "expired": False,
                "workflow_run": {"id": self.run_id, "head_sha": self.head_sha},
            })
        artifacts_path = self.root / "artifacts.json"
        DELIVERY.write_json(artifacts_path, {"artifacts": artifacts})
        metadata = ACTIONS.completion_metadata(
            jobs_path=self.jobs,
            artifacts_path=artifacts_path,
            evidence_directory=evidence_root,
            deployment_path=deployment_path,
            repository="zion-sati/NetWasm.Playground",
            run_id=self.run_id,
            run_attempt=self.run_attempt,
            producer_job_name="pages / complete-delivery",
            live_job_prefix="pages / verify-live",
            head_sha=self.head_sha,
            dispatch_attempt_identity=self.inputs_value[
                "dispatch_attempt_identity"
            ],
            site_identity_sha256=site_digest,
            toolchain_id=self.toolchain["id"],
            toolchain_manifest_sha256=self.toolchain["manifestSha256"],
        )
        self.assertEqual(900, metadata["producerJobId"])
        self.assertEqual(
            ["chromium", "firefox", "webkit"],
            [item["browser"] for item in metadata["liveChecks"]],
        )

    def test_rejects_ambiguous_current_job(self) -> None:
        value = json.loads(self.jobs.read_text())
        value["jobs"].append(value["jobs"][0])
        DELIVERY.write_json(self.jobs, value)
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            ACTIONS.resolve_job(
                self.jobs,
                name="pages / complete-delivery",
                run_id=self.run_id,
                run_attempt=self.run_attempt,
                head_sha=self.head_sha,
                require_success=False,
            )

    def test_resolves_absent_lightweight_and_annotated_release_tags(self) -> None:
        repository = self.root / "repository"
        repository.mkdir()

        def git(*arguments: str) -> str:
            completed = subprocess.run(
                ["git", *arguments],
                cwd=repository,
                check=True,
                capture_output=True,
                text=True,
            )
            return completed.stdout.strip()

        git("init", "--initial-branch=main")
        git("config", "user.name", "Zion Sati")
        git("config", "user.email", "283163728+zion-sati@users.noreply.github.com")
        (repository / "fixture.txt").write_text("fixture\n", encoding="utf-8")
        git("add", "fixture.txt")
        git("commit", "-m", "Create fixture")
        commit = git("rev-parse", "HEAD")
        git("tag", "v0.5.0-lightweight")
        git("tag", "-a", "v0.5.0-annotated", "-m", "Annotated fixture")
        blob = git("hash-object", "-w", "fixture.txt")
        tree = git("rev-parse", "HEAD^{tree}")
        git("tag", "v0.5.0-blob", blob)
        git("tag", "v0.5.0-tree", tree)

        self.assertEqual("", ACTIONS.tag_commit(repository, "v0.5.0-absent"))
        self.assertEqual(
            commit,
            ACTIONS.tag_commit(repository, "v0.5.0-lightweight"),
        )
        self.assertEqual(
            commit,
            ACTIONS.tag_commit(repository, "v0.5.0-annotated"),
        )
        for tag in ("v0.5.0-blob", "v0.5.0-tree"):
            with self.subTest(tag=tag), self.assertRaisesRegex(
                ValueError,
                "does not resolve to a commit",
            ):
                ACTIONS.tag_commit(repository, tag)

    def test_playground_release_anchor_distinguishes_draft_and_published_tags(self) -> None:
        stage = TRAIN.preparation_stage(self.preparation_value, "playground")
        release = {
            "id": stage["releaseId"],
            "tag_name": stage["ref"],
            "target_commitish": stage["sourceCommit"],
            "draft": True,
            "prerelease": False,
        }
        RECEIVER.validate_delivery_anchor(release, stage, self.preparation_value, "")
        RECEIVER.validate_delivery_anchor(
            release,
            stage,
            self.preparation_value,
            str(stage["sourceCommit"]),
        )
        with self.assertRaisesRegex(ValueError, "Prepared Playground release"):
            RECEIVER.validate_delivery_anchor(
                release,
                stage,
                self.preparation_value,
                "f" * 40,
            )

        release["draft"] = False
        RECEIVER.validate_delivery_anchor(
            release,
            stage,
            self.preparation_value,
            str(stage["sourceCommit"]),
        )
        with self.assertRaisesRegex(ValueError, "Prepared Playground release"):
            RECEIVER.validate_delivery_anchor(
                release,
                stage,
                self.preparation_value,
                "",
            )


class WorkflowContractTests(unittest.TestCase):
    def test_production_is_dispatch_only_and_never_cancels_an_active_stage(self) -> None:
        release = (ROOT / ".github/workflows/release.yml").read_text()
        self.assertNotIn("push:\n", release)
        self.assertIn("workflow_dispatch:", release)
        self.assertIn("cancel-in-progress: false", release)
        self.assertIn("python3 bootstrap/eng/release-receiver.py", release)
        self.assertIn("--approved-actor-id \"$APPROVED_ACTOR_ID\"", release)
        self.assertNotIn("gh release create", release)

    def test_candidate_receipts_are_the_last_fallible_producer_steps(self) -> None:
        release = (ROOT / ".github/workflows/release.yml").read_text()
        pages = (ROOT / ".github/workflows/pages.yml").read_text()
        self.assertGreater(
            release.index("- name: Retain toolchain candidate receipt"),
            release.index("- name: Retain resolved toolchain for the site build"),
        )
        self.assertGreater(
            pages.index("- name: Retain site candidate receipt"),
            pages.index("- name: Retain resolved site for qualification and deployment"),
        )
        self.assertTrue(
            pages.rstrip().endswith("retention-days: 90"),
            "Completion receipt upload must remain the final completion-job step.",
        )

    def test_completion_collects_three_exact_lanes_and_deployment(self) -> None:
        pages = (ROOT / ".github/workflows/pages.yml").read_text()
        self.assertEqual(2, pages.count("browser: [chromium, firefox, webkit]"))
        self.assertIn("--job-name 'pages / deploy'", pages)
        self.assertIn("--producer-job-name 'pages / complete-delivery'", pages)
        self.assertIn("--live-job-prefix 'pages / verify-live'", pages)
        self.assertIn("delivery-evidence-playground-${{ matrix.browser }}", pages)
        self.assertIn("delivery-completion-playground-${{ github.run_id }}", pages)
        self.assertIn("bind-deployment:", pages)
        self.assertIn("needs: [prepare-site, deploy, bind-deployment]", pages)
        self.assertIn(
            "needs: [prepare-site, deploy, bind-deployment, verify-live]",
            pages,
        )

    def test_attempt_bound_artifacts_make_native_reruns_unambiguous(self) -> None:
        release = (ROOT / ".github/workflows/release.yml").read_text()
        pages = (ROOT / ".github/workflows/pages.yml").read_text()
        self.assertIn(
            "coordinated-inputs-${{ inputs.stage_identity }}-${{ github.run_attempt }}",
            release,
        )
        self.assertIn(
            "github-pages-${{ github.run_id }}-${{ github.run_attempt }}",
            pages,
        )
        self.assertIn(
            "artifact_name: ${{ needs.stage-site.outputs.pages_artifact }}",
            pages,
        )
        self.assertIn("Native production reruns are not supported", release)
        self.assertEqual(
            7,
            pages.count("Native production reruns are not supported"),
        )

    def test_retry_paths_accept_only_the_ordered_candidate_prefix(self) -> None:
        release = (ROOT / ".github/workflows/release.yml").read_text()
        pages = (ROOT / ".github/workflows/pages.yml").read_text()
        self.assertIn("python3 bootstrap/eng/release-receiver.py", release)
        self.assertIn("delivery-candidate-${kind}.json", release)
        self.assertIn("--expected-receipt-sha256 \"$expected\"", release)
        self.assertIn("if: inputs.production && inputs.retained_site", pages)
        self.assertIn("if: inputs.production && !inputs.retained_site", pages)
        self.assertIn("--toolchain-receipt artifacts/toolchain/", pages)


if __name__ == "__main__":
    unittest.main()
