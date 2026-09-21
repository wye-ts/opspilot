# Issues #125 / #123 — provider transport faults and failure attribution

| | |
| --- | --- |
| Scope | #125 (TLS fault destroys the HTTP/2 session) and #123 (`PROVIDER_UNAVAILABLE` collapses outages with our own auth/billing failures) |
| Basis | `main` @ `b76e641c190f0d7a109f7f6f5be68b5c822ccf69` (#122), working tree clean |
| Status | Plan only. No repository source modified, no migration, no commit, push, PR, merge, or deploy. No provider/LIVE request made while producing it. |
| Branch | `fix/125-123-provider-failure-attribution` (created, holds this document only) |
| Committed location | `docs/reviews/49-issues-125-123-provider-failure-attribution-plan.md` |

---

## 0. Scope corrections — verified against source and by direct probe

Three findings, each established before any design work. Two of them refute a claim that a
previous session (mine, in this conversation) made out loud, and one refutes the framing of #125
itself. They are stated first because they change what the work *is*.

### 0.1 The HTTP/2 session fault cannot occur on the Node version this repo deploys

**#125's core mechanism requires an HTTP/2 session. The deployed runtime never opens one.**

`ERR_HTTP2_INVALID_SESSION` ("The session has been destroyed") is reachable only when the client
negotiated `h2` via ALPN. Whether it does is decided by undici's `allowH2` default, which is bundled
with Node — not by the Anthropic SDK, which uses `globalThis.fetch`
(`@anthropic-ai/sdk/src/client.ts:558`, `this.fetch = options.fetch ?? Shims.getDefaultFetch()`)
and therefore inherits the process's global dispatcher.

Probed directly against the real endpoint, subscribing to undici's `undici:client:connected`
diagnostics channel and reading `socket.alpnProtocol` (3 consecutive attempts per version, no
variation):

| Runtime | bundled undici | negotiated ALPN |
| --- | --- | --- |
| Node 22.21.0 — **`.nvmrc`, `Dockerfile`, CI `node-version-file`** | 6.22.0 | **`http/1.1`** |
| Node 24.18.0 | 7.28.0 | `http/1.1` |
| Node 26.7.0 — **this machine's default shell `node`** | 8.9.0 | **`h2`** |

The probe (disposable, not committed):

```js
import dc from 'node:diagnostics_channel';
dc.subscribe('undici:client:connected', (m) => console.log('ALPN:', m?.socket?.alpnProtocol));
const r = await fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': 'invalid' } });
await r.text();
```

`Dockerfile:4` and `Dockerfile:56` both pin `node:22.21.0-bookworm-slim`; `.nvmrc` pins `22.21.0`;
every CI job reads `node-version-file: .nvmrc`. **The deployed API therefore speaks HTTP/1.1 to
Anthropic and cannot enter the failure state #125 describes.**

**Consequences, stated precisely:**

- #125's "Why this is not only a measurement problem" section — *"The deployed path has the same
  shape: one client built in the factory, shared by every run. A production instance that hits one
  TLS fault will keep failing every LIVE run until it restarts"* — **is refuted as written.** The
  shared-client observation at `api-provider-factory.ts:81` is accurate, but the shared object is
  not what carries the broken state (the issue's own 2026-09-20 comment already established that
  rebuilding the client does not help), and an HTTP/1.1 pool recovers per socket. This is in fact
  the second of the two remedies that comment proposed — the repo already has it, by accident of
  the pinned Node version rather than by decision.
- **What is NOT claimed:** that Node 22 rounds are fault-free. Only the specific
  `bad record mac → ERR_HTTP2_INVALID_SESSION → sub-millisecond failures` chain is unreachable
  without an `h2` session. A TLS fault on HTTP/1.1 kills one socket and the next request opens
  another.
- **The measurement's Node version is an inference, not a recorded fact.** `apps/worker`'s LIVE
  scripts run via bare `node --import tsx` (`apps/worker/package.json:18-19`), which resolves to the
  shell default — v26.7.0 here. That, plus the fact that the observed error class requires `h2`,
  makes "the measurement ran on Node 26" the only consistent reading. It was not recorded at the
  time, and §4 names the cheap confirmation rather than asserting it.
- This is the **second** time the same environment mismatch has produced a wrong conclusion about
  repo state. `docs/reviews/37` §4.1 (commit `4e7f9ae`) recorded the first: four `apps/web`
  localStorage failures read as a repo defect, actually Node 26 vs `.nvmrc`'s 22. That one cost a
  misattributed milestone prerequisite; this one cost **35 of 49 billed provider invocations**
  across seven rounds. The recurrence is the real finding here — not the TLS fault.

### 0.2 The deployed path already logs everything #123 says is missing

#123's evidence is that a failure was mis-diagnosed as an upstream outage when it was a billing
limit, recoverable only by calling the API by hand. That happened — but not on the deployed path.

`apps/api/src/execution/provider-event-log.ts` is wired as the API's provider logger
(`run-execution.module.ts:52-55`) and already emits, per failed turn:
`terminalErrorCategory`, `errorSource`, `errorClass`, `errorStatus`, `latencyMs`,
`configuredMaxRetries`. `AUTHENTICATION`, `BILLING`, and `CONNECTION` are already distinct in that
line.

What lacked a logger was `measure-completion-rate.ts`, and #125's own comment says so:
*"Nothing about it was visible while the failure surfaced only as `PROVIDER_UNAVAILABLE` (#123)…
Attaching the adapter's logger, which carries `errorClass`, identified `APIConnectionError` on the
first run afterwards."* That gap is **already closed** — the logger was added in #122 and
`measure-completion-rate.ts:512-548` now records every error event.

**The residual gap #123 correctly identifies is narrower than its title:** the distinction lives in
a log line, not in queryable persisted data. `agent_runs.failure_code` stores the collapsed code, so
an aggregate over past runs still cannot separate "upstream was down" from "our key was rejected".

### 0.3 The collapse is a deliberate information-disclosure decision — my previous recommendation is withdrawn

Earlier in this conversation I recommended adding a `PROVIDER_MISCONFIGURED` member to
`AgentOrchestratorErrorCodeSchema`, splitting `AUTHENTICATION` / `BILLING` / `REQUEST_INVALID` out of
`PROVIDER_UNAVAILABLE`. **That is refuted and is withdrawn.**

The collapse is documented as intentional in two places:

- `docs/04-agent-design.md:913` — *"All four aspirational `PROVIDER_*` codes collapse here. A public
  caller must not learn whether the deployment's credential is rejected, out of credit, or merely
  throttled; the precise category goes to the server-side structured log."*
- `packages/database/src/failure-messages.ts:20-24` — the same rule on the display string.

And the code **does** reach a public response body: `buildOutcome` (`mappers.ts:262-263`) puts it on
`AgentRunOutcome`, and `mapAgentRunResponse` (`agent-run-response.mapper.ts:72`) forwards `outcome`
verbatim. The run resource is publicly reachable (the rate-limited LIVE trial, #39).

So the change I proposed would have let an anonymous caller distinguish "this deployment's Anthropic
credential is rejected" from "this deployment is out of credit" — publishing our own billing state
to the internet, in order to fix a diagnosis problem that §0.2 shows the server log already solves.
I read the issue and the orchestrator's `providerFailureCode` switch but not the doc section that
governs it; the switch's own comment says "Grouped by what an operator would do about it", which
reads as a grouping heuristic rather than a disclosure boundary.

Any future version of #123 must therefore be **internal-only** — never a new member of the enum that
`buildOutcome` maps.

---

## Scope decision

Given §0, three options:

1. **Implement both issues as filed.** Refused: #125's production fix would repair a state the
   deployed runtime cannot reach, and #123's fix as I scoped it is a data leak.
2. **Close both as invalid.** Refused: the environment mismatch that produced both is real,
   recurrent, and has now cost real money. Closing on "the deployed path is fine" would discard
   that.
3. **Re-aim at the defect that actually exists: paid LIVE work runs on an unpinned, unrecorded
   runtime.** **Chosen.**

**Decision (Mira, recorded for owner review): option 3, as a single small PR, with #123's persisted
field deferred rather than built (§5).**

---

## 1. Current-state findings

| Area | File / symbol | What it does today |
| --- | --- | --- |
| Shared client | `apps/api/src/execution/api-provider-factory.ts:81` | One `Anthropic` per process, reused for every run |
| Transport | bundled undici via `globalThis.fetch` | `http/1.1` on Node 22; `h2` from Node 26 |
| Runtime pin (deploy) | `Dockerfile:4`, `Dockerfile:56` | `node:22.21.0-bookworm-slim` |
| Runtime pin (CI) | `.github/workflows/ci.yml` ×4 | `node-version-file: .nvmrc` → 22.21.0 |
| Runtime pin (local LIVE scripts) | `apps/worker/package.json:16-20` | **none** — bare `node`, resolves to shell default |
| Failure collapse | `agent-orchestrator.ts:204-218` | 7 categories → `PROVIDER_UNAVAILABLE` |
| Disclosure rule | `docs/04-agent-design.md:913`, `failure-messages.ts:20-24` | the collapse is deliberate and public-facing |
| Public exposure | `mappers.ts:262`, `agent-run-response.mapper.ts:72` | `failure_code` → `outcome.code` → HTTP body |
| Deployed telemetry | `provider-event-log.ts:20-40` | already logs category/class/status per failed turn |
| Measurement telemetry | `measure-completion-rate.ts:512-548` | added in #122; records every error event |
| Prior instance | `docs/reviews/37` §4.1, commit `4e7f9ae` | same Node-26-vs-`.nvmrc` mismatch, different symptom |

---

## 2. Design

### 2.1 A runtime guard on the paid LIVE entry points

The four `apps/worker` scripts that can spend money (`measure:completion-rate`, `spike:rag`,
`spike:claude`, `test:claude:live`) refuse to start unless the running Node's major version matches
`.nvmrc`. Fail closed, before the first provider call.

- Reads `.nvmrc` at startup — never a literal re-declared in the script, for the same reason
  `DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE` is imported rather than retyped
  (`agent-runtime.module.ts:63-71`): two independently-written numbers that agree today are exactly
  what drifts.
- **Major version only.** A patch-level mismatch does not change the bundled undici, and demanding
  an exact match would make the guard fire on differences that cannot affect the transport —
  a guard that cries wolf gets bypassed.
- The message must name the actual consequence and how to fix it, not just report a mismatch.
- **Not** applied to `eval`, `demo`, `demo:rag`, or the CI suites: they spend nothing, and widening
  the guard to every script would make it an ambient annoyance rather than a spend control.

### 2.2 Record the ALPN finding where it will be looked for

`docs/10-engineering-challenges.md` gains the §0.1 table and its consequence. That file is where
prior engineering findings live and is already linked from `AGENTS.md`.

The entry must state both halves honestly: the deployed runtime is not exposed, **and** a future
base-image bump to Node ≥26 would introduce `h2` into a code path that shares one client across every
run — so the bump is the trigger to revisit, not a reason to act now.

### 2.3 Correct the two issues' records

- **#125** — comment recording §0.1: the production-defect claim is refuted by the runtime pin, the
  measurement almost certainly ran on Node 26, the residual is the unpinned worker script. Then
  close it, since §2.1 addresses what is left.
- **#123** — comment recording §0.2 and §0.3: the log-side gap is already closed; the persisted-field
  version is deferred with its cost stated (§5); the public split is refused outright, with the
  doc citation. **Recommend keeping it open** as the record of a deferred decision.

### 2.4 The stale README line

`README.md:370` — *"No milestone is currently open and there are no open issues."* — was true when
written and is not now (#123–#126 are open). One line, corrected in this PR rather than given its
own paid review round.

---

## 3. What this deliberately does NOT do

- **No change to `api-provider-factory.ts`.** The shared client is correct as designed (it exists so
  a live deployment reuses its connection pool), and the one fault that would punish it is
  unreachable on the pinned runtime. Changing it would be speculative hardening against a state the
  deployment cannot enter — `CONTEXT.md`'s posture forbids exactly this.
- **No new `AgentOrchestratorErrorCode` member.** §0.3.
- **No forced HTTP/1.1 / `setGlobalDispatcher` call.** Node 22 already negotiates `http/1.1`;
  pinning it in code would encode the current default as an invariant while adding a direct `undici`
  dependency the repo does not have.
- **No contract, schema, migration, reducer, Python-mirror, or UI change.** None is reachable from
  the scope above.

---

## 4. Verification plan — and its limits

| # | Case | Expect |
| --- | --- | --- |
| 1 | Guard under `.nvmrc`'s Node | script proceeds normally |
| 2 | Guard under a mismatched major | exits non-zero **before** any provider call, naming both versions |
| 3 | Guard when `.nvmrc` is unreadable | fails closed with a distinct message — never a silent pass |
| 4 | Guard parses `.nvmrc` with trailing newline / `v` prefix | both accepted |
| 5 | Non-spending scripts (`eval`, `demo`) | unaffected under any Node |
| 6 | `pnpm agent:verify --final` **on Node 22.21.0** | `status: PASS`, all four steps executed |

Case 2 must be shown to fail against pre-change code (no guard ⇒ script proceeds) before being
trusted green. Case 6 must run on `.nvmrc`'s version — this is `docs/reviews/37`'s acceptance
criterion 7, and running it on Node 26 reproduces the four `apps/web` localStorage failures and
fail-fasts before `build`.

**What this cannot prove, and must not be claimed:**

- That Node 22 prevents the TLS fault. It prevents *one failure chain* that requires an `h2`
  session. A TLS fault on HTTP/1.1 is still possible and kills one socket.
- That the completion-rate measurement would have succeeded on Node 22. The 35 lost invocations
  cannot be re-attributed retrospectively — the rounds recorded no runtime version. Any write-up
  must say the runs were lost to an `h2` session fault *that the deployed runtime does not
  negotiate*, not that they would otherwise have completed.
- That the measurement ran on Node 26. Inferred (§0.1), not recorded. **The cheap confirmation:** a
  1-run round on Node 22 with the ALPN probe attached costs roughly one provider call and would
  record the transport directly. Worth doing as part of the next funded round, not as a round of its
  own.
- Anything about failure *attribution* quality. §2 changes no failure code.

---

## 5. Out of scope, with the deferred decision stated

- **An internal-only persisted field distinguishing our-fault from upstream-fault failures** (the
  surviving, non-leaking form of #123). Cost, from the repo's own precedents
  (`docs/reviews/45` §6, and the ledger contract's "waves" warning): an enum or field on a persisted
  event, the reducer's `satisfies Record<…>` exhaustiveness entry, the Python mirror at
  `services/evaluation/.../schemas.py:125-138`, `docs/16`'s table, plus a typecheck wave, a per-package
  unit wave, and an integration wave. **Its consumer does not exist yet** — there is no operator
  dashboard or aggregate query reading `failure_code`, and the one historical consumer (the
  completion-rate script) already gets the distinction from the log. Recommend deferring until
  something actually queries it.
- #124 (tool inputs/outputs absent from the trace) and #126 (in-flight ledger entry). Unaffected by
  this plan; #126 remains worth doing before the next paid round, as its own text says.
- Any LIVE run. Nothing here needs one, and none should be spent on it.
- Any change to the shared-client lifecycle (§3).

---

## 6. Sequencing

1. Confirm `.nvmrc` is present in every context the guarded scripts run from, and that reading it
   from `apps/worker` resolves to the repo root — verify by path, do not assume.
2. Add the guard + its tests (§4 cases 1–5). Prove case 2 fails against pre-change code.
3. `docs/10-engineering-challenges.md` entry (§2.2); `README.md:370` (§2.4).
4. `pnpm agent:verify --final` **on Node 22.21.0** (`export PATH="$HOME/.nvm/versions/node/v22.21.0/bin:$PATH"`).
5. Post the #125 and #123 comments (§2.3). Close #125; leave #123 open.

Integration suites are not required: nothing here touches persistence.

---

## 7. Acceptance criteria

1. Each of the four spending scripts refuses to start on a mismatched Node major, before any
   provider call, naming the expected version, the running version, and the remedy.
2. The expected version is read from `.nvmrc` at runtime — no literal version string in any guarded
   script.
3. An unreadable `.nvmrc` fails closed, distinguishably from a version mismatch.
4. Non-spending scripts and the CI suites are unaffected.
5. `docs/10-engineering-challenges.md` records the ALPN table, names Node ≥26 as the trigger to
   revisit the shared client, and does **not** claim the TLS fault is fixed.
6. No file in `packages/contracts`, `packages/database`, `services/evaluation`, or `apps/web` is
   modified, and no new `AgentOrchestratorErrorCode` member exists.
7. `README.md` no longer claims there are no open issues.
8. #125's comment states that its production-impact claim is refuted and why; #123's states that the
   public split is refused on disclosure grounds, citing `docs/04-agent-design.md:913`.
9. No commit message, doc line, or issue comment claims that Node 22 prevents TLS faults, or that
   the lost measurement runs would otherwise have completed.
10. `pnpm agent:verify --final` passes on `.nvmrc`'s Node version, with all four steps executed.

---

See #125 and #123 for the filed issues, `docs/reviews/48` for the measurement whose losses prompted
them, and `docs/reviews/37` §4.1 (commit `4e7f9ae`) for the first instance of the same Node-version
mismatch.
