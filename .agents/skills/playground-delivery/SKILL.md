---
name: playground-delivery
description: Deliver small NetWasm.Playground implementation slices, verify the changed browser behavior, and update the external live plan after committing and pushing.
---

# Playground delivery

Use the external plan located by `AGENTS.md`; keep progress records there.
This project prioritizes getting a usable local browser compiler into users'
hands. The workflow follows Graphify C#'s small vertical slices and risk-based
verification. It has no 100% coverage requirement.

## Choose a slice

Resolve the current phase against the live worktree and last pushed commit.
Choose the smallest change that demonstrates a new behavior or settles a
specific feasibility question. Do not finish a speculative abstraction layer
before exercising the boundary it is meant to support.

Use a plain TypeScript frontend with Vite and Monaco unless current evidence
justifies more. Start feasibility work with a tiny page and worker; add Monaco
after the compiler/linker/run path works. Prefer existing NetWasm contracts and
published tools. Do not copy the private compiler project's process overhead.

## Verify in proportion to the change

| Change | Useful verification |
| --- | --- |
| Documentation or labels | Diff and affected links; no toolchain build |
| UI behavior | Typecheck/build and one browser interaction |
| Worker protocol | Focused tests for success, stale reply and cancel/failure |
| Tool boundary | Small actual browser fixture and one failure case |
| Compiler/link policy | Relevant upstream regression plus browser/desktop fixture |
| Capability/resource boundary | Denial, timeout/output limit and recovery checks |
| Toolchain pin or launch | Full Playground smoke path and downloaded component under Wasmtime |

Run broader checks once when a slice crosses those boundaries. A package version
or documentation change does not justify hours of unrelated library tests. Never
hide a failed check or represent a mocked compiler as feasibility evidence.

## Finish and continue

1. Inspect the diff; keep credentials, external planning and personal identity out.
2. Commit with the configured Zion Sati identity and signature, and push the slice.
3. Record the SHA, commands/results, artifact location and next action in the
   external plan. Mark unsupported assumptions explicitly.
4. Remove owned disposable output and continue the authorized milestone.

A checkpoint is a short record of completed work. Do not create separate cadence
audits, plan rewrite loops or handoff-only commits for every internal step.
For a feasibility failure, capture one reproducible cause, try the cheapest
plausible alternative and update the plan. Escalate a product tradeoff with
concrete options if the browser-only MVP cannot proceed.
