# Issue #109 — The model omits observations it actually made from `report.evidence`

| Field | Value |
| --- | --- |
| Scope | #109 "The model submits an empty evidence array while citing real observations" — the most common *attributed* report-contract failure (4 of 6; see §0.2), not the dominant cause of LIVE failures overall. |
| Basis | `main` @ `428e31c` (#107 merged via #110), working tree clean. Evidence: **all 36 persisted LIVE runs** in the local `agent_runs`/`agent_trace_events` tables, queried directly (§0); plus 3 rejected-report bodies captured with a temporary probe on 2026-09-15 (§1), which show the defect's shape but not its rate. |
| Status | Implementation complete; **mechanism verified against the live API** (§2.4d: 17/17 reachable run shapes accepted). Two encodings were refuted by measurement along the way (§2.4c, §2.4d) and the F5-unviolatable claim is withdrawn — see §2.4d for what ships. Model-compliance is UNMEASURED: Stage 1 not yet run. Not merged, not deployed. |
| Branch | `fix/109-harness-supplied-observations` |
| Committed location | `docs/reviews/42-issue-109-harness-supplied-observations-plan.md` |
| Depends on | Nothing unmerged. #107 (merged) is independent and does not change this diagnosis. |

---

## 0. Why the framing "the model keeps getting it wrong" is the wrong one

The natural reading of #109 is that the model is failing to follow an instruction. The persisted
data says something narrower and more useful, and it changes which fix is appropriate.

**Every number in this section comes from the local Postgres (`agent_runs`, `agent_trace_events`),
queried directly. An earlier draft of this plan built §0 and §1 on probe captures and
`docs/evidence/` files instead, and got several claims wrong; §0.5 records those retractions.**

### 0.1 F5 IS satisfiable by a real model — proven 5 times

This plan originally claimed F5 had "never been shown to be satisfiable by a real model." **That is
false and is withdrawn.** Persisted `COMPLETED` LIVE runs, with the count of `suggestedActions`
carrying a non-empty `groundedBy`:

| date | runs | `evidence` len | actions with `groundedBy` |
| --- | --- | --- | --- |
| 2026-08-12 | 5 | 1 | **0** of 2–3 |
| 2026-09-07 | 1 | 2 | 1 of 1 |
| 2026-09-15 | 4 | 5 | 1 of 1 |

The 2026-08-12 runs predate F5 (#60, 2026-08-15) and carry no `groundedBy` at all — they are *not*
evidence the rule works. The **5 runs on 2026-09-07 and 2026-09-15 are**: each grounded an action
and passed validation. A real model satisfies F5 routinely.

### 0.2 The real failure distribution, and how much of it #109 can reach

All 36 persisted LIVE runs:

| outcome | count |
| --- | --- |
| `COMPLETED` | 10 |
| `REPORT_SCHEMA_INVALID` | 17 |
| `PROVIDER_UNAVAILABLE` | 7 |
| `PROVIDER_TIMEOUT` | 1 |
| `PROVIDER_PROTOCOL_INVALID` | 1 |

**9 of 36 failures (25%) never reach the report contract at all** — provider transport, not
grounding. No change in this plan can move them, and they will appear inside any release-gate
sample.

Of the 17 schema failures, only **6 carry invariant attribution**; the other 11 predate #105, which
added attribution precisely because this question was unanswerable. Of those 6:

| violated invariant(s) | count |
| --- | --- |
| `GROUNDED_BY_NOT_IN_EVIDENCE` | **4** |
| `ACTIONABLE_REQUIRES_ACTION` | 1 |
| `ACTIONABLE_REQUIRES_ACTION` + `ROOT_CAUSE_WITHOUT_SUPPORTING_EVIDENCE` + `NON_SUFFICIENT_WITH_ROOT_CAUSE` | 1 |

**This plan targets the 4.** The other 2 are a different defect — a report claiming ACTIONABLE
without supplying an action — and nothing here touches them.

### 0.3 The honest strength of the case

`GROUNDED_BY_NOT_IN_EVIDENCE` is the single most common *attributed* report-contract failure, at
**4 of 6**. That is the real basis for acting, and it is a small sample. It is **not** "the dominant
cause of LIVE failures" (§0.2 shows a quarter of failures never reach the contract), and **not**
"the model cannot satisfy F5" (§0.1 shows it does, repeatedly).

The defensible statement: *when the model does fail the report contract for an attributable reason,
the most common reason by a clear margin is citing an id it never listed in `evidence` — and that
particular failure is one the harness can make unrepresentable, because the harness already knows
every valid id.*

### 0.4 Two cheap remedies have already failed against this same rule

- **#80** rewrote the prompt, in capitals, stating that any tool called must be listed in `evidence`.
- **#101** added a bounded corrective retry that re-prompts with the violated invariant.

`GROUNDED_BY_NOT_IN_EVIDENCE` still accounts for 4 of 6 attributed failures afterwards. **A third
prompt revision is the pattern to break, not to continue.**

### 0.5 Retractions — claims this plan previously made on weaker evidence

Recorded rather than silently edited, because each one was used to justify the design:

1. **"F5 has never been shown satisfiable by a real model."** False — §0.1, 5 runs.
2. **"The one successful LIVE run is 2026-08-01, n=1."** False — 10 persisted successes, including
   5 on 2026-08-12. The `docs/evidence/` file records *one documented* run, not the population.
3. **"`evidence: []` in 3 of 3 runs."** Unsupportable from persisted data: **failed runs do not
   persist their report at all** (`report IS NULL` for every failure). That claim came from a
   temporary probe's capture of 3 runs and cannot be generalised — on the same day, 4 runs
   completed carrying 5 evidence entries each.
4. **"Roughly a third completing, stable since F5."** The real rate is 10/36, and it mixes provider
   failures with contract failures; §0.2 separates them.
5. **"#107 helps 2 of 8 starved runs."** The 8-run figure was a probe subset, not the population.

The pattern behind all five: a probe's local capture was treated as the population. The persisted
tables are the population.

---

## 1. What the probe captured, and what it can support

Three failures captured with a temporary probe during 5 real LIVE runs on 2026-09-15 (probe
reverted, tree clean):

```
1. evidence=[]  groundedBy=[]
   INSUFFICIENT / ACTIONABLE, rootCause non-null
2. evidence=[]  groundedBy=[]
   SUFFICIENT / ACTIONABLE
3. evidence=[]  groundedBy=[["RAG_CHUNK:runbook-identity-provider-outage-002",
                             "TOOL_EXECUTION:toolu_01EBAvKNJg787D9wi8ZHEaeY"]]
   INSUFFICIENT / ACTIONABLE  -> F5 x2
```

**Scope of this evidence, stated up front.** These 3 captures are the only direct look at a
*rejected* report body that exists, because **failed runs persist no report** (`report IS NULL` for
every failure in `agent_runs`). They show the shape of the defect. They do **not** establish its
frequency — §0.2's attribution counts do that, and they are what the design rests on. An earlier
draft used these 3 captures as a rate ("3 of 3"); that is retracted in §0.5.

### 1.1 Run 3 is decisive, and it kills the index-based-grounding direction

Both locators in run 3 are **spelled correctly**: that RAG chunk id was genuinely retrieved that
run, and that `toolu_` id genuinely belongs to a successful tool call. The model mistyped nothing.
It cited real observations it had simply never listed in `evidence`.

`docs/reviews/40-issue-105-...-plan.md` §"Why not go straight at F5" floated making `groundedBy`
reference `evidence` **by index**, so a mismatch becomes unrepresentable. That fix assumes F5 is a
**transcription** error. It is not:

- with `evidence: []`, `groundedBy: [0]` is simply out of range — the same failure, new message;
- it would have spanned the TS contract, the generated Claude tool schema, the web UI, and the
  Python scorer (which builds identity keys as `f"{sourceType}:{evidenceId}"`,
  `scoring/scorer.py:108`), i.e. a cross-language semantic change;
- and it would have fixed nothing.

**Withdrawn explicitly**, so a future reader does not re-propose it.

This conclusion survives the retractions in §0.5: it rests on the *content* of one captured report,
which the probe does establish, not on how often that content occurs.

### 1.2 One omission explains all three captures

| symptom | same root |
| --- | --- |
| `SUFFICIENT` with zero evidence | claimed sufficiency, listed nothing |
| `ACTIONABLE` with zero actions | an action could not pass grounding, so the action was dropped |
| F5 locator not in evidence | cited a real observation never listed |

The second row deserves attention: the model appears to be **dropping suggested actions to escape a
grounding requirement it cannot satisfy**. The contract is pressuring it toward a strictly less
useful report — which is a product problem, not only a validation problem.

Note the independent corroboration in §0.2: `ACTIONABLE_REQUIRES_ACTION` appears in 2 of the 6
attributed failures. Those 2 are **out of scope** here — this plan does not claim to fix them — but
they are consistent with the same pressure, and are worth their own issue.

### 1.3 #107 is not the fix

All three captures used **2 diagnostic calls**, so a corrective retry was structurally available and
still did not rescue them. #107's headroom is real and worth having; it addresses a different
population. It must not be reported as addressing this.

---

## 2. Design

### 2.1 The observation set is already machine-known

At report time the orchestrator holds exactly the facts the model is failing to restate:

- `successfulToolExecutionIds` — every `toolCallId` that executed successfully;
- `allowedRagChunkIds` — every retrieved chunk id
  (`agent-orchestrator.ts`; both already gate `findInvalidEvidence`).

Every legal `(sourceType, evidenceId)` pair is **already known to the system**. The `evidence` array
currently asks the model to re-transcribe machine-known identifiers, and the only genuinely
model-supplied parts of each entry are `finding` (its interpretation) and `supports` (which claim it
backs).

**The omitted content is the part the system could supply itself.** That is the asymmetry this issue
should correct.

### 2.2 Bounded by construction

`topK` is validated to `1..5` (`rag/retrieval-validation.ts:7`) and `MAX_DIAGNOSTIC_TOOL_CALLS` is 3,
so the candidate observation set is **at most 8 entries per run**, against an `evidence` cap of 10.
The set can always be offered in full; no ranking, truncation, or selection policy is needed.

### 2.3 The constraint any fix must preserve

`evidence: []` is **deliberately legal** for `INSUFFICIENT` (#58 P1-3, anti-fabrication): a run that
gathered nothing must be able to say so truthfully rather than invent entries. Any fix making
`evidence` unconditionally non-empty trades one failure mode for fabrication pressure, which is
worse.

The legal-empty case is precisely "no diagnostic tool ran and nothing was retrieved" — **a condition
the harness can evaluate itself**, and exactly the condition under which the candidate set is empty.
So the rule falls out of the mechanism rather than needing separate enforcement.

### 2.4 Options, and the recommendation

Three directions were considered. **Recommendation: Option A, implemented via Option C's mechanism**
— the harness supplies the observation set, and it does so by narrowing the report tool's own input
schema per run (§2.4b), not by adding another message the model may ignore. Option B is recorded
with why it loses.

**Option A — harness-supplied observation set, model annotates (RECOMMENDED).**
The orchestrator presents the run's observations to the model as a closed, enumerated list; the model
supplies only `finding` and `supports` per entry, plus which entries it declines to cite and why it
is allowed to. The system, not the model, writes `evidenceId` and `sourceType` into the stored
report.

- Removes the omission failure mode entirely: an observation cannot be absent from `evidence` if the
  harness put it there.
- Removes F5's transcription surface as a side effect — `groundedBy` can only name locators the
  harness itself emitted.
- Preserves §2.3: when the candidate set is empty, `evidence` is empty, truthfully.
- **Storage shape is unchanged.** `runAgentOrchestrator` returns `parsedReport.data` and
  `finalizeCompleted` persists it (`agent-run-service.ts:645`); if the orchestrator assembles the
  same `EvidenceReference[]` shape from harness ids + model annotations, every downstream consumer —
  `ReportPanel.tsx`, the Python scorer's `f"{sourceType}:{evidenceId}"` keys, every persisted row —
  is untouched. This is the property that makes A affordable, and it must be verified before
  implementation (§4 case 7), not assumed.

**Option B — conditional structural requirement.** Make `evidence` non-empty only when the harness
knows a tool ran or chunks were retrieved. Smaller, and it does convert a silent wrong answer into a
loud rejection — but it only *detects* the omission. The model still has to produce the list it has
twice failed to produce, so the expected outcome is trading `REPORT_SCHEMA_INVALID` for a different
`REPORT_SCHEMA_INVALID`. **Rejected as a primary fix**; it is a reasonable fallback if A proves
unaffordable, and would then need its own real-model check.

**Option C — carry the requirement in the per-run tool schema rather than prose.**
Attractive because a schema constraint is not skippable like an instruction. An earlier draft of
this plan **rejected C on a mechanism claim that turned out to be false**, and the retraction is
recorded in §2.4a — `enum` and `minItems: 1` both survive `toStrictInputSchema`, so C is live and is
now folded into the recommendation below rather than dismissed.

### 2.4a Retraction: `toStrictInputSchema` does NOT strip the constraints this design needs

An earlier draft rejected Option C on the claim that `toStrictInputSchema`
(`claude-tool-schemas.ts:82`) "strips every numeric/length/count bound", so a schema-level
requirement would be silently dropped. **That claim was wrong and is withdrawn.**

Measured with a disposable probe against the real `toStrictInputSchema` (probe deleted, tree clean):

```
=== survival checks ===
evidenceId enum survived:  true
minItems survived (min(1)): true
maxItems stripped:          true
maxLength stripped:         true
minItems:2 stripped:        true
```

Reading `UNSUPPORTED_KEYS` (`claude-tool-schemas.ts:17-31`) confirms the mechanism: `enum` is not a
member, and `minItems` is stripped only when `value > 1` (line 58). So a generated schema **can**
pin `evidenceId` to a closed per-run set and **can** require at least one entry. The false claim
came from generalising `REPORT_FIELD_BOUNDS`'s prose comment — which is about *length and count*
bounds — to constraints of a different kind, without checking.

This is recorded rather than silently corrected because the false version would have permanently
foreclosed the strongest available mechanism.

### 2.4b Resolved (§2.5): the wire shape is a per-run generated tool schema

The open decision is now settled, by construction rather than preference.

**Shape: keep one `submit_resolution_report` tool, but generate its `input_schema` per run**, with
`evidence[].evidenceId` narrowed to `z.enum(candidateIds)` — the union of
`successfulToolExecutionIds` and `allowedRagChunkIds` at report time.

Why this beats a new conversation-entry kind:

- **It constrains the grammar, not just the instructions.** A supplied list delivered as another
  user-role message is still something the model can ignore — which is exactly what #80's capitalised
  prose and #101's corrective retry already proved it does. A closed `enum` in the tool's own input
  schema is enforced during decoding.
- **It needs no new `AgentConversationMessage` variant**, so `buildClaudeMessages`'s exhaustiveness
  switch, the mapper, and every fixture that walks conversation entries stay untouched.
- **It is architecturally available**: `buildRequestParams` already receives the full
  `AgentTurnInput`, so the tool list can be built per turn. Today `SUBMIT_RESOLUTION_REPORT_TOOL` is
  a module-level constant (`claude-tool-schemas.ts:117`), so this becomes a factory — a real but
  contained change, and `toClaudeDiagnosticTool` right above it is already exactly such a factory.

**What the orchestrator must carry.** `AgentTurnInput` gains the candidate observation set (the
locator pairs, already machine-known). This is the same "resolve at the caller layer" pattern the
repo already uses — the orchestrator computes it from state it owns and passes a concrete value;
the provider does not reach back for it.

**Remaining model-authored surface, stated honestly.** The enum removes the *identifier* failure
mode by construction. `finding` and `supports` stay model-authored, and nothing here forces the model
to include an entry it would rather omit unless `minItems: 1` is also applied — which §2.3 permits
only when the candidate set is non-empty, and which is exactly why the generated schema is per-run:
the empty-candidate case generates a schema without the floor, preserving the truthful-empty report.

**Not claimed:** that an enum makes the model *choose well*, or that it fixes `finding` quality.
It makes one specific failure — citing or omitting an id — unrepresentable. Whether the model then
annotates usefully is still a model-behaviour question (§4).

### 2.4c Retraction: the tuple / `prefixItems` encoding is REJECTED by the Anthropic API

Recorded per this plan's own convention (§0.5, §2.4a): a mechanism claim that was reasoned rather
than measured, and turned out false.

The shipped implementation (`3197ed9`) encodes "`evidence` contains every candidate" as a **tuple**,
which `z.toJSONSchema` emits as `prefixItems`. The code comment at `claude-tool-schemas.ts:163-167`
flagged acceptance as unverified and named Stage 1 as the check. **Stage 1's first live call settled
it: rejected.**

Observed on a real opt-in live smoke run (2026-09-15), sanitized:

```text
[claude] ... stopReason=tool_use ... normalizedResultType=diagnostic_tool_request   <- turn 1 OK
[claude] ... terminalErrorCategory=REQUEST_INVALID latencyMs=195                    <- turn 2 rejected
[claude-live-smoke] FAILED agent result code=PROVIDER_UNAVAILABLE
```

Turn 1 succeeded because the candidate set was still empty (the unpinned schema was offered). The
diagnostic tool then executed, the candidate set became non-empty, and the generated schema was
rejected. Reproduced against the real generated schema with a disposable probe (probe deleted, tree
clean):

```text
400 tools.0.custom: For 'array' type, property 'prefixItems' is not supported
```

**Blast radius: every run that executes a tool or retrieves a chunk fails at the REQUEST stage**,
before the model reasons at all — strictly worse than the failure #109 exists to remove, and not
probabilistic.

**What this invalidates, precisely.** Not the diagnosis (§0–§1). Not the design principle
(§2.1–§2.3: the harness supplies the observation set). Not F5, which this plan still does not touch
(§5). **Only the encoding chosen in §2.4b.**

Four encodings measured against the live API with the same probe:

| encoding | result |
| --- | --- |
| `evidence` as an OBJECT keyed by `evidenceId`, every key `required` | **ACCEPTED** |
| the same with an empty candidate set (`properties: {}`) | **ACCEPTED** — §2.3's truthful-empty case survives |
| `groundedBy` items as `anyOf` of `const` locator pairs | **ACCEPTED** — already the shipped `groundedBy` shape |
| tuple / `prefixItems` | **REJECTED (400)** |

The object-keyed map carries the same construction guarantee the tuple was chosen for — every
candidate is necessarily present in `evidence`, so `groundedBy ⊆ evidence` holds by construction —
without the rejected keyword. It is the recommended replacement.

**Limit of what this probe proves, stated before it is over-read.** All four checks used small
hand-written schemas, **not** the full generated report schema, which additionally carries a
discriminated union, nested payload objects, and `anyOf` branches. That the complete generated
document is accepted is **not** established. Sending the real one with `max_tokens: 1` costs cents
and must gate any funded Stage 1 sampling. Inferring acceptance of the whole from acceptance of a
fragment is the same move that produced §2.4a and this section.

**Unverified prerequisite for the object encoding.** `evidenceId` becomes a JSON object key, so
tool-execution ids and RAG chunk ids must not collide. `toolu_`-prefixed ids and runbook slugs
plausibly cannot — and "plausibly" is exactly what §2.4a and this retraction both punish. Check it.

**Documentation drift found while diagnosing this.** `docs/04-agent-design.md` §20.4's `v10` entry
and `claude-message-mapping.ts`'s `v10` comment both describe the FIRST implementation (`d199367`:
`evidence[].evidenceId` narrowed to an `enum` with `minItems: 1`), which independent review
superseded in `3197ed9`. **They describe a mechanism the repo does not ship.** Both must be
rewritten against whatever encoding replaces the tuple, not patched in place.

Note the asymmetry worth keeping: the `enum` those documents describe **is** accepted by the API —
it was abandoned for being too weak (it cannot stop a cross-reference between two candidates), not
for being rejected. The encoding that was strong enough is the one the API refuses.

### 2.4d Resolved: evidence-object encoding, `groundedBy` left unpinned

§2.4c recommended an object keyed by `evidenceId`, measured as accepted. Implementing it surfaced a
**second, independent API limit** that the fragment probe could not have shown — recorded here
because it changes what this plan can claim.

**Finding: pinning `groundedBy` is not shippable at any production-reachable size.** Measured with
the real generated schema (probes deleted, tree clean):

| n | evidence-only | evidence + `groundedBy` |
| --- | --- | --- |
| 2 | ACCEPTED (3395 ch) | ACCEPTED (4208 ch) |
| 3 | ACCEPTED (3736 ch) | **REJECTED** (5239 ch) |
| 5 | ACCEPTED (4418 ch) | **REJECTED** (7301 ch) |
| 6 | ACCEPTED (4759 ch) | **REJECTED** |
| 7 | **REJECTED** (5100 ch) | — |

Rejection message: `400 The compiled grammar is too large, which would cause performance issues.`

A real run reaches `MAX_DIAGNOSTIC_TOOL_CALLS` (3) + `topK` (3) = **6 observations**, so the
`groundedBy` pinning that `3197ed9` introduced would have failed every run with three or more
observations — a second hard REQUEST failure hiding behind the first.

**Consequence for the claim, stated plainly.** §2.4b claimed F5 becomes unviolatable by
construction. **That claim is withdrawn.** What ships is narrower and still worth shipping:

- **Closed** — the failure #109 actually documents: the model citing *real* observations it never
  listed (issue #109 run 3, both locators spelled correctly). Every candidate is a required key, so
  a real observation cannot be absent from `evidence`.
- **Not closed** — a wholly *invented* locator in `groundedBy`. Still representable, still rejected
  by `ResolutionReportSchema` and `findInvalidEvidence`, exactly as before this change.

The stronger guarantee was only ever available at n≤2, which production exceeds. Acceptance criteria
below are revised accordingly.

**Ceiling guard.** `MAX_PINNED_OBSERVATIONS = 6`, measured rather than chosen. Production cannot
reach it today, but that is a coincidence of two independently-configurable limits, not an
invariant — so above the ceiling the provider offers the unpinned schema and the run degrades to
pre-#109 behaviour instead of failing at the REQUEST stage. A test pins
`MAX_DIAGNOSTIC_TOOL_CALLS + topK ≤ MAX_PINNED_OBSERVATIONS` so raising either limit fails in CI.

**Storage shape unchanged, as promised.** The pinned evidence object is a wire shape only:
`expandPinnedEvidence` (`claude-response-normalization.ts`) reassembles the canonical
`EvidenceReference[]` from each key plus its annotation, at the same provider boundary that already
owns `normalizeSubmittedReportInput`. It fails open — any shape this harness could not have emitted
passes through untouched so `ResolutionReportSchema` renders the verdict, rather than a translation
function silently dropping or inventing an entry.

**Key collisions are impossible by construction**, closing §2.4c's open prerequisite without needing
to measure the two id spaces: the key is `sourceType:evidenceId`, the same composite the Python
scorer already uses as its identity key, so two candidates differing in either component produce
different keys.

**Gate result (§4b, 2026-09-15).** The real generated schema was sent for **every reachable run
shape** — 0–3 tool calls × 0–3 chunks, plus the over-ceiling fallback — at `max_tokens: 1`:
**17/17 ACCEPTED**. This is the check whose absence let both rejected encodings reach a paid live
run; it costs cents and now precedes any funded sampling.

---

## 3. Compatibility

- **No persisted data migrates**, and no read path changes — provided §2.4's storage-shape claim
  holds. Verify first (§4 case 7).
- **The Python scorer is untouched** for the same reason: it reads `sourceType`/`evidenceId` off the
  stored report, which keeps its current shape and semantics.
- **Prompt-version bump required** — model-facing prose and/or the offered tool surface change, so
  `opspilot-agent-v9` → `v10` across the four sites in
  `references/prompt-version-and-tool-contract.md`.
- **Fixtures**: any scripted-provider fixture that submits a report will need the new annotation
  shape. Expect the same repo-wide sweep #101's bounded-retry change required.

---

## 4. Verification plan — and its explicit limit

| # | Case | Expected |
| --- | --- | --- |
| 1 | Tools ran + chunks retrieved; model annotates | `evidence` carries every observation, ids harness-written |
| 2 | Nothing ran, nothing retrieved | `evidence: []`, `INSUFFICIENT` accepted — §2.3 preserved |
| 3 | Model declines to cite an available observation | Accepted, entry still listed with the model's stated reason |
| 4 | Model annotates an id NOT in the candidate set | Rejected — the harness set stays authoritative |
| 5 | `groundedBy` cites a harness-supplied locator | Accepted; F5 unviolatable by construction |
| 6 | Emitted stream → real reducer (both outcomes) | Accepted (per `report-stage-ledger.test.ts`) |
| 7 | **Stored report shape vs. a pre-change row** | Byte-identical structure; `ReportPanel` and the Python scorer parse both |
| 8 | Python parity suite + regenerated `ts-parity-v2.json` | Green |

**What this cannot prove.** All of the above is mechanism, and the eval harness drives
`FakeLlmProvider` from authored fixtures — it cannot produce or refute real model behaviour. Whether
a real model, handed a pre-populated list, annotates it correctly is a **model-behaviour** question
answerable only by real LIVE runs.

This matters more than usual here, because the failure mode is specifically "the model does not
produce content it was asked for". Option A removes the *identifier* half of that (machine-written),
but `finding` and `supports` are still model-authored, so a residual failure rate is possible and
must be measured rather than assumed away.

**Staged real-model check, sized to the decision:**

- **Stage 1 — existence (n≈5).** Does a real model annotate a supplied list at all? n=1 answers
  "ever"; a handful guards against a one-off. Cheap, and it gates Stage 2.
- **Stage 2 — the gate (n=10).** The agreed release gate below. Stage 1's runs are **not** counted
  toward it: they exercise a build that may still change in response to what Stage 1 shows, and
  mixing them would silently turn the gate into a post-hoc filter over a larger pool.

**Release gate (owner decision, 2026-09-15): 10 consecutive real runs, at most 2 failures.**

What that gate does and does not establish, computed rather than asserted:

| true success rate | P(passing the gate: ≥8 of 10) |
| --- | --- |
| 28% (persisted baseline, 10/36) | **0.1%** |
| 40% | 1.2% |
| 50% | 5.5% |
| 60% | 16.7% |
| 70% | 38.3% |
| 75% | 52.6% |
| 80% | 67.8% |

- **As an improvement detector it is strong.** If the fix changed nothing, passing is a ~0.1%
  event. Clearing this gate is solid evidence the failure mode actually moved.
- **As a release certificate it is weak.** An observed 8/10 carries a 95% Clopper-Pearson interval
  of **[44.4%, 97.5%]** — consistent with more than half of visitors still failing. It does not
  establish a rate of 80%, and must not be reported as doing so.
- **It also carries a real false-negative risk.** Even a genuinely good fix (true rate 80%) fails
  this gate ~32% of the time. **A 7/10 result is therefore NOT evidence the fix failed** — at n=10
  that is ordinary noise, and concluding otherwise would discard a working fix. Re-run before
  drawing any conclusion from a near-miss.

**Provider-layer drag: the gate may be close to unpassable, and this must be settled before
sampling.** §0.2 shows **9 of 36 persisted LIVE runs (25%) failed below the report contract** —
`PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`, `PROVIDER_PROTOCOL_INVALID`. If that rate persists, then
even a **perfect** report contract caps the true success rate at ~75%, where this gate passes only
**52.6%** of the time — a coin flip that says nothing about this change. On 2026-09-15 alone, 6 of
21 runs (29%) failed this way.

Two defensible responses; this is an owner decision and the plan does not assume one:

1. **Score the gate on runs that reached report validation**, excluding provider-layer failures as
   out-of-scope infrastructure noise — and record them separately, since a 25% transport failure
   rate is its own defect worth an issue.
2. **Keep the gate end-to-end**, accepting that it measures the whole system; then a failure to pass
   must not be attributed to #109 without first checking the failure codes.

Option 1 is what actually tests this change. Without one of the two, a passing run and a failing run
are close to equally uninformative.

**Consequence for sequencing.** Clearing the gate authorises merging and deploying. The public trial
stays as it is — **owner decision, 2026-09-15: not token-gated** — so the larger sample accumulates
passively from real traffic rather than from funded runs. The honest consequence, recorded rather
than argued: until that traffic establishes a tighter interval, a visitor who draws a failing run
spends their single daily attempt on it. That is accepted.

Cost is explicitly NOT the constraint here (~$0.16/run, so 10 runs ≈ $1.60); the number is chosen
for what it must decide.

---

## 5. Out of scope (explicit)

- **Index-based grounding** — withdrawn with its refutation in §1.1, not silently dropped.
- **A fourth prompt-wording revision** (§0.4).
- **#107's turn budget** — merged, independent, addresses a different population (§1.3).
- **Changing F5, `evidenceState`, or disposition semantics.** This plan makes the contract
  *satisfiable*, it does not weaken it. No invariant is relaxed.
- **Recording corrected-away attempts in the ledger** — still owed its own issue (#101 §5).

---

## 6. Sequencing

0. ~~Resolve the open wire-shape decision~~ — **done before this plan was finalised**; the answer is
   recorded as §2.4b (per-run generated tool schema), with the false mechanism claim that would have
   foreclosed it retracted in §2.4a.
1. ~~Verify §2.4's storage-shape claim against a pre-change persisted row~~ — **done while rebuilding
   §0's evidence base.** `AgentRun.report` is `Json?` (`schema.prisma:29`), a single unstructured
   blob with no per-field columns, and 38 persisted rows carry reports of three different shapes
   (`evidence` lengths 1, 2 and 5) with `ReportPanel` already handling pre-#58 rows that lack
   `evidenceState`. Storage imposes no constraint on this change, and the cost estimate holds.
2. Tests first: §4 cases 1–5 against the scripted provider.
3. Turn `SUBMIT_RESOLUTION_REPORT_TOOL` into a per-run factory (§2.4b) and widen `AgentTurnInput`
   with the candidate observation set, resolved by the orchestrator.
4. Implement the orchestrator side: assemble the stored `evidence` from harness ids plus model
   annotations.
5. Reducer-stream test (case 6) and the stored-shape test (case 7).
6. Repo-wide fixture sweep; regenerate `ts-parity-v2.json` with the repo's export script; Python
   suite.
7. Prompt-version bump to `v10` across all four sites — the offered tool's *schema* now varies per
   run, which is an offered-surface change of the same kind as the v6 and v9 bumps.
8. `pnpm agent:verify --final`, review bundle, independent `agent:codex-review`.
9. **Schema-acceptance gate (§2.4c).** Send the REAL generated report tool with `max_tokens: 1` and
   confirm the Anthropic API accepts it. Costs cents, and it is the step whose absence let a
   rejected encoding reach a funded live run. It gates step 10 — never the reverse.
10. **Stage 1 real-model check** (~5 runs) — the first evidence that any of this changes model
    behaviour. Report mechanism and model-compliance as two separate verdicts.

---

## 7. Acceptance criteria

1. Every observation the run actually made appears in the stored `report.evidence`, with
   `evidenceId`/`sourceType` written by the harness, not transcribed by the model.
2. A run that gathered nothing still produces `evidence: []` under `INSUFFICIENT` (§2.3), and the
   generated schema for that run carries **no** `minItems` floor — the truthful-empty case is
   preserved by construction, not by a special case.
3. An annotation naming an id outside the harness-supplied candidate set is rejected.
4. **The generated per-run schema is asserted post-`toStrictInputSchema`**, not pre — a test pins
   that the run's candidate observations are all structurally present and that the pinning survives
   stripping. Asserting the pre-strip Zod schema would pass while the shipped grammar silently lost
   the constraint (§2.4a is the retraction of exactly that assumption).
4b. **The real generated schema is confirmed ACCEPTED by the live Anthropic API** (§2.4c/§2.4d
    schema-acceptance gate), across **every reachable run shape**, not a representative one. A
    repo-internal test cannot establish this: `toStrictInputSchema` encodes this repo's belief about
    the strict-tool-use subset, and §2.4c and §2.4d are what happens when that belief is wrong —
    twice, for two unrelated reasons. No funded Stage 1 sampling before this passes.
4c. **The grammar-size ceiling is guarded**, not assumed: a test pins
    `MAX_DIAGNOSTIC_TOOL_CALLS + topK ≤ MAX_PINNED_OBSERVATIONS`, and the provider falls back to the
    unpinned schema above it rather than failing the request (§2.4d).
5. The stored report's shape is unchanged: a pre-change row and a post-change row parse identically
   through `ReportPanel` and the Python scorer.
6. `ts-parity-v2.json` regenerated with the repo's own export script; Python evaluation suite green.
7. The emitted event stream is validated against the **real reducer** for both outcomes.
8. Prompt version bumped to `opspilot-agent-v10` at all four sites.
9. `pnpm agent:verify --final` passes (CI is the authority for the known-flaky harness e2e file).
10. Stage 1 real-model observation recorded with run ids, sample size, and per-run outcome.
11. The PR body and an issue comment state **mechanism** and **model-compliance** as separate
    verdicts. Closing #109 on deterministic tests alone — i.e. claiming the LIVE path is fixed
    without a recorded real-model sample — is prohibited. Specifically prohibited: reporting that
    this "fixes the evidence problem", or that **F5 is now unviolatable** — §2.4d withdraws that
    claim. What is true: a real observation can no longer be omitted from `evidence`. An invented
    locator is still representable and still caught by validation, and `finding`/`supports` quality
    remains unmeasured.
