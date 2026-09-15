# NetWasm.Playground contributor instructions

Build a useful browser compile/run/download experience quickly. Work directly
in this repository; there is no export or projection step.

## Start here

The owner keeps the live plan outside Git. Read `NETWASM_PLAYGROUND_PLAN` when
set; otherwise read `$HOME/Documents/NetWasm-Playground-Plan.md`. Never copy the
plan, its operational records, or its machine-specific paths into this repo.
On another machine, obtain the external plan from the owner if it is unavailable.
The plan contains the current milestone, public source map and next slice.

Read `.agents/skills/playground-delivery/SKILL.md` for implementation slices.
Read `.agents/skills/browser-toolchain/SKILL.md` when working on compilation,
linking, componentization, execution, or toolchain assets.

## Authority and identity

- The owner authorizes implementation, focused verification, signed commits and
  pushes to this repo after each completed slice. Do not stop to request another
  approval for those routine actions. Work on `main` unless isolation is useful.
- Author and committer: `Zion Sati`,
  `283163728+zion-sati@users.noreply.github.com`. Use the locally configured
  signing key. Never commit a private key, token, personal identity or absolute
  home-directory path. Preserve upstream copyright notices.
- Keep the repository private until the owner explicitly authorizes a visibility
  change. Publishing a site can expose its assets even when its source is private.
- Push ordinary slices; publish deployable releases at the plan's release gates.
  Do not turn each commit into a release or a toolchain rebuild.
- CI/CD is deferred until an explicit design discussion with the owner. Do not
  add or enable workflows, deploy the site, or change Pages/DNS settings yet.
  The owner will configure GitHub Pages and has a domain ready.

## Public inputs only

Use `eng/upstream-sources.json`, the public NetWasm repositories and public
NuGet.org/npm/upstream release artifacts. Do not depend on private NetWasm
authoring repos, qualification repos, sibling output folders, local feeds or
locally packed NuGet archives. The repository's `NuGet.Config` clears inherited
feeds. Use a repo-isolated package cache, and a fresh cache for the first smoke
test of an updated package closure so old local packages cannot satisfy restore.

Building a browser toolchain from a pinned public source checkout is expected.
That is distinct from consuming unpublished local NuGet packages. Put reusable
browser compiler, runtime planning and host adapters in the public NetWasm repo;
put the UI, examples and Playground worker scheduling here. Publish and pin the
upstream source commit before another agent must consume it. Honor that repo's
own engineering rules when changing it; keep Playground's delivery cadence here.

## Keep progress moving

Use narrow behavioral tests during iteration. A visible slice needs a relevant
browser smoke test; a copy-only edit needs a diff/link check. No coverage quota,
blanket matrix, repeated whole-ecosystem qualification or framework-building
prerequisite. Resource limits and capability isolation need focused failure tests.

After a slice: verify it, commit and push, then update the external plan with
the pushed SHA, evidence, remaining uncertainty and one next action. After a
context reset, reconcile that checkpoint with Git and continue the active task.
Do not repeat completed work or reopen settled decisions without new evidence.

Keep large assets in ignored caches and release/deployment artifacts. Clean
owned intermediates at slice boundaries. Inspect free disk space before large
LLVM/.NET builds. Never delete another task's worktree or cache to make room.
