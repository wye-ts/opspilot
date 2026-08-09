# Harness Foundation — CLI reference

Four pnpm-invoked commands that mechanize the deterministic, repetitive parts of this repo's
AI-assisted engineering workflow (evidence collection, provenance, reconstruction proof). See
`CONTEXT.md` (repo root) for the frozen vocabulary and constraints these commands implement, and
`AGENTS.md` for a one-paragraph orientation. This file is the CLI reference only — flags, JSON
shapes, exit codes, examples.

None of these commands starts infrastructure, installs dependencies, migrates a database, stashes
or changes branches, or makes a commit/push/PR/merge/deploy/LIVE-provider call. `pnpm install` and
`pnpm db:generate` are assumed already done by the caller.

## Common flags

Every command accepts:

- `--task <path>` — load a task declaration from this exact path. Never auto-discovered by
  well-known filename; if omitted, no task declaration is used.
- `--baseline <ref>` — highest-precedence baseline override. Resolved to an exact commit SHA.
- `--agent-dir <path>` — overrides the `.agent/` root (default `<repoRoot>/.agent`).
- `--print-json` — print the full JSON result to stdout (otherwise a one-line PASS/FAIL/status
  summary is printed instead). Diagnostic banners (resolved configuration, failure reasons) always
  go to stderr, so `--print-json` output on stdout is safe to pipe to `jq` or a file.

Resolved-configuration precedence, per field: `default → task-declaration value (if --task given
and the field is present) → CLI flag (if given)`. Every command prints its fully resolved
configuration to stderr before doing any work, with the baseline always shown as an exact commit
SHA.

Baseline fallback (when neither `--baseline` nor a task-declaration `baseline` is given):
`git merge-base HEAD origin/main` → `git merge-base HEAD main` → hard fail. Only two *expected*
misses advance the chain — a candidate ref genuinely not existing here (`MISSING_REF`), and two
histories genuinely sharing no common ancestor (`NO_COMMON_ANCESTOR`). Everything else is `FATAL`
and fails closed with that git error rather than being downgraded into "try the next candidate" —
including a ref that *exists* but cannot resolve or peel to a readable commit (corrupt object,
object missing outright, or the ref pointing at a non-commit object), **and a ref whose entry is
physically present but itself malformed** (a broken loose-ref file or packed-refs line — not the
object it points at, the ref's own on-disk content).

Existence, ref-entry validity, and commit-resolvability are three separately checked things, for
exactly this reason: a broken `origin/main` — in any of these ways — must never be silently treated
as "no `origin/main` here" and fall through to a valid local `main`. `lib/git.ts`'s `lookupRef`
implements this as a tri-state (`MISSING | EXISTS | BROKEN`) via
`git rev-parse --verify -q --symbolic-full-name <ref>`, checked before any commit-resolution is
attempted. `git show-ref --exists` (git ≥2.46) would give the same tri-state more directly, but is
deliberately not used: this repo's dev/CI git versions are not guaranteed to be that recent (the
local dev environment observed here is 2.39), so `lookupRef` gets the same classification from
older, widely-available plumbing instead — `--symbolic-full-name` resolves *which* ref a name
points to without opening its target object, and a physically-malformed ref entry is distinguished
from a genuinely absent one by git's own long-standing "ignoring broken ref" warning, which only
the former produces.

Exit codes are always `0` or `1` — no separate usage-error code.

## Change-set fingerprint

Every result file's provenance carries a fingerprint of the complete change set. It is a SHA-256
over NUL-delimited fields (`<status>`, `<path>`, `<object kind>`, `<content hash>` per entry,
sorted by path, behind a version tag). NUL is the only separator Git guarantees cannot appear in a
path, so the framing is unambiguous for paths containing tabs or newlines.

Object kinds are read with `lstat` and never followed: a regular file is hashed over its bytes, a
symlink over its Git-tracked link target (so a symlink and a regular file holding the same text are
never conflated, and a dangling symlink is a symlink, not a deletion), and an absent path is
`deleted`. Any other filesystem object in the change set — a directory, submodule gitlink, FIFO,
socket, or device — is **unsupported and fails the command closed** rather than being hashed as
something it is not.

Known v1 cut: file mode bits are still not hashed, so a chmod-only change does not move the
fingerprint.

## Task declaration schema

Flat, facts-only, strict (unknown fields rejected):

```json
{
  "$schema": "opspilot-harness/task-declaration@1",
  "baseline": "b6447b0e87af9d72d835824bbb5c0a037113f9e5",
  "expectedBranch": "feat/38-timeline-polling-resume",
  "expectedWorkingTree": "clean",
  "expectedIndex": "empty",
  "scope": ["apps/web/src/**", "docs/16-*.md"]
}
```

Every field is optional. Only ever read via an explicit `--task <path>` on any command — never
auto-discovered.

## `agent:preflight`

Read-only diagnostic. Reports git/environment state; never mutates anything.

```
pnpm agent:preflight [--branch <name>] [--working-tree clean|any] [--index empty|any]
                      [--task <path>] [--baseline <ref>] [--agent-dir <path>] [--print-json]
```

- Exit 0: no declared expectation violated, and the baseline resolves. A dirty tree, staged files,
  or missing optional tooling are reported, never treated as failure on their own.
- Exit 1: a violated expectation (`--branch`/`--working-tree`/`--index`, or the task-declaration
  equivalents), an unresolved baseline, or a malformed task declaration.

Writes `.agent/preflight.json`.

## `agent:verify`

```
pnpm agent:verify (--focused | --final) [--task <path>] [--baseline <ref>]
                   [--agent-dir <path>] [--print-json]
```

Exactly one of `--focused`/`--final` is required — there is no default, so a caller can never
silently get the weaker guarantee.

- `--focused`: maps the complete change set to touched workspaces (`apps/*`/`packages/*`, by
  path-prefix — no dependency-graph awareness) and runs each touched workspace's `typecheck`/`test`
  script. A *valid* manifest that simply lacks the script is the only reason a script is skipped;
  a directly touched workspace whose `package.json` cannot be read or parsed FAILs the run, since
  the harness cannot then tell what should have run there. Zero touched workspaces is a PASS with
  empty steps. This is a convenience mode, not proof that no dependent package needs checking.
- `--final`: runs, unmodified, the exact CI `verify` job commands, in order — `pnpm typecheck`,
  `pnpm test`, `pnpm build`, `pnpm --filter @opspilot/web run check:bundle` — stopping at the first
  failing step (fail-fast, matching CI's own step ordering). Always reports `notRun:
  ["integration", "docker-smoke"]` (those require external infrastructure this harness never
  provisions), unconditionally, even on an early failure that never ran a step.

Exit 1 on any step failure or unresolved ground truth. Writes `.agent/verify-focused.json` or
`.agent/verify-final.json`.

**`agent:review-bundle`'s validation of a `verify-final.json` is strict about this exact contract**
(the exact command list is hand-duplicated in `lib/provenance.ts`'s `FINAL_STEP_COMMANDS`, kept in
sync with `verify.ts`'s `FINAL_MODE_STEPS` the same way that array is already kept in sync with
CI's own `verify` job), not merely "an array of well-shaped steps" — otherwise a hand-doctored
`{ mode: "final", status: "PASS", steps: [], notRun: [] }` would pass structural validation while
claiming a CI-equivalent guarantee nothing ever ran:

- `notRun` must be exactly `["integration", "docker-smoke"]`.
- A `PASS` result must have exactly the four contract commands, in that order, every one `PASS`.
- A `FAIL` result must have either zero steps (a legitimate early ground-truth/configuration
  failure that never reached execution) or a fail-fast prefix of the contract commands: some
  number of leading `PASS` steps followed by exactly one `FAIL` step, matching how `runFinal` stops
  at the first failure.

Any other shape — wrong/missing `notRun`, wrong step count, wrong command or order, a `PASS` with a
`FAIL` step buried in it, a `FAIL` prefix with more than one failing step or ending in `PASS` —
fails validation and is reported `MISSING` + `INVALID_ARTIFACT`, never `CURRENT`. Focused mode has
no such fixed step contract (its steps depend on which workspaces were touched), so it is not held
to this shape.

## `agent:scope-check`

```
pnpm agent:scope-check [--scope <glob>[,<glob>...]] [--task <path>] [--baseline <ref>]
                        [--agent-dir <path>] [--print-json]
```

Opt-in, judgment-free: checks that the complete change set touches only the declared scope.
`--scope` (repeatable or comma-separated) overrides a task-declaration `scope`. Discovery is
always unfiltered, so an out-of-scope file always appears in `changeSetPaths` before being flagged
in `outOfScopePaths` — it never silently disappears.

- `NOT_CONFIGURED` (exit 0): no scope declared anywhere (distinct from an empty `scope: []`, which
  is configured and fails on any change).
- `PASS` (exit 0): every changed path matches at least one pattern.
- `FAIL` (exit 1): at least one changed path is out of scope.

Writes `.agent/scope-check.json`.

## `agent:review-bundle`

```
pnpm agent:review-bundle [--out <dir>] [--render-md] [--task <path>] [--baseline <ref>]
                          [--agent-dir <path>] [--print-json]
```

An evidence collector, not a gate: it never invokes `agent:verify`/`agent:scope-check` itself, and
it never generates findings, severity, or fix rationale. It reads whatever `verify-focused.json`/
`verify-final.json`/`scope-check.json` results already exist in `.agent/` and reports each as
`CURRENT`, `STALE` (re-run the gate), or `MISSING` (`missingReason: NOT_FOUND` if never produced,
`INVALID_ARTIFACT` if present but fails schema validation).

Each artifact is validated **strictly and mode-specifically**: unknown fields are rejected, and a
`verify-focused.json` can never satisfy the `verify-final.json` contract (so the weaker focused
guarantee can never be read as the CI-equivalent one). A focused result placed at
`verify-final.json` reports `MISSING` + `INVALID_ARTIFACT`.

Freshness covers both the state facts (resolved baseline, HEAD, change-set fingerprint) **and the
command-semantic resolved configuration** — the settings that determine what the gate actually
checked. For `scope-check.json` that is the resolved scope, per how the stored run sourced it:

| Stored `scope` source | review-bundle behaviour |
| --- | --- |
| `cli` (`--scope`) | Never a reason to go STALE. review-bundle has no `--scope` and never invents one, so the override's semantics are preserved as recorded. |
| `task-declaration` | Re-resolved from review-bundle's own explicitly supplied `--task`. A scope edited in that file after the gate ran makes the artifact STALE even with an untouched tree and HEAD. With no `--task` supplied it fails closed to STALE — pass the same `--task` you gave `agent:scope-check` to get CURRENT. |
| `default` (not configured) | CURRENT only while no scope is configured now either. |

Incidental provenance metadata (`agentDir`, `taskPath`, the source tier itself) is deliberately
*not* compared — it records where a run's inputs came from, not what it checked.

Also produces an isolated reconstruction proof: an independent `git worktree` (outside the repo,
never touching the real index) checked out at the resolved baseline, with the generated diff
applied and verified via two path-set-equality checkpoints before any content comparison —
`reconstructionProof.status`: `MATCH | MISMATCH | APPLY_FAILED | PATH_SET_MISMATCH | CLEANUP_FAILED`.

`CLEANUP_FAILED` is an HQ-approved amendment to the reconstruction-status enum the original plan
froze at four values: cleanup failure is a distinct evidence-trustworthiness problem (an isolated
worktree left mutating the owner's repository), not any of MISMATCH/APPLY_FAILED/PATH_SET_MISMATCH,
so it gets its own value rather than being folded into one of those and misreported. Like the other
four non-`MATCH` values, `CLEANUP_FAILED` always makes `agent:review-bundle` exit 1
(`status: FAILED`) and is never readable as successful reconstruction evidence.

- Review patches are generated with `--binary`, so binary changes reconstruct losslessly rather
  than degrading to the unappliable `Binary files a/x and b/x differ` placeholder.
- Paths are compared by object type *and* content using the same never-follow-a-symlink
  classification the fingerprint uses, so a symlink is proven as its link target, not through it.
- Cleanup is mandatory and **verified**: after removing the temporary worktree the proof re-reads
  `git worktree list --porcelain` and confirms the registration is really gone. If it is not — or
  removal failed — the status becomes `CLEANUP_FAILED` (never `MATCH`), with the pre-cleanup
  conclusion preserved in `reconstructionProof.cleanupError`, and the collector exits 1.

- Exit 0 (`status: OK`): covers every combination of nested freshness/PASS-FAIL — including a
  `CURRENT` verify result that itself says `FAIL`, or a `MISSING` scope-check. A review bundle
  being produced successfully never means the change passed verification or scope; it means the
  evidence about that is trustworthy.
- Exit 1 (`status: FAILED`): reconstruction is anything other than `MATCH`, the baseline is
  unresolved, the task declaration is malformed, the complete change set cannot be described (e.g.
  it contains an unsupported filesystem object), or an unrecoverable git/fs error occurred while
  gathering evidence.

Writes `<out>/review.json` (default `.agent/review/review.json`) and `<out>/review.diff` always;
`<out>/review.md` (a plain rendering of the same facts, no new content) only with `--render-md`.

## `.agent/` layout

```
.agent/
├── preflight.json
├── verify-focused.json
├── verify-final.json
├── scope-check.json
├── logs/verify-*-<step>.log        # fixed filenames, overwritten each run — no history
└── review/{review.json, review.diff, review.md}
```

Gitignored, default root `<repoRoot>/.agent`, overridable via `--agent-dir`. No command
auto-discovers a prior result or task declaration by well-known filename — only via explicit
`--agent-dir`/`--task`.

## Local development

```
pnpm agent:typecheck   # tsc -p scripts/agent/tsconfig.json --noEmit
pnpm agent:test        # vitest run scripts/agent — the harness's own suite, standalone-runnable
```

Both are also composed into the root `pnpm typecheck`/`pnpm test`, so CI's `verify` job and
`agent:verify --final` cover `scripts/agent/**` automatically.
