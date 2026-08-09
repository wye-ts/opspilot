# OpsPilot Engineering Harness

Vocabulary for the repo-local tooling ("Harness Foundation") that mechanizes the deterministic,
repetitive parts of this project's AI-assisted engineering workflow — plan → implementation session
→ verification → review artifacts → independent review → adjudication → fix → final verification →
owner-controlled commit. It does not cover the product domain (investigations, agent runs, evidence),
which has its own vocabulary in the design docs under `docs/`.

## Language

**Harness Foundation**:
The v1 set of root-level pnpm scripts (`agent:preflight`, `agent:verify`, `agent:review-bundle`,
optionally `agent:scope-check`) that scaffold the focused-verification, review-artifact, and
final-verification stages of the workflow with deterministic checks. It deliberately does not
touch plan approval, independent-review findings authorship, adjudication, or the commit/push/merge
decision — those remain human/model judgment.
_Avoid_: agent platform, agent framework — this is scaffolding, not an orchestration layer.

**Preflight**:
A read-only diagnostic step (`agent:preflight`) run at the start of a session that reports git and
environment state — current branch/HEAD, staged files, tracked/untracked working-tree state,
supplied expected baseline, relevant repo/context/document pointers, local tooling availability —
without mutating anything (no starting infrastructure, no migrations, no stashing, no branch
changes). It fails only in two cases: a caller-declared expectation is violated, or preflight cannot
establish trustworthy ground truth for itself (e.g. an unresolved baseline, a malformed task
declaration, or a tool it depends on being unavailable). Any other observed state — a dirty tree,
staged files, missing optional infrastructure — is reported, never treated as failure on its own.
_Avoid_: setup, bootstrap — it never changes state, only observes it.

**Expectation** (preflight):
A caller-declared assertion about repo state (e.g. "working tree must be clean," "branch must be
X," "baseline Y must be an ancestor of HEAD") that preflight checks and fails loudly on when
violated. Absent any declared expectation, a dirty working tree is not itself a failure — the
workflow deliberately supports fresh sessions starting on top of existing reviewed, uncommitted
changes (e.g. a targeted fix session after a Codex finding).
_Avoid_: invariant, precondition — those imply universal rules; expectations are per-session/opt-in.

**Task declaration**:
A small, explicitly-supplied (never auto-loaded) inert fact file read by harness commands: baseline,
expected branch, expected working-tree/index state, and allowed scope patterns. It holds only facts,
never workflow logic — the harness must not grow into a policy engine that interprets it.

**Resolved configuration**:
The effective settings a harness command actually acts on for a given run — defaults, task-declaration
values, and CLI overrides merged in that precedence — which the command must print before doing any
work, including the baseline resolved to an exact commit SHA rather than a symbolic ref.

**Complete change set**:
The full non-ignored working-tree change set, including all untracked files, discovered independently
of any declared scope. It is what review evidence is built from — scope is never used as a filter
during discovery. An out-of-scope file must appear in the evidence and then be flagged by scope check;
it must never silently disappear because it fell outside the declared scope.

**Gate** vs **evidence collector**:
Two distinct roles a harness command can play. A gate (`agent:preflight`, `agent:verify`,
`agent:scope-check`) fails when the thing it checks fails — a broken test, a violated expectation, an
out-of-scope file are real, intentional gate failures. An evidence collector (`agent:review-bundle`)
fails only when it cannot itself produce trustworthy evidence — a recorded verification failure or
scope violation inside its output is a successful collection, not a failure of the collector.
_Avoid_: conflating the two — a review bundle being generated successfully never means the change
passed verification or scope; it means the evidence about that is trustworthy.

**Provenance** (result file):
The facts a gate's result file records about the state it was produced against — resolved baseline
SHA, current HEAD SHA, a fingerprint of the complete change set, and the relevant resolved
configuration. An evidence collector reads a gate's result only after checking this provenance
against its own current state, marking the result STALE (not current evidence) rather than MISSING
(never produced) when they disagree, and never silently re-running the gate to paper over either.

**Review bundle**:
The output of `agent:review-bundle`, an evidence collector: a diff over the complete change set plus
a machine-readable manifest of mechanically verifiable facts only (resolved baseline, HEAD/branch,
changed paths, diff hash, git/index state, reconstruction-proof result, and the provenance-checked
verify/scope-check results it found — current, STALE, or MISSING). An optional generated rendering
of the same facts exists for human readability. The manifest is the source of truth; the tool never
generates findings, severity, architectural judgment, or fix rationale — that narrative remains
Claude/Codex/HQ's responsibility. It never invokes `agent:verify` or `agent:scope-check` itself.
_Avoid_: review report — implies the tool judges; it only measures and records.

**Focused verification**:
The weaker, convenience mode of `agent:verify` that deterministically detects workspaces directly
touched by the complete change set and runs their typecheck/tests. Detecting directly-touched
packages is not proof that no dependent package needs checking — that sufficiency judgment, and any
broader package selection it implies, belongs to the model/caller, not the harness.
_Avoid_: impact analysis, affected-package detection — v1 does no dependency-graph reasoning.

**Final verification**:
The `agent:verify` mode that mirrors CI's `verify` job exactly (typecheck, tests, build, bundle guard)
across the whole workspace. It always explicitly reports that integration and Docker-smoke checks were
not run, since those require external infrastructure the harness will not silently provision — final
verification is never to be read as equivalent to the entire CI pipeline.

**Scope check**:
`agent:scope-check`: an opt-in, judgment-free check that the complete change set touches only paths
matching an explicitly caller-declared scope. Scope itself is never inferred or decided by the
harness — it comes from the approved plan/HQ. With no scope declared, it reports "scope check not
configured" rather than guessing one.
