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
entries are unresolved and state that **a request was attempted for each, and whether it reached the
provider or was billed is unknown**. Do not silently drop them, and do not assert that they were
sent (§1.3a).

### 1.3a The entry marks an ATTEMPT, not a confirmed dispatch (round-1 review, MINOR — accepted)

The first draft of this plan described the entry as meaning "the run was dispatched and may have
been billed". **That is withdrawn**, because it overclaims in the same direction the plan exists to
prevent.

The provisional entry is written and flushed *before* `runAgentOrchestrator` is called. A process
killed between the artefact's `rename` and the first byte leaving the machine leaves an entry for a
request that was **never sent**. The window is small but it is exactly the window this feature
instruments, and the artefact must not assert something it cannot observe — the identical error to
calling a `CONNECTION` loss "a run that did not happen", just inverted.

The truthful reading is a three-way unknown, and every surface must carry it:

| What is known | What is NOT known |
| --- | --- |
| this run was about to be attempted, with these ticket facts | whether the request left the machine |
| the process did not survive to record an outcome | whether the provider received or billed it |

Wording to use throughout — entry semantics, `scoringRule`, the summary line, acceptance criteria
and tests:

> **"A run was attempted. Whether the request reached the provider, and its billing status, are
> both unknown."**

Note the phrasing avoids the words `dispatched` and `billed` in their verb forms deliberately —
see §1.3b for why that is a constraint on the text and not just a style choice.

This also means the entry cannot be used to derive a spend figure in either direction. It marks
where the round died and bounds the uncertainty; it settles nothing about cost.

### 1.3b The wording guard must ban the AFFIRMATIVE claim, not the word (round-2 review, MAJOR — accepted)

Round 2 caught the previous draft demanding two things at once: `scoringRule.in_flight` had to read
"…whether it **was billed**, is unknown", while test case 7 asserted the text must **not** contain
`"was billed"`. Literally unsatisfiable — an implementer would have gone red, and the cheapest
repair under pressure is deleting the billing-uncertainty sentence, i.e. removing the honesty the
rule exists to enforce.

This is the repo's own documented trap: a guard on prose must target the **asserted claim**, never
a bare word the retraction itself must use.

Both halves are fixed:

- **The approved sentence avoids the collision by construction** — "its billing status" rather than
  "whether it was billed", "a run was attempted" rather than "was dispatched".
- **The guard is a pair, not a blanklist.** A positive assertion that the required uncertainty
  sentence is present, plus a negative assertion aimed only at affirmative claims:

  | Must be present | Must be absent |
  | --- | --- |
  | `billing status` … `unknown` | `was billed` / `were billed` / `request was sent` |
  | `A run was attempted` | `did not happen` / `never happened` |

  The negative list is checked against the **approved sentence itself** first, as its own test: if
  the mandated wording trips its own guard, the guard is wrong. That assertion is what makes this
  class of contradiction impossible to reintroduce silently.

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
describes `completed` / `excluded` / `voided`. It must gain `in_flight`, carrying the §1.3a sentence
verbatim:

> **"A run was attempted. Whether the request reached the provider, and its billing status, are
> both unknown."**

plus the reason it exists — the process did not survive to record an outcome. Guarded per §1.3b: a
positive assertion on the required sentence, and a negative assertion aimed at affirmative claims
only.

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
| 2 | Entry exists before the provider is called | artefact on disk, read from inside a fake provider's first turn, already contains an `in_flight` entry for that ticket |
| 3 | Resolution replaces in place, never appends | the SAME array slot transitions `in_flight` → resolved status for that ticket, and `outcomes.length === N` (both halves asserted; see below) |
| 4 | Crash mid-run | the surviving artefact carries `in_flight` for exactly the interrupted run, and the runs before it unchanged |
| 5 | `in_flight` excluded from denominators | a hand-built outcome list containing one `in_flight` yields tallies computed over `resolved` only |
| 6 | Unresolved entries are reported | summary names the count and states the outcome is unknown — without claiming the request was sent or billed |
| 7 | `scoringRule.in_flight` present and correctly worded | **positive**: contains the §1.3a sentence (`billing status` … `unknown`, `A run was attempted`). **negative**: contains none of `was billed` / `were billed` / `request was sent` / `did not happen` / `never happened` |
| 8 | `schemaVersion` is 3 | pinned |
| 9 | Killed after the provisional write, before the provider call | the artefact makes no claim that a request was sent or billed (§1.3a) |
| 10 | The guard does not contradict its own mandated wording (§1.3b) | the approved §1.3a sentence is run through case 7's negative list and trips none of it |

Case 4 is the one that actually proves the issue is fixed, and it must simulate the crash for real
(a provider that kills the loop mid-run), not assert the code path by inspection.

**Case 3's length assertion alone is worthless — round-1 review, MINOR, accepted.** The current
code already performs exactly one `push` per run, so `outcomes.length === N` passes *before* the
change and cannot distinguish append-only from replace-in-place. The distinguishing observation is
the **transition**: one slot must be `in_flight` while the provider is executing and the resolved
outcome afterwards, with the length unchanged across both. Assert both states from inside a
controlled fake provider; the length check is a guard against a second push, not the evidence.

Cases 2, 3 and 5 must be shown to **fail** against pre-change behaviour before being trusted green —
case 3 via its transition assertion, not its length assertion.

**What this cannot prove:** whether an interrupted run was billed, or even whether its request left
the machine. Nothing client-side can establish either — which is precisely why §1.3a forbids the
artefact from asserting them.

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
3. `scoringRule.in_flight` + `schemaVersion: 3`, worded per §1.3a.
4. Tests 1–10. Prove 2, 3 and 5 red against pre-change behaviour — case 3 via its transition
   assertion, since its length assertion passes before the change. Write case 10 (§1.3b's
   self-check) FIRST: if the mandated wording trips its own guard, stop and fix the plan.
5. `pnpm --filter @opspilot/worker run test`, `typecheck`, `build`, bundle guard, `lint` — on
   `.nvmrc`'s Node 22.21.0.
6. `agent:review-bundle` + `agent:codex-review`; adjudicate; re-review to zero findings.

`agent:verify --final` is expected to fail at `pnpm test` for the pre-existing reason filed as #127;
report it as such rather than as this branch's result, and run the steps it skips standalone.

---

## 6. Acceptance criteria

1. A provisional entry is on disk before the provider is invoked for that run, observable from
   inside the provider itself.
2. Resolution replaces that entry **in the same array slot** — the slot's status transitions
   `in_flight` → resolved — and `outcomes.length` equals the number of runs attempted.
3. No `in_flight` entry contributes to the end-to-end denominator, the report-bearing denominator,
   or any tally.
4. An artefact surviving a mid-run crash carries `in_flight` for exactly the interrupted run.
5. The summary reports unresolved entries rather than dropping them silently.
6. `scoringRule` carries the §1.3a sentence verbatim, and **no line anywhere** — entry, scoring
   rule, summary, commit message or write-up — makes the affirmative claim that the request was
   sent, that it was billed, or that the run did not happen (§1.3a).
6a. The wording guard is a positive+negative pair and is proven not to contradict the sentence it
   mandates (§1.3b, test case 10).
7. `schemaVersion` is 3.
8. No file outside `apps/worker/src/demo/` and `docs/` is modified.
9. Independent review reaches zero findings against the final head SHA.

---

See #126 for the filed issue, `docs/reviews/48` for the measurement whose losses motivated it, and
`docs/reviews/49` for the runtime guard that protects the same spend.
