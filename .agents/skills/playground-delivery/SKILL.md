---
name: playground-delivery
description: Deliver small NetWasm.Playground implementation slices, verify browser behavior, control build/cache disk growth, and update the external live plan after committing and pushing.
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

## Models, delegation and review checkpoints

Default main thread: `gpt-5.6-sol`, reasoning `low`. It implements ordinary
slices, integrates changes and owns the external plan. This routing is an
engineering recommendation for this workload, not a measured model benchmark.

Ask a `gpt-6-astra` / `high` subagent for a focused independent review at three
checkpoints: the proven compiler/request contract before the large toolchain
build; the first real compile/run/download slice; and the guest isolation and
failure-recovery boundary before launch. The external plan specifies evidence
for each. Reviewers read the actual diff, public source contracts and test
results. They report concrete correctness/capability defects or missing evidence,
not speculative abstractions or demands for blanket coverage.

Keep routine work on the main thread. Delegate a bounded compiler/AOT, LLD,
Binaryen, generator or host-integration blocker to Sol/high when it needs deeper
investigation. Terra/high (`gpt-5.6-terra`, reasoning `high`) is an optional worker
for independent UI, example or test tasks with settled interfaces. Do not split
tightly coupled work just to use more models. If delegation is unavailable,
continue routine work and mark the independent review pending explicitly.

Use at most two subagents and one expensive LLVM/.NET AOT build at a time.
Give each implementation worker a disjoint file scope or isolated owned worktree,
the pinned inputs, expected behavior and relevant checks. Record owned worktrees
and processes in the external plan. Review agents are read-only. Implementation
workers return their diff/commit and evidence; the main thread reviews, integrates,
signs and pushes the slice. Clean only those owned worktrees after integration.

Do not repeat a completed review after compaction or for unrelated text/version
edits. Reopen only the changed boundary when new evidence or code requires it.

## Verification scope

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
4. Apply the cleanup rules below, then continue the authorized milestone.

A checkpoint is a short record of completed work. Do not create separate cadence
audits, plan rewrite loops or handoff-only commits for every internal step.
For a feasibility failure, capture one reproducible cause, try the cheapest
plausible alternative and update the plan. Escalate a product tradeoff with
concrete options if the browser-only MVP cannot proceed.

## Disk and cleanup

These rules apply to substantial builds, downloads, package staging and browser
test artifacts. Small text edits need no storage audit. They are self-contained;
the global `workspace-hygiene` skill may supply more detail when available.

- Before LLVM/.NET AOT builds or large downloads, inspect filesystem free space
  (`df -h`) and the actual output/cache sizes (`du -sh` on known paths). Estimate
  peak build space, not just the final bundle. Use the free-space floor recorded
  in the external plan; this workstation's floor is 100 GiB.
- During long builds, sample free space every few minutes with a lightweight
  monitor or checks between stages. Verify that the monitor produces real samples.
  If the next operation would cross the floor, stop launching more work, clean
  owned disposable output and report the remaining constraint.
- Isolate each large run in a named ignored directory or `mktemp -d` directory.
  Record its exact path, purpose and retention status in the external plan. Also
  record owned containers, worktrees and background processes when used.
- Once a slice passes, retain the input/toolchain manifest, concise test result
  and useful final fixture. Remove its redundant extracted packages, temporary
  restore caches, duplicate archives, failed build trees, verbose traces and
  test output. Keep one reusable verified cache/toolchain where it saves costly
  rebuilds; do not accumulate a new full copy for each slice or version bump.
- Resolve exact cleanup targets and confirm ownership before deletion. Do not
  clear all NuGet caches, run broad Docker prune commands, or delete another
  task's worktree/cache. Unknown ownership means preserve it. Check that retained
  evidence does not require files you are about to remove; cleanup alone does
  not justify rebuilding or rerunning the full suite.
- At a substantial slice boundary, clean those owned disposable outputs,
  recheck free space and record the remaining large caches in the external plan.
  Briefly report material deletions and whether they are recoverable. Stop only
  your temporary monitors/processes when done; preserve processes the owner
  requested to keep running.
