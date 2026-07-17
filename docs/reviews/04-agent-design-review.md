# OpsPilot Agent Design Review

| Field | Value |
|---|---|
| Document reviewed | `docs/04-agent-design.md` |
| Review status | Approved |
| Reviewer | Wenjie Ye |
| Started | July 2026 |

## Severity

- **P0** — correctness, security, data integrity, or unrecoverable state risk
- **P1** — important ambiguity or missing behavior that may cause inconsistent implementations
- **P2** — wording, naming, maintainability, or minor documentation issue

## Findings

### AD-001 — Phase budgets are not fully isolated

- **Section:** §7 Budgets and Deadline
- **Severity:** P1
- **Status:** Resolved

#### Finding

The document states that investigation turns cannot consume the reserved
finalization turn, and that repair attempts are not counted as
investigation or finalization turns.

However, it does not explicitly state that a finalization call cannot
consume the investigation or repair budget, or that one logical model
call can increment only one phase counter.

#### Risk

Different implementations may increment multiple counters for one
logical model call or count finalization calls as investigation turns.

#### Required change

Define the following invariant:

- Every logical model call is charged to exactly one phase budget,
  based on the agent phase at the start of the call.
- Investigation calls increment only `investigationTurnsUsed`.
- Forced-finalization calls increment only `finalizationTurnsUsed`.
- Report-repair calls increment only `repairAttemptsUsed`.
- Budgets cannot be borrowed, transferred, or reset between phases.

#### Required test

Verify that five investigation calls, one forced-finalization call,
and one repair call produce:

```text
investigationTurnsUsed = 5
finalizationTurnsUsed = 1
repairAttemptsUsed = 1
```

#### Resolution

Updated §7 and §25.1 to define mutually exclusive phase-budget
accounting and matching unit-test coverage.

### AD-002 — Deadline failure scope and post-call behavior are ambiguous

- **Section:** §7 Budgets and Deadline
- **Severity:** P1
- **Status:** Resolved

#### Finding

The rule states that “reaching the deadline fails the run immediately,”
but does not define whether “the run” refers to a provider call, the
current `AgentRun`, the associated `AgentJob`, or the worker process.

The document also does not explicitly define how to handle a provider
or diagnostic tool result that returns after the deadline.

#### Risk

An implementation may accept and persist a late report, incorrectly
terminate the worker process, or update only `AgentRun` without updating
the associated `AgentJob`.

#### Required change

Define that the deadline applies to the current `AgentRun` execution
attempt and its associated `AgentJob`.

Before starting any provider or diagnostic tool call, the orchestrator
must verify that time remains.

After any provider or diagnostic tool call returns, the orchestrator
must check the deadline again before accepting, persisting, or adding
the result to the conversation.

If the deadline has passed, the result must be discarded and the
orchestrator must call `failOwnedAgentRun(...)` with `AGENT_TIMEOUT`,
provided execution ownership is still valid.

The worker process must remain available to process other jobs.

#### Required tests

1. A provider call is not started when the deadline has already passed.
2. A provider result returned after the deadline is discarded.
3. A late valid report does not create a `ResolutionReport`.
4. Timeout atomically marks both `AgentRun` and `AgentJob` as `FAILED`.
5. Timeout does not terminate the worker process.
6. Timeout after ownership loss does not overwrite the existing
   terminal state.

#### Resolution

Updated §7, §17, §18, and §25 to define deadline scope, late-result
discard behavior, ownership requirements, and timeout tests.

### AD-003 — Live-model turns are described as deterministic

- **Section:** §2 Goals
- **Severity:** P1
- **Status:** Resolved

#### Finding

The document states that the design should:

> make every model turn deterministic from explicit application state

This is not accurate for a live LLM provider. Even when the prompt,
model identifier, tool definitions, and input context are identical,
the provider may return different valid outputs.

The application can control and record the inputs to each turn, but it
cannot guarantee deterministic live-model output.

#### Risk

The current wording may create an incorrect implementation or evaluation
expectation that identical inputs must always produce identical model
responses.

It may also blur the distinction between:

- deterministic application control flow;
- deterministic fake-provider tests; and
- non-deterministic live-model behavior.

#### Required change

Replace the deterministic-output goal with an auditability and
reproducibility goal.

Suggested wording:

- Make every model turn reproducible and auditable from explicit
  application-controlled inputs, without assuming deterministic
  live-model output.
- Record the exact model identifier, prompt version, available tool
  definitions, phase, and relevant run configuration for each live run.
- Use the deterministic fake provider for repeatable automated tests.
- Evaluate live-model behavior statistically across a fixed evaluation
  dataset rather than expecting byte-identical responses.

#### Required tests

1. Fake-provider scenarios produce deterministic outputs for identical
   scenario inputs.
2. Live-run metadata records the exact model identifier and prompt
   version.
3. Agent behavior tests assert valid outcomes and invariants rather than
   exact live-model wording.
4. Evaluation tests tolerate multiple valid reports that satisfy the
   same schema and grounding requirements.

#### Resolution

Updated §2 and the fake-provider guidance to distinguish auditable
application-controlled inputs from non-deterministic live-model output.

### AD-004 — Multiple diagnostic tool requests per turn add unnecessary MVP complexity

- **Section:** §10 Normalized Provider Result and §12 Diagnostic Tool Request Handling
- **Severity:** P1
- **Status:** Resolved

#### Finding

The document currently allows one provider turn to return multiple
diagnostic tool requests and proposes executing them sequentially in
provider order.

Supporting multiple tool requests in one turn introduces additional
behavior that is not necessary for the MVP, including:

- partial remaining tool budgets;
- cancellation between tool executions;
- deadline expiration between tool executions;
- partial success and partial failure;
- conversation ordering for multiple results;
- persistence ordering for multiple `ToolExecution` rows;
- handling ownership loss after one tool succeeds but before the next
  tool begins.

#### Risk

This increases orchestration, persistence, and test complexity without
materially improving the portfolio demonstration.

It may also make the first implementation harder to debug because one
provider turn can create several independently failing execution paths.

#### Required change

Limit the MVP to at most one diagnostic tool request per provider turn.

Suggested rules:

- The MVP accepts at most one diagnostic tool request in one normalized
  provider result.
- A provider response containing more than one diagnostic tool request
  is rejected as `PROVIDER_PROTOCOL_INVALID`.
- After receiving one diagnostic tool result, the model may request
  another tool during the next investigation turn.
- `submit_resolution_report` must never appear in the same normalized
  turn as a diagnostic tool request.
- Multi-tool requests in one provider turn may be reconsidered after the
  basic agent loop is implemented and evaluated.

The intended MVP loop is:

```text
model turn
→ one diagnostic tool request
→ validated tool execution
→ persisted tool result
→ result added to conversation
→ next model turn
```

#### Resolution

Updated §10, §11, §12, and §25 to allow at most one diagnostic tool
request per provider turn for the MVP.

### AD-005 — Final-report evidence validation does not fully include diagnostic tool results

- **Section:** §13 Report Submission and Validation
- **Severity:** P1
- **Status:** Resolved

#### Finding

The document states that report citations are limited to chunks
retrieved during the current run.

However, an OpsPilot resolution report may be grounded by two different
evidence sources:

1. RAG chunks retrieved from runbooks or incident documentation.
2. Successfully completed diagnostic tool executions from the current
   run.

Examples include:

- a runbook chunk describing a known failure mode;
- a service-status tool reporting a degraded dependency;
- a log-search tool reporting repeated timeout or rate-limit errors.

The current rule does not explicitly allow final reports to cite
successfully persisted diagnostic tool results.

#### Risk

The implementation may reject valid tool-grounded reports or allow the
model to summarize tool findings without traceable evidence identifiers.

This would weaken one of the project's main portfolio goals: showing a
grounded agent that connects final conclusions to retrieved and observed
evidence.

#### Required change

Define one explicit set of evidence identifiers available to the final
report:

```ts
allowedEvidenceIds =
  retrievedChunkIds ∪ successfulToolExecutionIds;
```

#### Resolution

Updated §13 and §25 to allow evidence only from current-run retrieved
chunks and successfully persisted current-run diagnostic tool
executions.


### AD-006 — The PREPARING phase includes undefined classification behavior

- **Section:** §6 Agent Phases, §8 Conversation Model, and §16 Persistence Mapping
- **Severity:** P1
- **Status:** Resolved

#### Finding

The document defines a `PREPARING` phase and later lists both
`CLASSIFICATION` and `RETRIEVAL` as possible durable trace events.

However, the document does not clearly define:

- whether classification is performed by the model or application code;
- whether classification requires a separate provider call;
- what classification output controls;
- whether classification consumes an agent-turn budget;
- whether classification is required before retrieval;
- whether classification is persisted independently from the final
  report category.

The MVP does not currently require pre-classification to select a
different prompt, model, workflow, or tool set.

#### Risk

An implementer may add an unnecessary classification model call before
the main agent loop.

This would increase latency, token usage, implementation scope, and
evaluation complexity while duplicating the category already produced
inside the final `ResolutionReport`.

#### Required change

Define the MVP `PREPARING` phase as application-controlled context
preparation only.

Suggested responsibilities:

1. Load the ticket and associated safe application context.
2. Sanitize and bound all untrusted text.
3. Retrieve relevant runbook or incident-document chunks.
4. Record the retrieved chunk identifiers.
5. Append a bounded `RETRIEVAL` trace event.
6. Build the initial in-memory provider conversation.
7. Transition the runtime state to `INVESTIGATING`.

Suggested MVP rule:

- The MVP does not perform a separate pre-classification model call.
- Incident category is generated and validated as part of the final
  `ResolutionReport`.
- A standalone classification phase may be added later only if it is
  needed to route requests to different prompts, tools, models, or
  workflows.
- Remove `CLASSIFICATION` from the required MVP persistence mapping
  unless an application-controlled classification rule is explicitly
  introduced.

#### Required tests

1. `PREPARING` loads and sanitizes the ticket context.
2. `PREPARING` retrieves and records allowed RAG chunk identifiers.
3. `PREPARING` does not call `LlmProvider`.
4. `PREPARING` does not consume an investigation, finalization, or
   repair budget.
5. Successful preparation transitions the runtime state to
   `INVESTIGATING`.
6. Retrieval failure produces a defined failure path without starting
   the model loop.
7. The final report category is validated through
   `ResolutionReportSchema`.

#### Resolution

Updated §6, §8, §16, and §25 to define `PREPARING` as
application-controlled retrieval and context preparation without a
separate model classification call.

## Final Verdict

All six MVP-blocking findings were resolved.

The agent design is sufficiently defined for portfolio-focused
implementation. Additional production-hardening review is deferred
until implementation or evaluation reveals a concrete need.

**Verdict:** Approved for implementation.