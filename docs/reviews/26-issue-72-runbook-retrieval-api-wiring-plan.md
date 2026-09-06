# Issue #72 — Wire runbook retrieval into the deployed Agent Run API path (narrow scope)

| | |
| --- | --- |
| Scope | #72 "Wire runbook retrieval into the deployed Agent Run API path" — relocate the existing deterministic retriever into the shared package and wire it into `apps/api`; no semantic-retrieval, no orchestrator/contract changes |
| Basis | `main` @ `b33a3dab76bc69aa566685665d172a7c1085f263` (merge of PR #71, "richer Agent Activity"), working tree clean |
| Status | Plan only. No repository source modified, no migration, no commit, push, PR, merge, or deploy. No provider/LIVE request. |
| Branch | `feat/72-runbook-retrieval-api-wiring` (created, empty) |
| Committed location | `docs/reviews/26-issue-72-runbook-retrieval-api-wiring-plan.md` |

---

## Scope decision (if the issue text admits more than one reading)

Two materially different ways to close this issue:

- **Narrow (selected):** wire the existing deterministic `InMemoryKeywordRunbookRetriever` (already
  built, tested, and used in `apps/worker`'s demo/eval paths) into `apps/api`. No new retrieval
  algorithm, no external API, no new safety/budget machinery.
- **Wide (rejected):** wire `VoyageRunbookRetriever` (real embedding API) into the LIVE `apps/api`
  path instead of/in addition to the deterministic one. Rejected for this issue because (a) it only
  helps the LIVE path, which stays disabled for the public demo (`LIVE_AGENT_RUNS_ENABLED=false`),
  so it does not close the actual gap (public FAKE demo shows zero RAG evidence); (b) it requires a
  new external-cost/fail-closed safety envelope analogous to the Claude LIVE budget work, which is
  disproportionate to what this issue needs; (c) owner confirmed narrow scope in chat before this
  plan was written.

---

## 1. Current-state findings

| Area | File / symbol | What it does today |
| --- | --- | --- |
| Retriever impl | `apps/worker/src/rag/in-memory-runbook-retriever.ts` (`InMemoryKeywordRunbookRetriever`) | Deterministic keyword/token-overlap scoring against a `StoredRunbookChunk[]` corpus. Implements the shared `RunbookRetriever` interface already in `packages/agent-runtime/src/rag/runbook-retriever.ts`. |
| Corpus loader | `apps/worker/src/rag/markdown-runbook-loader.ts` (`MarkdownRunbookCorpusLoader`), `apps/worker/src/rag/load-default-runbook-corpus.ts` | Parses `runbooks/*.md` into `StoredRunbookChunk[]`. `resolveDefaultRunbooksDir()` computes the runbooks path via `import.meta.url`, 4 directories up from its own file to repo root, then `+ "runbooks"`. |
| Validation | `apps/worker/src/rag/runbook-corpus-validation.ts` | `validateStoredRunbookChunks` — worker-local re-export target, not yet in the shared package. |
| Shared contract | `packages/agent-runtime/src/rag/runbook-retriever.ts` | `RunbookRetriever`, `RetrievalInput`, `StoredRunbookChunk`, `RetrievedRunbookChunk`, `RetrieverError` already live here — this is the intended shared seam. |
| Orchestrator | `packages/agent-runtime/src/agent/agent-orchestrator.ts` | Accepts an optional `retriever` + `retrievalInput`; when both are present it calls `retriever.retrieve()`, validates input/output, emits `RETRIEVAL_COMPLETED`, and produces `RAG_CHUNK`-sourced evidence. Fully retriever-agnostic already — no orchestrator change needed. |
| API wiring | `apps/api/src/execution/agent-runtime.module.ts` | Constructs `AgentRunService` via `createAgentRunService(repository)` with **no retriever** — confirmed by its own comment: "No live provider/retriever is wired anywhere in this module." |
| Service seam | `packages/agent-runtime/src/persistence/agent-run-service.ts:820` | Already threads `params.retriever` through when present — the seam exists; API-side caller just never supplies one. |
| Docker exclusion | `.dockerignore:22-28`; `Dockerfile` (`deps`/`prod-deps`/`build`/`runtime` stages) | `runbooks` is explicitly `.dockerignore`d "not runtime dependencies of the deployed API." `packages/agent-runtime/dist` **is already** copied into the runtime image (`Dockerfile:68`) — no new COPY needed for code, only for the `runbooks/` data directory itself. |
| Report rendering | `apps/web/src/components/ReportPanel.tsx` | Already renders any `evidence[].sourceType` (including `RAG_CHUNK`) grouped by claim — no change needed. |
| Trace rendering | `apps/web/src/trace/trace-product-labels.ts` | Already handles `RETRIEVAL_COMPLETED` — no change needed. |
| Docs | `docs/08-cicd-deployment.md` §17/§23 | States plainly "the deployed FAKE-provider path performs zero runbook retrieval" and enumerates `runbooks/`, retriever wiring as absent from the deployed image. Needs updating once true. |
| README | `README.md` Roadmap section, "Repository capability vs public demo" table | Roadmap narrative is stale (still describes M9 as in-progress; #39/#41/#55-60 already merged). "Browser/API RAG" row says "Unavailable." Both need updating as part of this issue (§7 of acceptance criteria). |

## 2. Design

### 2.1 Package relocation (`apps/worker/src/rag/*` → `packages/agent-runtime/src/rag/*`)

Move:
- `in-memory-runbook-retriever.ts` (+ its test) — verbatim, no logic change.
- `markdown-runbook-loader.ts` (+ its test) — verbatim, no logic change.
- `runbook-corpus-validation.ts` (+ its test) — verbatim, no logic change.
- `load-default-runbook-corpus.ts` (+ its test) — **NOT verbatim; module-system fix required.**

`voyage-embedding-client.ts` / `voyage-runbook-retriever.ts` **stay in `apps/worker`** — out of scope
(§5), and moving them would pull `voyageai` into `packages/agent-runtime`'s dependency graph, which
`apps/api` would then also carry even though it never uses it (`docs/08-cicd-deployment.md` already
polices `voyageai` staying worker-only).

**Round-1 review finding (BLOCKER, confirmed real): `import.meta.url` cannot survive the move
unchanged.** `packages/agent-runtime` compiles with `tsconfig.build.json`'s `"module": "Node16"` and
carries no `"type": "module"` in its `package.json` (confirmed: both files read directly), so
TypeScript emits its `dist/` output as CommonJS. `import.meta` is a syntax error in CommonJS output —
the package fails to build at all, blocking both `apps/api` and the production image. `apps/worker`,
by contrast, is genuinely ESM (`"type": "module"` in its own `package.json`), which is exactly why
the original file worked unmodified where it lived.

**Fix:** replace `resolveDefaultRunbooksDir()`'s `import.meta.url`-based resolution with `__dirname`
(valid only in CommonJS output — matches the target package's actual compiled module system) before
moving the file. Re-verify the path-depth arithmetic against `__dirname`, which points at the same
physical directory `import.meta.url` did (compiled `dist/rag/`), so the depth count itself is
unaffected — only the API used to obtain that starting directory changes:

- Dev/test (via `tsx`, which executes `src/` and supports both module forms — verify `__dirname`
  resolves correctly under `tsx`'s CommonJS interop at implementation time, since this is the one
  part of the fix not already proven by an existing code path elsewhere in the repo): `packages/
  agent-runtime/src/rag/` → 4 up → repo root.
- Production (compiled `dist/`): `packages/agent-runtime/dist/rag/` → 4 up → `/app` (the Dockerfile's
  `WORKDIR`) → `+ runbooks` → `/app/runbooks`, requiring `/app/runbooks` to exist in the image (§2.3).

`packages/agent-runtime/package.json` gains no new runtime dependency (the moved files use only
`node:fs`, `node:path`, and the package's existing `zod`/internal imports; `node:url` is dropped along
with `import.meta.url`).

`apps/worker/src/rag/index.ts` changes from locally defining these exports to re-exporting them from
`@opspilot/agent-runtime`, the same pattern it already uses for `RetrieverError`,
`validateRetrievalInput`, etc. (lines 1–18 of that file today). Net effect on `apps/worker` callers:
none — every existing import path into `./rag` from within `apps/worker` is unchanged.

**Round-2 review finding (BLOCKER, confirmed real): the moved code must also be added to
`packages/agent-runtime/src/index.ts`'s own public barrel.** `packages/agent-runtime/src/index.ts`
(the package's sole public entry point, confirmed) currently exports none of
`loadDefaultRunbookCorpus`, `resolveDefaultRunbooksDir`, `InMemoryKeywordRunbookRetriever`,
`MarkdownRunbookCorpusLoader`, `RunbookLoadError`, or `validateStoredRunbookChunks` — moving the files
into `packages/agent-runtime/src/rag/` makes them available *inside* that package, but neither
`apps/worker`'s re-export nor `apps/api`'s new `AgentRuntimeModule` wiring (§2.2) can reach them
without a corresponding barrel entry. This file documents and enforces a specific
alias-import/plain-const convention for every VALUE export (`import { X as _X } ... export const X =
_X`, never a bare `export { X } from "./y"`) because named re-exports compile to CommonJS getters that
Vitest's SSR/CJS interop does not reliably forward (file header comment, confirmed) — the six moved
value exports must follow this exact same convention, not an ordinary re-export, or they read back as
`undefined` under Vitest even though `Object.keys()` lists them. Type-only exports
(`MarkdownRunbookCorpusLoaderOptions`, `RunbookCorpusLoader`, `RunbookCorpusLoadResult`,
`RunbookLoadErrorCategory`) use the ordinary `export type {...} from "./y"` form, matching every other
type export already in this file.

### 2.2 API wiring

**Round-1 review finding (BLOCKER, confirmed real): the plan's original call shape does not exist.**
`createAgentRunService(repository: AgentRunRepositoryInterface): AgentRunService` (confirmed at
`agent-run-service.ts:665`) takes exactly one parameter — there is no second-argument config object,
and no module-construction-time place to install a retriever. Grepping the actual data flow:
`retriever`/`retrievalInput` are fields read per-call inside `executeAndPersist(params)`
(`agent-run-service.ts:820-821`, forwarded into the orchestrator only when present), and
`ExecuteAndPersistParams` is `Omit<AgentOrchestratorParams, "initialConversation" | "provider">` —
i.e. this is a **per-run parameter**, supplied fresh on every `agentRunService.executeAndPersist(...)`
call, not a service-construction-time dependency. `apps/api/src/agent-runs/agent-runs.controller.ts`
currently calls `executeAndPersist({ jobId, providerMode, modelIdentifier, createProvider })` for both
the FAKE (line 177) and LIVE (line 305) run-creation endpoints, supplying neither field today.

**Corrected design:** the retriever is a **controller-level dependency** (constructed once, e.g. via
the same NestJS provider pattern as today's `AGENT_RUN_SERVICE`/`TOOL_REGISTRY` tokens — a new
`RUNBOOK_RETRIEVER` token in `execution.tokens.ts`, built in `AgentRuntimeModule` from
`loadDefaultRunbookCorpus()` once at module-init), injected into `AgentRunsController`, and passed
into `executeAndPersist(...)` on every call site (both FAKE and LIVE).

**Round-2 review finding (MAJOR, confirmed real): `retrievalInput` cannot become a job-derived
function on `AgentOrchestratorParams` itself.** `AgentOrchestratorParams.retrievalInput` (confirmed at
`agent-orchestrator.ts:91`) is typed as a concrete `RetrievalInput` — the orchestrator calls
`params.retriever.retrieve(retrievalInput)` directly and has no `AgentJobRecord` in scope to resolve a
factory against; extending this contract to accept `(job: AgentJobRecord) => RetrievalInput` would
advertise a shape the orchestrator itself cannot execute, and reopens the "no orchestrator/contract
change" scope boundary (§5) the original plan explicitly meant to hold. **Fix:** leave
`AgentOrchestratorParams.retrievalInput: RetrievalInput` completely unchanged. Instead, give
`ExecuteAndPersistParams` (which already `Omit`s and can re-add fields relative to
`AgentOrchestratorParams`, per its existing type definition) its own, separately-named field —
e.g. `retrievalInputFactory?: (job: AgentJobRecord) => RetrievalInput` — resolved entirely inside
`agent-run-service.ts`, immediately after `started.job` becomes available (the same authoritative
locked read `executeAndPersist` already performs), into a concrete `RetrievalInput` before it is ever
passed down into `runAgentOrchestrator`. The orchestrator's own contract and every existing direct
caller of `runAgentOrchestrator` (e.g. worker's demo/eval scripts, which pass a concrete
`RetrievalInput` today) are completely unaffected.

**Corpus load failure at startup:** `loadDefaultRunbookCorpus()` can throw `RunbookLoadError` (e.g.
`DIRECTORY_NOT_FOUND` if `runbooks/` didn't make it into the image). This must fail container startup
loudly (uncaught at module init, same posture as every other fail-closed config check in this
codebase — e.g. live-Claude config validation) rather than silently constructing the module with no
retriever. A silent fallback would exactly reproduce today's invisible gap under a new disguise (looks
wired, isn't).

### 2.4 Deterministic FAKE scenario must become retrieval-aware (new — not in the original plan)

**Round-1 review finding (BLOCKER, confirmed real): wiring a retriever without touching the FAKE
scenario breaks every matching FAKE run.** `deterministic-scenario.ts` builds `FakeAgentScenario`
entirely upfront as a pure function of `job` (§12.1's stated invariant), and its scripted first turn
unconditionally declares `continuationReason: "NO_EVIDENCE_YET"` (line 152-156). Once a retriever is
wired and a ticket's summary happens to match a seeded runbook, the orchestrator's own V0 consistency
guard (`agent-orchestrator.ts:577-589`, confirmed) computes
`hasRunEvidence = successfulToolExecutionIds.size > 0 || allowedRagChunkIds.size > 0` — a non-empty
retrieval result makes `hasRunEvidence` true — and rejects the scripted `NO_EVIDENCE_YET` claim as
`PROVIDER_PROTOCOL_INVALID`, failing the run outright before the tool call or report submission ever
happen. This is not a corner case: it is the exact scenario acceptance criterion #3 requires
(a matching ticket producing `RAG_CHUNK` evidence) — as originally planned, satisfying that criterion
would have been mechanically impossible without this fix.

**Round-2 review finding (MAJOR, confirmed real): a resolver on the first turn alone cannot get a RAG
citation into the final report.** `createDeterministicScenario` builds its `report` object once, as a
static value, entirely before the `turns` array is constructed (confirmed: `report` at line 71-136 is
built from `job`-derived data only, closed over by the second, still-static `{ kind:
"report_submission", rawInput: report }` turn). Retrieval only happens at runtime, inside the
orchestrator, turn-by-turn — the first-turn resolver sees `input.conversation`'s `rag_context` entry,
but has no way to mutate the already-closed-over `report` object for the *second* turn without making
the resolver stateful (violating the pure-function-of-inputs contract `FakeProviderTurnResolver`
requires, and this file's own documented purity invariant, §12.1).

**Fix:** make **both** turns resolver functions, not just the first. Each resolver independently
derives whatever RAG-dependent content it needs from its own `AgentTurnInput.conversation` argument at
call time — the first turn's resolver already does this for its `rawAssessment` (§2.4, round 1's fix);
the second (report-submission) turn's resolver performs the identical `rag_context` lookup on its own
`input.conversation` and builds a *fresh* report value on every invocation: the same static report
`deterministic-scenario.ts` already computes today, with one `RAG_CHUNK` evidence entry appended when
(and only when) a `rag_context` entry is present, referencing that exact retrieved `chunkId`. Neither
resolver reads or mutates any variable the other resolver wrote — each is independently referentially
transparent given its own `AgentTurnInput`, satisfying `FakeProviderTurnResolver`'s contract and this
file's stated purity invariant without introducing shared mutable state.

If absent (no runbook match for this ticket's summary): both resolvers produce exactly today's
unmodified output — the honest "should genuinely still be zero evidence" case (§4 no-match test case),
not a fallback to paper over.

This keeps `createDeterministicScenario` a pure function of its inputs (`job` plus, now, each turn's
own `conversation` at invocation time — no clock/randomness/network added, no shared mutable state
between the two resolvers) and keeps the "status-agnostic, cannot see what the tool will really
return" invariant this file already documents (lines 47-65) fully intact — the RAG citation only ever
states what the retriever actually returned, never speculates about tool output.

### 2.3 Docker image

- Remove `runbooks` from `.dockerignore`.
- Add `COPY runbooks runbooks` to the Dockerfile's `runtime` stage (alongside the existing
  `COPY --from=build .../dist` lines), landing at `/app/runbooks` — matching §2.1's path-depth
  analysis.
- Update the `.dockerignore` comment (currently states "not runtime dependencies... must never reach
  the image," citing `docs/08-cicd-deployment.md` §23) to reflect the new state, and update
  `docs/08-cicd-deployment.md` §17/§23 itself (the acceptance criteria in the issue already calls
  this out).
- No change to the `deps`/`prod-deps` stages (those copy `package.json` manifests only, unaffected).

## 3. Compatibility

- **Worker behavior:** unaffected. Same retriever class, same loader, same corpus, same test
  expectations — only the file's package location and its re-export path change. Worker's own
  `demo:rag`, `eval`, and existing unit tests must pass unmodified in intent (moved test files keep
  their existing assertions).
- **API's existing FAKE/approval-demo integration tests:** these currently run with an implicit
  `retriever: undefined`. Once a real retriever is wired, `createDeterministicScenario`'s §2.4 fix
  ensures any ticket summary that does NOT match a seeded runbook keeps its exact current evidence
  shape (`TOOL_EXECUTION` only) — so the approval-demo ticket (`TICKET-APPROVAL-DEMO`, whose summary
  is not one of the runbook seed topics) and any other non-matching fixture ticket are unaffected by
  default. Any *new* test fixture deliberately chosen to match a seeded runbook topic will show the
  added `RAG_CHUNK` entry — expected and asserted on, not accidental drift. This is not a schema
  compatibility problem (the schema already supports mixed evidence sources; see
  `packages/contracts/src/evidence.ts`'s `EvidenceSourceTypeSchema = z.enum(["RAG_CHUNK",
  "TOOL_EXECUTION"])`) — it is a scenario-fixture-selection question, resolved by §2.4's match/no-match
  branching rather than left as an open risk.
- **Stored/legacy reports:** no schema or persistence-shape change at all in this issue — purely a
  wiring change on the write path going forward. Every existing read-compatibility invariant
  (`evidenceState` absent/present, `supports` optional) is untouched.

## 4. Verification plan — and an explicit limit of what it can prove

| Case | Expected |
| --- | --- |
| Worker: `InMemoryKeywordRunbookRetriever`, `MarkdownRunbookCorpusLoader`, `runbook-corpus-validation` unit tests, run from their new `packages/agent-runtime` location | All pass unmodified in intent |
| `load-default-runbook-corpus`'s `resolveDefaultRunbooksDir()`, rebuilt on `__dirname` | New/updated unit test confirms it resolves to repo-root `runbooks/` from both `tsx`-executed `src/` and built `dist/` |
| Worker: `demo:rag`, `eval` scripts | Run successfully via the new re-export path in `apps/worker/src/rag/index.ts` |
| `createDeterministicScenario`, ticket summary matching a seeded runbook | Tool-request turn's `continuationReason` truthfully cites the retrieved chunk (not `NO_EVIDENCE_YET`); run reaches `COMPLETED`; `report.evidence` contains a `RAG_CHUNK` entry; `RETRIEVAL_COMPLETED` trace event present |
| `createDeterministicScenario`, ticket summary matching no seeded runbook | Unchanged: `NO_EVIDENCE_YET`, `TOOL_EXECUTION`-only evidence, run reaches `COMPLETED` exactly as today |
| API: `AgentRunsController` → `executeAndPersist` wiring, unit/integration level | Retriever + job-derived `retrievalInput` factory both reach the orchestrator on both the FAKE and LIVE call sites |
| API: existing demo/approval integration tests (`TICKET-APPROVAL-DEMO` and other non-matching fixtures) | Pass unchanged — §2.4's no-match branch keeps their evidence shape exactly as today |
| API: corpus-load-failure path (simulate `runbooks/` missing) | Module construction throws / container fails to start — never falls back to a silently retriever-less service |
| `packages/agent-runtime` clean build (`pnpm --filter @opspilot/agent-runtime run build`) | Succeeds with no `import.meta` CommonJS emit error |
| Docker: build the image locally, confirm `/app/runbooks` exists and `docker run` health check passes | Manual local verification step (this repo's harness does not provision Docker automatically — `agent:verify --final` explicitly excludes Docker-smoke, per `CONTEXT.md`'s Final Verification definition) |

**What this cannot prove:** that the deterministic keyword retriever's ranking is *good* — i.e. that
it surfaces the right runbook for a given real support ticket. That is a retrieval-quality question,
not a wiring-correctness question, and this issue is scoped to wiring only. `docs/07-evaluation-plan.md`
already has cases exercising retrieval quality against the worker path; no new evaluation category is
proposed here. If retrieval quality in the deployed path becomes a concern later, the existing
evaluation harness is the right place to extend, not a new ad hoc check invented for this issue.

## 5. Out of scope (explicit)

- `VoyageRunbookRetriever` / semantic embedding search in any path (worker or API, FAKE or LIVE).
- Any change to `RETRIEVAL_COMPLETED`'s trace-event fields (stays `chunkId`/`rank`/`score` only — no
  title/content added for browser display, per prior owner confirmation in chat).
- Expanding the runbook corpus beyond the existing 5 seed documents.
- Any change to `RunbookRetriever`, `RetrievalInput`, `RetrievedRunbookChunk`, or their validation
  functions in `packages/agent-runtime/src/rag/` — these are stable and already correct.
- Any change to the agent orchestrator's two-turn loop, tool-call budget, or approval workflow.
- LIVE-specific retrieval behavior, cost accounting, or safeguards: §2.2's corrected design wires the
  same retriever + retrievalInput factory into both the FAKE and LIVE `executeAndPersist` call sites
  (retrieval itself carries no per-call external cost — the corpus is loaded once at startup and
  scored in-memory), so LIVE runs get real citations too, but no new LIVE-only behavior is added.
- Any change to `deterministic-scenario.ts`'s report content for tickets that do NOT match a seeded
  runbook — §2.4's no-match branch is required to be byte-for-byte identical to today's behavior.

## 6. Sequencing

1. Move the four worker RAG files (+ tests) into `packages/agent-runtime/src/rag/`, fixing
   `resolveDefaultRunbooksDir()` to use `__dirname` instead of `import.meta.url` as part of the move
   (§2.1). Add all six moved value exports to `packages/agent-runtime/src/index.ts`'s barrel using its
   existing alias-import/plain-const convention (§2.1, round 2), plus the four type-only exports via
   ordinary `export type {...}`. Update `apps/worker/src/rag/index.ts` to re-export from
   `@opspilot/agent-runtime`. Run worker + agent-runtime test suites, and
   `pnpm --filter @opspilot/agent-runtime run build` specifically, to confirm the CommonJS build
   actually succeeds before touching `apps/api`.
2. `createDeterministicScenario`: convert **both** turns to `rag_context`-aware resolvers (§2.4).
   Test-first: write the matching-ticket integration test against today's unmodified scenario, confirm
   it fails with `PROVIDER_PROTOCOL_INVALID`, then apply the fix and confirm it passes with a
   `RAG_CHUNK` entry actually present in the persisted report. Write the no-match regression test
   confirming byte-identical behavior to today.
3. Add the `RUNBOOK_RETRIEVER` provider token + `AgentRuntimeModule` wiring (§2.2); add
   `ExecuteAndPersistParams`'s own `retrievalInputFactory?: (job: AgentJobRecord) => RetrievalInput`
   field (resolved inside `agent-run-service.ts` against `started.job`, `AgentOrchestratorParams`
   itself unchanged); update `AgentRunsController`'s FAKE and LIVE call sites to supply the retriever
   and factory.
4. Run full existing API integration suite; confirm non-matching fixtures (`TICKET-APPROVAL-DEMO`,
   etc.) are unaffected per §2.4's no-match guarantee — no fixture should need updating if the no-match
   branch is implemented correctly.
5. `.dockerignore` + `Dockerfile` changes; local `docker build` + `docker run` smoke check confirming
   `/app/runbooks` exists and the container starts (proving the corpus-load-failure path doesn't
   trigger).
6. Update `docs/08-cicd-deployment.md` §17/§23 and `README.md` (Roadmap section + capability table)
   to reflect the new state.
7. `agent:verify --final`, `agent:review-bundle`, `agent:codex-review` per the standard harness cycle.
   This plan has already spent this issue's default review-closure budget of one initial review plus
   one final re-review (`CONTEXT.md`) across two rounds of plan-level review; the harness cycle run
   against the actual implementation diff is a new, code-level review pass, not a third plan-level
   round.

## 7. Acceptance criteria

1. `packages/agent-runtime/src/rag/` contains the retriever/loader/validation code, building cleanly
   as CommonJS (`__dirname`-based path resolution, no `import.meta`), and every moved symbol is
   reachable through `packages/agent-runtime/src/index.ts`'s public barrel using its existing
   alias-const convention; `apps/worker` imports it via re-export with no behavior change.
2. `createDeterministicScenario`'s both turns (tool-request and report-submission) independently and
   statelessly cite real retrieved chunks (truthful `continuationReason`, added `RAG_CHUNK` evidence
   entry in the actually-persisted report) when a ticket's summary matches a seeded runbook, and are
   byte-identical to today's behavior when it does not.
3. A `RUNBOOK_RETRIEVER` dependency is constructed once at API startup from the default runbook corpus
   and reaches the orchestrator via `executeAndPersist` on both the FAKE and LIVE call sites, with
   `retrievalInputFactory` resolved against the authoritative locked job inside `agent-run-service.ts`
   (never inside the orchestrator itself); a corpus-load failure fails container startup loudly rather
   than silently omitting the retriever.
4. A new integration test proves at least one deployed-path (FAKE-provider) scenario, using a ticket
   summary matching a seeded runbook, produces a `COMPLETED` run with `RAG_CHUNK` evidence in
   `report.evidence` and a `RETRIEVAL_COMPLETED` trace event.
5. All pre-existing API integration tests pass with no fixture changes required (per §2.4's no-match
   guarantee) — any fixture that unexpectedly needs a change is a signal the no-match branch is not
   implemented correctly, not something to paper over with an updated expectation.
6. `runbooks/` is present in the production Docker image; local `docker build`/`docker run` confirms
   the API can load the corpus at container startup.
7. `docs/08-cicd-deployment.md` and `README.md` (Roadmap + capability table) are updated to state the
   new, true capability boundary.
