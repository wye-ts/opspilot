# Issue #126 — a billed in-flight run must leave a ledger entry

| | |
| --- | --- |
| Scope | #126 "a billed in-flight run vanishes from the artefact if the process dies mid-run" — measurement-apparatus only, no product code |
| Basis | `main` @ `91bd55f` (#128), working tree clean |
| Status | Plan only. No repository source modified, no commit, push, PR, merge, or deploy. No provider/LIVE request. |
| Branch | `fix/126-in-flight-run-ledger` (created, holds this document only) |
| Committed location | `docs/reviews/50-issue-126-in-flight-run-ledger-plan.md` |

---

## 0. Current-state findings — verified against source

| Area | File / line | What it does today |
| --- | --- | --- |
| Outcome recorded | `measure-completion-rate.ts:820, 862, 900` | three `outcomes.push` sites, **all after** the orchestrator returns |
| Request dispatched | `:747` | `await runAgentOrchestrator({...})` |
| Enclosing try | `:734` | the whole run body |
| Artefact flushed | `:842, 885, 913, 924, 933` | after every run, and on the void/empty-sample throw paths |
| Report-bearing filter | `:931` | `outcomes.filter((o) => o.status !== "excluded")` |
| Tally predicates | `:948-959` | `completed`, `schemaInvalid`, `nonReportBearing`, `healed` |

**The gap is `:747` → `:820`.** A request is dispatched — and may be billed — with nothing on disk
naming that run. A process killed in that window leaves an artefact showing runs `1..N-1` that reads
as complete.

This is narrower than the artefact-persistence defect #122 already fixed (which flushed only at the
end). Flushing after every run bounded the loss to one run; it did not eliminate it.

### 0.1 Why the missing entry is not "a run that did not happen"

`run-provider-usage-collector.ts` documents that `CONNECTION` may mean the request **was** processed
and the response is what got lost. So a crashed run's outcome is **unobserved, not absent** — it may
have been billed, and may even have produced a report nobody saw. The ledger entry must say exactly
that and no more.

---

## 1. Design

### 1.1 Write a provisional entry before dispatch, replace it after

```
i-th run:
  outcomes.push({ ...ticket facts..., status: "in_flight" })   // BEFORE :747
  writeArtefact(artefact)                                      // flush, so a crash preserves it
  → dispatch
  ← orchestrator returns
  outcomes[index] = { ...real outcome... }                     // REPLACE, never a second push
  writeArtefact(artefact)
```

Replacement by index, not a second `push`. A crash-window entry and its resolved outcome are the
same run; appending both would double-count a billed invocation in every denominator — the exact
class of error this issue exists to prevent, inverted.

### 1.2 `in_flight` must be excluded from every derived figure — the load-bearing risk

`:931` computes `reportBearing` as `status !== "excluded"`. An `in_flight` entry satisfies that, so
a surviving one would **silently inflate the report-bearing denominator**. The same applies to
`outcomes.length`, which is the end-to-end denominator.

In the normal path no `in_flight` survives — each is replaced before the summary runs. But the
summary is also reached on the void and empty-sample throw paths, and a future edit could add
another. **Correctness must not depend on "it can't happen."**

Decision: derive every figure from a single `resolved` array, computed once:

```
const resolved = outcomes.filter((o) => o.status !== "in_flight");
```

and use `resolved` for `reportBearing`, both denominators, and all four tallies. The skill's rule —
"the tally predicate and the exclusion predicate must be the same expression" — applies here: one
filter, hoisted, not repeated inline five times.

If `resolved.length !== outcomes.length` at summary time, that is a real anomaly: print how many
entries are unresolved and state that they were dispatched and may have been billed. Do not
silently drop them.

### 1.3 What the entry carries

Only facts known before dispatch: `ticketId`, `ticketSummary`, `ticketParameters`, plus
`status: "in_flight"`. The remaining `RunOutcome` fields describe a result that does not exist yet.

`RunOutcome` currently requires `validationMessages`, `autoCompletedEvidence`, `retrievedChunkIds`,
`toolCallsMade`. An `in_flight` entry has none of them. **Decision:** populate them as empty rather
than widening the type — an empty array reads as "nothing recorded" and keeps the artefact's shape
uniform for any consumer, whereas making four fields optional would let a *resolved* outcome omit
them by accident.

`status` is already `string`, so no type change is needed. That is convenient and also a weakness
worth noting: nothing stops a typo'd status. Out of scope here (§4).

### 1.4 The scoring rule in the artefact must describe this

`:660-680` persists a `scoringRule` object that a later reader trusts over the source. It currently
describes `completed` / `excluded` / `voided`. It must gain `in_flight`, worded to state what such
an entry means: **the run was dispatched and may have been billed; its outcome is unknown because
the process did not survive to record it.** Never "the run did not happen."

### 1.5 `schemaVersion`

Currently `2` (`:642`). Adding a new `status` member changes what a consumer must handle: code
filtering on `status` will now see a value that did not previously exist. Bump to **3**.

---

## 2. What this deliberately does NOT do

- **No product-code change.** This is the measurement apparatus. No contract, reducer, persistence,
  or orchestrator edit is reachable from this scope.
- **No retry or recovery of an interrupted run.** The entry records that the round died there; it
  does not attempt to resume. Resuming would re-dispatch a possibly-billed request.
- **No change to the exclusion/voiding dispositions** established in #122.
- **No LIVE run.** The behaviour is verifiable with a fake provider and a simulated crash.

---

## 3. Verification plan — and its limits

| # | Case | Expect |
| --- | --- | --- |
| 1 | Normal run | exactly one entry per run; no `in_flight` in the final artefact |
| 2 | Entry exists before dispatch | artefact on disk at dispatch time contains an `in_flight` entry for that ticket |
| 3 | Resolution replaces, never appends | after N runs, `outcomes.length === N` |
| 4 | Crash mid-run | the surviving artefact carries `in_flight` for exactly the interrupted run, and the runs before it unchanged |
| 5 | `in_flight` excluded from denominators | a hand-built outcome list containing one `in_flight` yields tallies computed over `resolved` only |
| 6 | Unresolved entries are reported | summary states how many were dispatched-but-unresolved rather than dropping them |
| 7 | `scoringRule.in_flight` present and correctly worded | asserts "may have been billed", and that it is not described as a run that did not happen |
| 8 | `schemaVersion` is 3 | pinned |

Case 4 is the one that actually proves the issue is fixed, and it must simulate the crash for real
(dispatch a provider that kills the loop mid-run), not assert the code path by inspection.

Cases 3 and 5 must be shown to **fail** against pre-change behaviour before being trusted green.

**What this cannot prove:** whether an interrupted run was in fact billed. Nothing client-side can
establish that — which is precisely why the entry must be worded as *unobserved*.

---

## 4. Out of scope, stated so it is visible

- **`RunOutcome.status` is an open `string`.** A closed union would make `in_flight` and every other
  status typo-proof and would have made §1.2's risk a compile error. Worth doing; it touches every
  push site and the tally predicates, so it is its own change, not a rider on this one.
- #124 (trace carries no tool inputs/outputs) and #127 (harness test timeouts) are unaffected.
- #123 remains deferred per its own comment.

---

## 5. Sequencing

1. Add the `in_flight` push + flush before `:747`; replace by index at all three resolution sites.
2. Hoist `resolved` and route every denominator and tally through it (§1.2).
3. `scoringRule.in_flight` + `schemaVersion: 3`.
4. Tests 1–8. Prove 3 and 5 red against pre-change behaviour.
5. `pnpm --filter @opspilot/worker run test`, `typecheck`, `build`, bundle guard, `lint` — on
   `.nvmrc`'s Node 22.21.0.
6. `agent:review-bundle` + `agent:codex-review`; adjudicate; re-review to zero findings.

`agent:verify --final` is expected to fail at `pnpm test` for the pre-existing reason filed as #127;
report it as such rather than as this branch's result, and run the steps it skips standalone.

---

## 6. Acceptance criteria

1. A provisional entry is on disk before any provider request for that run is dispatched.
2. Resolution replaces that entry in place; `outcomes.length` equals the number of runs attempted.
3. No `in_flight` entry contributes to the end-to-end denominator, the report-bearing denominator,
   or any tally.
4. An artefact surviving a mid-run crash carries `in_flight` for exactly the interrupted run.
5. The summary reports unresolved entries rather than dropping them silently.
6. `scoringRule` describes `in_flight` as dispatched-and-possibly-billed with an unknown outcome,
   and no line anywhere describes it as a run that did not happen.
7. `schemaVersion` is 3.
8. No file outside `apps/worker/src/demo/` and `docs/` is modified.
9. Independent review reaches zero findings against the final head SHA.

---

See #126 for the filed issue, `docs/reviews/48` for the measurement whose losses motivated it, and
`docs/reviews/49` for the runtime guard that protects the same spend.
