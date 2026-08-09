# Harness Foundation — CLI reference

Five pnpm-invoked commands that mechanize the deterministic, repetitive parts of this repo's
AI-assisted engineering workflow (evidence collection, provenance, reconstruction proof). See
`CONTEXT.md` (repo root) for the frozen vocabulary and constraints these commands implement, and
`AGENTS.md` for a one-paragraph orientation. This file is the CLI reference only — flags, JSON
shapes, exit codes, examples.

None of these commands starts infrastructure, installs dependencies, migrates a database, stashes
or changes branches, or makes a commit/push/PR/merge/deploy call. `pnpm install` and
`pnpm db:generate` are assumed already done by the caller. The sole exception to "no LIVE-provider
call" is `agent:codex-review`, whose entire purpose is a real Codex/model-provider invocation —
called out explicitly in its own section below.

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
it never generates findings, severity, or fix rationale. Its manifest's `git` object additionally
carries `changeSetFingerprint` (the same fingerprint already used for freshness comparisons
elsewhere) alongside `baselineSha`/`headSha`/`branch`/`changedPaths`/`diffHash` — `agent:codex-review`
is this field's first consumer, using it together with `diffHash` as part of the identity it binds
a Codex invocation to. It reads whatever `verify-focused.json`/
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

## `agent:codex-review`

```
pnpm agent:codex-review [--review-dir <dir>] [--out <dir>] [--timeout-ms <n>]
                         [--task <path>] [--baseline <ref>] [--agent-dir <path>] [--print-json]
```

An evidence collector, not a verdict gate — exactly like `agent:review-bundle`. It invokes Codex
(read-only) against exactly the evidence `agent:review-bundle` already produced, validates Codex's
output strictly, and writes the result as a Harness-owned artifact. It never adjudicates findings,
never routes a fix, and never itself commits/pushes/merges/deploys. Exit 0 (`status: OK`) covers a
validated `NEEDS_FIXES` verdict just as much as `READY_FOR_OWNER_REVIEW` — a real finding is
successful *collection*, not a failure of the collector. Exit 1 (`status: FAILED`) means only "this
tool's own output cannot be trusted": blocked/stale input, Codex unavailable or it crashed, invalid
Codex output, or a post-invocation freshness mismatch.

**This command makes a real, external Codex/model-provider call every time it runs successfully.**
It is never run automatically by any other command in this set.

- `--review-dir`: where to *read* the review bundle from. Default `<agentDir>/review`.
- `--out`: where to *write* this command's own artifacts. Default `<agentDir>/codex`.
- `--timeout-ms`: Codex invocation timeout, a positive integer. Default `600000` (10 minutes).
- No `--sandbox`/`--dangerously-*` flag, no `--prompt` override, no `--codex-model`/
  `--codex-reasoning-effort` override — the sandbox mode and reviewer model/effort are frozen
  constants in `lib/codex-invocation.ts`, not configurable per-run in v1.
- `--task`, when given, is itself part of the evidence identity this command binds the Codex
  invocation to (see below) — not just a config-resolution input as on every other command.

### Invocation boundary

Plain `codex exec`, never `codex exec review` — the `review` subcommand computes its own git diff
(`--uncommitted`/`--base`/`--commit`), which would let Codex review a different scope than the
harness-verified review bundle. The prompt is piped via stdin (the same `spawnSync(..., { input })`
pattern `lib/git.ts` already uses for `git apply`):

```
codex exec --sandbox read-only --ephemeral --ignore-user-config --ignore-rules \
  -c model="gpt-5.6-sol" -c model_reasoning_effort="high" \
  -C <repoRoot> \
  --output-schema <schemaFile> --output-last-message <invocationScopedTempFile> \
  -
```

- `--sandbox read-only` is hardcoded and is the primary write-prevention mechanism.
- `--ephemeral` avoids leaving Codex session history on disk.
- `--ignore-user-config`/`--ignore-rules` are hardcoded so the reviewer never silently inherits
  whatever the invoking machine's own Codex config/execpolicy `.rules` happen to contain.
  `--ignore-user-config` still uses `CODEX_HOME` for auth, so this does not break login.
- `--output-schema` gets Codex's own schema-constrained output as a first layer; Harness
  independently re-validates the parsed result with its own strict type guard
  (`isCodexReviewPayload`) plus a self-contradiction check (`verdictConsistentWithFindings`).
- `--output-last-message <file>` is the only channel Harness reads from — never stdout scraping —
  and is invocation-scoped: a stale file already present at that exact path is a hard
  `CODEX_EXECUTION_FAILED`, never silently overwritten or read as this run's output.
- Codex never reads the mutable original `review.json`/`review.diff`/task-declaration paths. The
  exact bytes already hashed for the pre-invocation freshness check are instead written, unmodified,
  into invocation-scoped snapshot files next to `--output-last-message`, and the prompt points at
  those snapshots. A file swapped out after hashing and restored before the post-invocation re-check
  (see below) would otherwise let Codex read substituted content while every hash comparison still
  lined up.
- `codex exec`'s raw stdout/stderr may still be captured into `codex-review.log` by the invocation
  wrapper regardless of outcome — that log is diagnostic only. `--output-last-message`'s contents are
  not parsed, schema-validated, or published as a trusted `payload` until *after* the post-invocation
  freshness re-check below passes; a TOCTOU mismatch there discards the raw output entirely rather
  than validating it.

### Output destination safety

Before Codex is ever invoked, every Harness-owned persistent write target this command produces
(`review-findings.json`, `review-summary.md`, `codex-review.log`) is checked by
`lib/output-destination.ts`'s `checkOutputDestination`, and any failure is reported as
`OUTPUT_DESTINATION_UNSAFE` with `codexExec.invoked: false`:

1. **Repo/ignore classification is physical, not lexical.** A destination is safe only if it is
   outside the repository, or inside it and Git-ignored — but both the destination and the repo root
   are resolved to their real, symlink-free location first (`realpath`, walking up to the nearest
   existing ancestor and appending any not-yet-existing suffix unresolved — no directory is created
   just to perform the check). A path that lexically looks like it's outside the repo can still
   traverse a symlinked ancestor into an unignored in-repo directory; physical resolution catches
   that, where a purely lexical `path.resolve` comparison would not. The destination's own final path
   component is deliberately *not* followed through a symlink, even when one already exists there:
   every persistent artifact here is written via `lib/atomic-write.ts`'s same-directory
   temp-file-then-rename, and a rename onto an existing pathname replaces that pathname itself rather
   than following it — so a pre-existing final-component symlink pointing outside the repo would still
   have its own (in-repo) pathname clobbered by the rename, and must classify as in-repo/unsafe.
2. **No target may alias a current evidence input.** Independently of rule 1, a write target that
   resolves to the same physical file as the task declaration (when `--task` was given), `review.json`,
   or `review.diff` is always unsafe — those inputs already read this run are often Git-ignored
   themselves (living under `.agent/`), so rule 1 alone would wave the alias through, but a successful
   run would then silently overwrite evidence its own freshness checks depended on.

**`OUTPUT_DESTINATION_UNSAFE` is the one narrow exception to "the result artifact is always written."**
Every other failure category still writes `review-findings.json`/`review-summary.md` to `<out>` so a
failed run remains inspectable — that's the normal collector rule (see `agent:review-bundle`'s
identical behavior above). `OUTPUT_DESTINATION_UNSAFE` means one of those two paths, or the log path,
was itself classified unsafe (including possibly aliasing an evidence input), so writing there
regardless would be the exact hazard rules 1–2 exist to prevent. On this failure category alone, no
persistent artifact is written anywhere; the result is reported only via stdout/stderr, or the full
JSON via `--print-json`.

### JSON shape

`review-findings.json` (`<out>/review-findings.json`):

```ts
status: "OK" | "FAILED";
failureCategory:
  | "GROUND_TRUTH_UNRESOLVED" | "INPUT_MISSING" | "INPUT_INVALID" | "INPUT_STALE"
  | "OUTPUT_DESTINATION_UNSAFE"
  | "CODEX_UNAVAILABLE" | "CODEX_EXECUTION_FAILED" | "CODEX_OUTPUT_INVALID" | null;
failureReason: string | null;
payload: { verdict: "READY_FOR_OWNER_REVIEW" | "NEEDS_FIXES"; findings: CodexFinding[] } | null;
reviewInput: { freshness; missingReason; reviewJsonPath; reviewDiffPath };
codexExec: { invoked; exitCode; durationMs; logPath };
reviewJsonHash: string | null;
reviewDiffHash: string | null;
taskDeclarationHash: string | null;
provenance: ProvenanceBlock | null;
```

`<out>/review-summary.md` is a plain rendering of the same facts, no new content.

`provenance` follows the same "assigned exactly once, right after baseline/HEAD/change-set
fingerprint all resolve, never cleared afterward" discipline as every other command:
`GROUND_TRUTH_UNRESOLVED` ⟺ `provenance === null`; every other `failureCategory` (including
`status: OK`) ⟺ `provenance !== null` — **with one approved exception**: `OUTPUT_DESTINATION_UNSAFE`
can have `provenance === null` too, specifically when the output-destination-safety check (which
runs and can override the failure category regardless of any earlier diagnostic failure — see above)
overrides an earlier `GROUND_TRUTH_UNRESOLVED` condition that never let baseline/HEAD/fingerprint all
resolve in the first place. Persisting that earlier `GROUND_TRUTH_UNRESOLVED` diagnostic over an
unsafe destination would itself be the unsafe write the check exists to prevent, so the override is
unconditional; it does not manufacture a provenance block along the way. `reviewJsonHash`/
`reviewDiffHash` are assigned once, on first successful read, independently of `provenance`.

`taskDeclarationHash` is `null` whenever no explicit `--task` was given, for the whole run. With
`--task <path>` given, it is the SHA-256 of the exact raw bytes read from that path — an
opaque-blob hash, not a per-field comparison, so even a whitespace/comment-only edit counts as a
change. It is captured independently of `provenance`: a task declaration whose bytes were read
successfully but which then fails `loadTaskDeclaration`'s schema validation still gets a non-null
`taskDeclarationHash` even though `status` is `GROUND_TRUTH_UNRESOLVED`; only a raw read failure
(file missing/unreadable) leaves it `null`.

### Freshness: `codexArtifactFreshness` (seven facts)

A Codex artifact's identity is bound to seven facts, via a shared helper in `lib/provenance.ts` next
to `compareProvenance`: `baselineSha`, `headSha`, `changeSetFingerprint` (via `compareProvenance`),
`reviewJsonHash`, `reviewDiffHash`, `taskDeclarationHash`, and a regenerated current
complete-change-set diff hash. All seven must match for `CURRENT`; any mismatch is `STALE`. `null`
vs. `null` (no task declared on either side) does not itself force `STALE`; `null` vs. any real
hash, or two different hashes, always does. This closes a fail-open path where a task declaration
living under `.agent` could change scope, expected branch, etc. (or simply vanish) without moving
any of the other facts at all — binding to only the other six facts would let a stale Codex artifact
tied to an old task declaration still read as current.

The seventh fact — the regenerated current complete-change-set diff hash — exists because
`changeSetFingerprint` deliberately does not hash file mode bits (see `fingerprint.ts`'s "Known v1
cut"), while `git diff` output *does* include `old mode`/`new mode` lines. Without it, a mode-only
change to an already-changed path (e.g. `chmod +x` after `agent:review-bundle` ran) would leave
every other fact identical — `review.diff`'s own on-disk bytes are untouched, so its stored-bytes
hash still matches too — even though the current Git-relevant diff no longer matches what was frozen
into `review.diff` and handed to Codex. This fact is computed by regenerating the diff, via the exact
same `generateReviewDiff` semantics `agent:review-bundle` itself uses (never a second diff format),
over the current baseline/change-set, and comparing its hash against the *stored* `review.diff`
bytes hash — a distinct comparison from the stored-vs-current `review.diff` bytes-hash comparison
above: one proves `review.diff` itself wasn't mutated or the tree hasn't drifted from a frozen
`review.diff` a caller failed to notice, the other independently proves the frozen bytes still
represent Git reality right now.

This same helper is used twice:

1. **Internal TOCTOU protection** (below) — `agent:codex-review` calls it on itself.
2. **External/future consumers** of `review-findings.json`, comparing its stored seven facts against
   freshly recomputed current ones. v1 does not consume its own prior `review-findings.json` for a
   skip-if-current shortcut — every run re-invokes Codex.

### Post-invocation TOCTOU re-check

After the pre-invocation freshness check confirms the review bundle is `CURRENT`, the seven-fact
tuple is retained in memory as the invocation identity. If `codex exec` exits `0`, Harness
re-resolves `baselineSha`/`headSha`, recomputes `changeSetFingerprint`, re-hashes
`review.json`/`review.diff`'s current bytes, regenerates the current complete-change-set diff hash,
and — only if `--task` was given — attempts to re-read and re-hash the task declaration's raw bytes
(a failed re-read, including the file having disappeared, yields `null` for this comparison rather
than an exception). `codexArtifactFreshness` is called again with the retained tuple as `stored*`
and these fresh values as `current*`. Any mismatch (in any of the seven facts, including the task
declaration and the regenerated diff hash) ⇒ `status: "FAILED"`, `failureCategory: "INPUT_STALE"`,
`payload: null`, exit `1` — even though `codex exec` itself exited `0`. Codex's output file is never
read in this branch. This protects against anything changing the code, review evidence, or task
configuration while the (potentially long-running) Codex call was in flight — including a
Git-relevant executable-bit-only change made during that window, which `changeSetFingerprint` and
`review.diff`'s own re-read bytes hash alone cannot catch.

### Exit codes

`0` iff `status === "OK"`; `1` iff `status === "FAILED"` — including the TOCTOU case.

## `.agent/` layout

```
.agent/
├── preflight.json
├── verify-focused.json
├── verify-final.json
├── scope-check.json
├── logs/verify-*-<step>.log        # fixed filenames, overwritten each run — no history
├── logs/codex-review.log           # fixed filename, overwritten each run — no history
├── review/{review.json, review.diff, review.md}
└── codex/{review-findings.json, review-summary.md}
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
