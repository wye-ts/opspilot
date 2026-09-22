# Issue #131 — the approval surface promises an execution that never happens

Plan. Copy and tests only; no mechanism, contract, or persistence change.

## 0. What was verified before writing this

Every claim below was re-checked against `eb0aed8` (current `main`), not taken from the issue text.

| Claim | Verified at |
| --- | --- |
| Banner promises execution | `ActionRequiredBanner.tsx:46` — `require review before execution.` |
| APPROVED copy is only "final" | `approval-presentation.ts:46` |
| REJECTED copy has the same gap | `approval-presentation.ts:55` |
| Mechanism records a decision only | `docs/13-approval-workflow.md:16` |
| Immutability is application-layer | `docs/13-approval-workflow.md:27`, `:90` |
| `hint` renders and is currently always null | `ApprovalPanel.tsx:59`; all four branches return `hint: null` |

The last row is the one that shapes the fix: a rendering channel for exactly this kind of
qualifying sentence **already exists** and is unused. No new prop, no new element.

## 1. The defect

Three documents agree the mechanism never executes anything. The UI contradicts them at two
points on the same page, and the two compound:

1. **Before the decision**, the banner says the action requires review *before execution* —
   manufacturing an expectation that something happens after approval.
2. **After the decision**, the terminal card says only *"This decision is final."* A reader who
   arrived via "before execution" reads "final" as *finalized, therefore proceeding*.

The second sentence is the entire explanation on that card. Nothing states what the record is for.

### Why this is not ordinary copy drift

This repo already adjudicated this exact overclaim once, against a draft resume bullet
(`docs/01-prd.md:530`): *"Not earned as written… No state-changing action path exists to control."*
The resume was corrected. **The same overclaim still ships in the UI** — the only surface an
evaluator actually sees.

It also inverts the sale. What the mechanism genuinely provides is stronger than the promise:
a persisted, attributable, concurrency-safe decision record (`SELECT … FOR UPDATE`,
`runId @unique`, replay-idempotent) with a deliberately un-crossed execution boundary.

## 2. Wording constraints

These bound the replacement text. Each is a real mechanism limit, not style.

| Must NOT claim | Because |
| --- | --- |
| an execution, scheduling, or dispatch | none exists; `schema.prisma` has no entity to act on |
| a *simulated* execution | implies a downstream system was affected; strictly weaker than the truth |
| notification, escalation, or that anyone was contacted | nothing is sent |
| database-enforced immutability | `docs/13` §5: application-layer only |
| that the record cannot be changed | same; `UNIQUE(run_id)` bounds row count, not contents |

| Must convey | Because |
| --- | --- |
| a decision was **recorded** | the exact verb all three documents use |
| OpsPilot does **not** carry the action out | the boundary the reader must not misread |

**"Final" is retained**, qualified. It is mechanically true in the sense that matters to a reader
(no edit/revoke path exists, `docs/13:88`) and the issue does not ask for its removal.

## 3. Change 1 — the banner

`ActionRequiredBanner.tsx:46`

- **From:** `{n} proposed action(s) require(s) review before execution.`
- **To:**   `{n} proposed action(s) require(s) a human decision.`

Drops the execution promise; keeps the call to act, the count, and the singular/plural logic
(pluralization is already correct and stays untouched).

## 4. Change 2 — the terminal states

`approval-presentation.ts`, PENDING, APPROVED and REJECTED branches.

**The disclosure must appear BEFORE the decision, not only after it.** An earlier draft of this
plan put it only on the terminal states; independent review rejected that as preserving the exact
misconception the change exists to remove. A reviewer would press an irreversible button still
believing approval causes the actions to occur, and learn otherwise only afterwards. `hint`
renders above `ApprovalDecisionForm` (`ApprovalPanel.tsx:59-62`), so the PENDING hint sits
directly above the Approve/Reject controls.

`copy` keeps its current sentence. The boundary goes in **`hint`**, which already renders at
`ApprovalPanel.tsx:59` and is null on every branch today.

- PENDING  `hint`: `OpsPilot records your decision; it does not carry out any suggested actions.`
- APPROVED `hint`: `OpsPilot recorded this decision; it does not carry out any suggested actions.`
- REJECTED `hint`: `OpsPilot recorded this decision; it does not carry out any suggested actions.`

Wording note: **plural / set-wide**, not "the action". One decision covers the whole
`suggestedActions` array, so singular wording would leave the boundary ambiguous for the
remaining actions in a multi-action run — on the very screen being corrected to state that
boundary. PENDING uses future-facing "your decision"; the terminal states use "recorded".

Why `hint` rather than lengthening `copy`: `copy` sits beside the status badge as the state's
one-line identity, and `hint` is the established slot for a qualifying note (its only prior use,
the NOT_ELIGIBLE deep link, was removed as a product instruction — the channel stayed).

Identical text on the two terminal branches is deliberate: the boundary is a property of the
mechanism, not of which way the decision went.

## 5. Tests

`approval-presentation.test.ts` and `ActionRequiredBanner.test.tsx`.

### 5.1 Positive assertions

1. Banner subtitle reads `requires a human decision` (n=1) and `require a human decision` (n=2).
2. PENDING `hint` is non-null and contains `does not carry out any suggested actions`.
3. APPROVED `hint` is non-null and contains `does not carry out any suggested actions`.
4. REJECTED `hint` is non-null and contains `does not carry out any suggested actions`.
5. **Rendered PENDING panel**: the disclosure is present in the DOM *before* the Approve/Reject
   controls — asserted on render order, not merely on the string, since the whole point is that
   the reviewer sees it while deciding.
6. Terminal run with `suggestedActionCount > 1`: the rendered disclaimer applies to all
   suggested actions (no singular "the action").

### 5.2 Negative guard — the overclaim cannot drift back

One test asserting that no user-visible string in either module matches, case-insensitively and
on **word boundaries**:

Matched as **word-boundary alternatives over the complete inflected form of each claim family** —
verb, third-person, past, gerund, and noun. Not a list of phrasings:

```
execution:    execute | executes | executed | executing | execution | executions
scheduling:   schedule | schedules | scheduled | scheduling
dispatch:     dispatch | dispatches | dispatched | dispatching
simulation:   simulate | simulates | simulated | simulating | simulation
notification: notify | notifies | notified | notifying | notification | notifications
escalation:   escalate | escalates | escalated | escalating | escalation
```

**Why forms and not phrases.** Two earlier drafts of this guard listed concrete phrasings, and
independent review broke each one with a variant the list had not anticipated — first
`Approved actions are executed` / `OpsPilot schedules the actions`, then `Approved actions
execute after approval` / `Execution follows approval` / `A notification is sent after approval`.
Enumerating phrasings is unbounded; enumerating a word family's forms is finite and closes the
class. A guard that a reviewer can defeat with ordinary grammar is not a guard.

The word boundary remains load-bearing: `dispatcher`, `scheduler` and `executive` all contain a
listed token and must stay green. A guard that misfires on innocent text creates pressure to
weaken it — the failure mode that cost four review rounds on #126 (`docs/reviews/50` §1.3b).

Collect the strings to check from the module's own exports (all four `presentApproval` results
plus the rendered banner), never from a copy of the literals — a guard reading a duplicate of
the text it guards proves nothing.

### 5.3 Falsification

Each assertion must be shown red before it is trusted:

- restore `before execution` in the banner → test 1 and the guard go red
- set either `hint` back to `null` → test 2 / 3 go red
- insert `will be executed` into any `copy` → guard goes red
- parameterized over every claim family, each must turn the guard red:
  `Approved actions are executed` · `Approved actions execute after approval` ·
  `Execution follows approval` · `OpsPilot schedules the actions` ·
  `The action was dispatched` · `The reviewer is notified` ·
  `A notification is sent after approval` · `requires review before execution`
- insert `dispatcher queue`, `scheduler thread`, `executive summary` → guard stays **green**.
  These are the real word-boundary controls: each CONTAINS a guarded token, so a bare-substring
  guard fires on them. An earlier draft used `recommended`, which contains no guarded token at
  all and stays green with or without word boundaries — it proved nothing. Caught by review.

## 6. Explicitly out of scope

- **Building the execution.** `docs/01-prd.md:289` ("The MVP will simulate these actions") is a
  pre-implementation promise from the same batch as the retracted resume bullet — a claim to
  audit, not queued scope. Building it would mean inventing the entity it acts on, producing a
  state machine whose only effect is recording that it ran.
- **`docs/01-prd.md:289` itself.** It is a real documentation defect of the same family, but it
  is not what a public-trial visitor reads. Separate change, if at all.
- Any change to `AgentRunApproval`, the repository, the HTTP contract, or the badge/`<dl>` record.

## 7. Acceptance

- [ ] Banner no longer contains `before execution`
- [ ] PENDING, APPROVED and REJECTED all render a hint stating OpsPilot does not carry out any
      suggested actions
- [ ] On PENDING, that disclosure precedes the Approve/Reject controls in the DOM
- [ ] No user-visible approval string claims execution, simulation, notification, or escalation
- [ ] The negative guard matches on word boundaries and stays green on innocent text
- [ ] Every new assertion shown red under its own falsification
- [ ] `web` suite, typecheck, lint, build, bundle guard all clean
- [ ] No file outside `apps/web/src` touched
