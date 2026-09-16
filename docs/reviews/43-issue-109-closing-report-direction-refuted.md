# Issue #109 — closing report: the grammar-narrowing direction is refuted

| Field | Value |
| --- | --- |
| Verdict | **Direction abandoned.** Not "this attempt failed" — the approach itself does not fit the provider's constraints. |
| Basis | Three encodings, each refuted by measurement against the live Anthropic API (§2). Stage 1: **0 of 5 real runs completed**. |
| Cost | ~$1 in live calls, one working day. |
| Shipped from this work | Nothing in `packages/`. One unrelated fix rescued (§5). |
| Production impact | **None.** Never merged, never deployed. `main` and tryopspilot.com are untouched throughout. |

---

## 1. What #109 set out to do, and why it was reasonable

The model submitted `evidence: []` while citing real observations it had actually made
(#109 run 3: both locators spelled correctly, both genuinely retrieved that run). Two cheap remedies
had already failed against the same rule — #80 rewrote the prompt in capitals, #101 added a
corrective retry — and `GROUNDED_BY_NOT_IN_EVIDENCE` still accounted for 4 of the 6 attributed
report-contract failures afterwards.

The idea was to stop *asking* the model to restate identifiers the harness already holds, and
instead narrow the tool's own input schema per run so the omission becomes ungrammatical. That
reasoning still looks right. What it did not survive is the provider's actual constraints.

## 2. Three encodings, three refutations — all measured, none argued

| # | Encoding | Outcome |
| --- | --- | --- |
| 1 | `evidence[].evidenceId` as a closed `enum` + `minItems: 1` | Accepted by the API, but **too weak**: it forces one entry and says nothing about *which*, so with two candidates the model can list one and ground an action on the other — the exact failure, unchanged. Caught by independent review. |
| 2 | `evidence` as a **tuple** (one fixed position per observation) | **Rejected outright**: `400 tools.0.custom: For 'array' type, property 'prefixItems' is not supported`. Every run that observed anything failed at the REQUEST stage. |
| 3 | `evidence` as an **object** keyed by `sourceType:evidenceId` | Accepted in isolation, but **exceeds the grammar-size budget** once the real request is assembled: `400 The compiled grammar is too large`. |

### 2.1 The measurement that ended it

Encoding 3's ceiling depends on what else the request carries, because the limit applies to the
whole tool set — not to the report tool alone:

| tools sent | pinning survives to |
| --- | --- |
| report tool alone | n ≤ 6 |
| report tool + **one** diagnostic tool | n ≤ 4 |
| report tool + the **real** 2-tool catalog (production) | **n ≤ 1** |

Production retrieves `topK = 3` chunks *before the first investigation turn*, so **n ≥ 3 always**.
The pinned schema is therefore never offered on a real run: every run falls back to the unpinned
schema.

**The fix would have been inert in production — not low-coverage, zero-coverage.**

### 2.2 Stage 1 confirmed it end to end

5 real runs against the shipped build: **0 completed**, all `PROVIDER_UNAVAILABLE`, each one a
`REQUEST_INVALID` on the turn where the candidate set crossed the limit. The failure was not model
behaviour — the requests never reached the model.

## 3. Why this is a verdict on the DIRECTION, not on one attempt

Three encodings, three independent reasons: too weak, forbidden keyword, over budget. The common
factor is that F5 (`groundedBy ⊆ evidence`) is a **cross-array subset rule**, which JSON Schema
cannot state directly. Every encoding that expresses it by construction has to enumerate the
observation set — and enumeration is exactly what the grammar budget cannot afford alongside a real
tool catalog.

The budget is not a number this repo controls, and it gets *tighter* as the product grows: adding a
third diagnostic tool would lower the ceiling again. **A fourth encoding attempt should not be
made.** Recording this is the point of this document.

### What was NOT refuted

- The diagnosis in the plan's §0–§1 (the failure is real and correctly characterised).
- The principle that the harness should supply what it already knows.
- F5 itself, which was never modified and needs no change.

### One lever, deliberately declined

Dropping `strict` from the diagnostic catalog frees enough budget to reach n ≤ 4 (measured:
n=2,3,4 all accepted without it, all rejected with it). It was **not taken**: it weakens one
safety constraint to rescue an approach already shown to be poor value, and the remaining coverage
would still be partial. Recorded so it is a decision, not an oversight.

## 4. The process lesson, stated plainly

Both fatal findings came from **assuming a fragment represents the whole**:

1. A hand-written mini-schema was used to conclude the full generated schema would be accepted.
2. A single-tool probe was used to conclude the real 2-tool catalog would behave the same.

The second is the more embarrassing: the plan's own §2.4a retracts exactly this reasoning pattern,
and it was repeated anyway. A schema-acceptance gate eventually caught both — but it was itself
built on a fragment, which is why it passed 17/17 while the shipped build could not complete a
single real run.

**The rule this leaves behind:** a pre-flight check must send the *actual request shape a real turn
produces*, including every tool that turn carries. Anything less measures a request the product
never makes. This belongs in whatever replaces the gate.

## 5. What survives

- **`fix/verify-gate-node26-localstorage`** — unrelated to #109 and worth keeping: Node ≥26 ships a
  native `localStorage` getter that returns `undefined`, which vitest's jsdom injection then skips,
  breaking 4 web test files. `pnpm agent:verify --final` was **failing before this work started**
  and nobody had noticed. That is a repaired gate, not a #109 artifact.
- **This document**, and the plan's §2.4c/§2.4d retractions.
- **The `prefixItems` and grammar-size facts**, which constrain any future schema work in this repo.

## 6. What actually deserves the attention instead

The persisted population (36 LIVE runs) says #109 was never the biggest lever:

| outcome | count |
| --- | --- |
| `COMPLETED` | 10 |
| `REPORT_SCHEMA_INVALID` | 17 (only 6 carry attribution; #109 targeted 4 of those) |
| **provider transport failures** | **9 (25%)** |

**25% of runs fail below the report contract**, and no issue owns them. They cap every contract fix
at a ~75% ceiling — which is why #109's own release gate (≥8 of 10) would have been close to
uninformative even had the mechanism worked.

They are also the worse failure for a visitor: the public trial allows **one run per visitor per
day**, so a transport failure spends someone's only attempt on nothing at all — no investigation, no
report, nothing seen. See the follow-up issue for the recommended framing: rather than trying to
make a third-party API reliable, stop letting its failures consume the visitor's single attempt, and
distinguish "we could not reach the model" from "the investigation ran but its report was rejected"
in the UI.
