# OpsPilot — AI Support & Incident Resolution Agent

## Product Requirements Document v1

## 1. Overview

OpsPilot is an AI-powered support and incident resolution agent designed to help support engineers and on-call engineers triage tickets, investigate operational issues, retrieve relevant runbooks, analyze logs, and generate recommended resolutions.

The system combines LLM reasoning, tool calling, retrieval-augmented generation, human approval workflows, and trace logging to create a production-style AI agent for support operations.

The goal of the MVP is to demonstrate a practical AI agent system that can handle a full support investigation workflow from ticket intake to resolution recommendation.

---

## 2. Problem Statement

Support and on-call engineers often spend significant time manually investigating recurring operational issues. A typical workflow may require reading a support ticket, searching internal documentation, checking service health, inspecting logs, finding similar incidents, and drafting a customer or internal response.

This process is repetitive, time-consuming, and error-prone.

OpsPilot aims to reduce investigation time by allowing an AI agent to perform the first pass of ticket triage and incident investigation while keeping humans in control of final actions.

---

## 3. Target Users

### Primary Users

**Support Engineers**

Support engineers use OpsPilot to quickly understand customer-reported issues, identify likely causes, and draft responses.

**On-call Engineers**

On-call engineers use OpsPilot to investigate production-like incidents, review logs, check service status, and follow runbook guidance.

### Secondary Users

**Engineering Managers**

Engineering managers use OpsPilot to review incident patterns, agent performance, and ticket resolution quality.

---

## 4. Goals

The MVP should demonstrate that OpsPilot can:

*Note: this project uses two completion milestones, defined in `docs/03-technical-design.md §30`. **Feature Complete** means the project runs locally and passes its required tests. **Portfolio Ready** additionally requires the public deployment referenced below. The goals in this section describe the full Portfolio Ready vision; reaching Feature Complete does not itself require public deployment.*

1. Classify incoming support tickets by issue type.
2. Retrieve relevant runbook documentation using RAG.
3. Call diagnostic tools to gather evidence.
4. Generate a probable root cause and recommended next steps.
5. Draft a customer-facing or internal response.
6. Require human approval before performing state-changing actions.
7. Save an agent trace for every investigation.
8. Provide enough observability to debug agent behavior.

---

## 5. Non-Goals

The MVP will not include:

1. Real Jira, Zendesk, Slack, Datadog, or PagerDuty integrations.
2. Real production log ingestion.
3. Real customer data.
4. Multi-agent collaboration.
5. Model fine-tuning.
6. Complex authentication and role-based access control.
7. Automatic execution of risky production actions.
8. Mobile support.
9. Full enterprise admin settings.

All external systems will be represented using mock data or simulated tools.

---

## 6. MVP Scope

The MVP will include four main product areas:

### 6.1 Ticket Inbox

Users can view a list of mock support tickets.

Each ticket should include:

* Ticket title
* Description
* Customer name or account
* Priority
* Status
* Created time
* Issue category, if already classified

Users can open a ticket detail page and start an AI investigation.

---

### 6.2 Agent Investigation

When a user clicks “Analyze Ticket,” OpsPilot starts an agent run.

The agent should:

1. Read the ticket content.
2. Classify the issue.
3. Retrieve relevant runbook sections.
4. Decide which diagnostic tools to call.
5. Call one or more tools.
6. Analyze the returned evidence.
7. Generate a resolution summary.

The UI should display the agent’s investigation steps in a trace panel.

Each step should show:

* Step name
* Tool used, if any
* Input summary
* Output summary
* Timestamp
* Status

---

### 6.3 Runbook Knowledge Base

Users can manage a simple knowledge base of operational runbooks.

The MVP should support:

* Seeded markdown runbooks
* Runbook search
* Chunking runbook content
* Embedding runbook chunks
* Retrieving relevant chunks during agent investigation
* Returning citations in the final answer

Example runbooks:

* Password reset email not received
* Elevated API error rate
* Payment webhook failure
* Account verification delay
* Notification delivery troubleshooting

---

### 6.4 Resolution Panel

After investigation, OpsPilot should generate a structured resolution report.

The report should include:

* Issue category
* Probable root cause
* Confidence level
* Evidence summary
* Referenced runbook citations
* Recommended next steps
* Customer response draft
* Internal engineering note
* Suggested action

If the suggested action modifies ticket state, creates an escalation, or drafts a customer-facing reply, it must require human approval. `DRAFT_CUSTOMER_REPLY` produces a draft only — the MVP does not send a real email or message to the customer; see `§9.2`.

---

## 7. Key User Flows

### Flow 1: Analyze a Support Ticket

1. User opens Ticket Inbox.
2. User selects a ticket.
3. User clicks “Analyze Ticket.”
4. Agent classifies the ticket.
5. Agent retrieves relevant runbook sections.
6. Agent calls diagnostic tools.
7. Agent generates a resolution.
8. User reviews the result.

---

### Flow 2: Approve a Suggested Action

1. Agent recommends a state-changing action.
2. UI displays the pending action.
3. User reviews the action.
4. User clicks “Approve” or “Reject.”
5. If approved, the backend executes the simulated action.
6. The action result is saved in the agent trace.

Approval always occurs after the investigation has produced its final resolution report (Flow 1, step 7). The agent does not pause mid-investigation and wait for a decision before continuing — a suggested action is a field inside the completed report, not an interactive checkpoint inside the agent loop. See `docs/03-technical-design.md §13.1`.

---

### Flow 3: Review Agent Trace

1. User opens a completed ticket investigation.
2. UI displays the agent trace.
3. User reviews tool calls, retrieved documents, and final reasoning summary.
4. User can identify why the agent reached its conclusion.

---

## 8. Agent Capabilities

The agent should support the following capabilities:

### 8.1 Ticket Classification

The agent classifies tickets into categories such as:

* Authentication
* Email delivery
* Payment
* API error
* Account verification
* Notification delivery
* Infrastructure
* Unknown

### 8.2 Runbook Retrieval

The agent retrieves relevant runbook chunks using semantic search.

The final answer should cite retrieved runbook sections when possible.

### 8.3 Tool Calling and Proposed Actions

The agent can call read-only diagnostic tools to gather additional evidence during an investigation:

* `search_runbooks`
* `search_logs`
* `check_service_status`
* `find_similar_incidents`
* `lookup_customer_account`

These are the only tools the agent can directly execute, and they may run automatically.

Separately, the agent may propose approval-required actions as part of its final resolution report (see `§8.4`, `§9.2`):

* `UPDATE_TICKET_STATUS`
* `CREATE_ESCALATION`
* `DRAFT_CUSTOMER_REPLY`

These are not tools the agent executes directly — they are typed proposals inside the completed report, and each requires human approval before the application performs the corresponding simulated action. See `docs/03-technical-design.md §14.4`.

### 8.4 Resolution Generation

The agent generates a structured resolution report based on:

* Ticket content
* Retrieved runbook context
* Tool outputs
* Similar incidents
* Service status
* Log evidence

---

## 9. Tool and Action Safety Model

OpsPilot separates agent-executable read-only diagnostic tools from agent-proposed approval-required actions. Only the former are directly executable by the agent; the latter are always proposals requiring human approval, never directly executable tools.

### 9.1 Safe Read-Only Diagnostic Tools

These tools can run automatically, directly executed by the agent:

* Search runbooks
* Search logs
* Check service status
* Find similar incidents
* Look up customer account

### 9.2 Approval-Required Actions

These are **not directly executable agent tools**. They are typed proposals the agent includes in its final resolution report, and each requires human approval before the application performs the corresponding simulated action:

* `UPDATE_TICKET_STATUS`
* `CREATE_ESCALATION`
* `DRAFT_CUSTOMER_REPLY`

This is the canonical MVP action set and matches `docs/03-technical-design.md §14.4` and `§8.3` above. Earlier drafts of this document additionally listed "assign ticket owner," "mark ticket as resolved," and "send customer reply" as separate action types; those are superseded by this list and are not part of the MVP.

The MVP will simulate these actions instead of calling real external services.

---

## 10. Data Requirements

The MVP should include mock data for:

* Support tickets
* Customers
* Services
* Logs
* Runbooks
* Similar incidents
* Agent traces
* Approval actions

No real customer or production data should be used.

---

## 11. Success Metrics

The MVP should be evaluated using both engineering and AI quality metrics.

### Product Metrics

* Percentage of tickets successfully analyzed
* Percentage of tickets with relevant runbook citations
* Number of tickets requiring human approval
* Average investigation completion time

### AI Quality Metrics

* Ticket classification accuracy
* Tool selection accuracy
* Citation correctness
* Resolution quality
* Hallucination rate

### System Metrics

* p95 agent run latency
* Token usage per run
* Estimated cost per run
* Tool failure rate
* Agent run failure rate

---

## 12. Evaluation Plan

The project should include a small evaluation dataset.

Each eval case should include:

* Input ticket
* Expected issue category
* Expected tools
* Expected runbook reference
* Expected key evidence
* Expected resolution points

Example:

```json
{
  "ticket": "Users are not receiving password reset emails after submitting the reset form.",
  "expected_category": "email_delivery",
  "expected_tools": ["search_runbooks", "check_service_status", "search_logs"],
  "expected_resolution_contains": ["password reset", "email provider", "delivery logs"]
}
```

The eval runner should measure:

* Whether the category is correct
* Whether the expected tools were used
* Whether retrieved runbook sections were relevant
* Whether the answer contains unsupported claims
* Latency and token usage

---

## 13. Functional Requirements

### Ticket Management

* Users can view tickets.
* Users can open ticket details.
* Users can start an AI investigation.
* Users can view ticket status.

### Agent Execution

* System can create an agent run.
* System can store each agent step.
* System can call tools.
* System can store tool results.
* System can generate final resolution output.

### Runbook Retrieval

* System can store runbook content.
* System can chunk runbooks.
* System can create embeddings.
* System can retrieve relevant chunks.
* System can include citations in final output.

### Human Approval

* System can identify actions requiring approval.
* User can approve or reject an action.
* System records approval status.
* System executes approved simulated actions.

### Trace Logging

* System records agent run metadata.
* System records tool calls.
* System records tool results.
* System records final output.
* System records errors.

---

## 14. Non-Functional Requirements

### Reliability

The system should handle LLM failures, tool errors, and invalid outputs gracefully.

### Observability

Every agent run should be traceable from ticket input to final output.

### Security

The agent should not execute state-changing actions without human approval.

### Maintainability

The tool system should be modular so new tools can be added easily.

### Testability

Core tools, APIs, and agent workflows should be testable through automated tests.

---

## 15. Recommended Tech Stack

### Frontend

* React
* TypeScript
* Vite
* Tailwind CSS or simple CSS modules

### Backend

* NestJS
* TypeScript
* Prisma
* PostgreSQL
* pgvector
* PostgreSQL-backed job execution (`AgentJob`) — see `docs/03-technical-design.md §16`. Redis and BullMQ were evaluated and are not part of the MVP; see `docs/10-engineering-challenges.md` Challenge 1.

### AI

* Claude API
* Tool calling
* Structured JSON output
* Embeddings for runbook retrieval

### DevOps

* Docker Compose
* GitHub Actions
* Vercel for frontend
* Render, Railway, or Fly.io for backend
* Neon or Supabase for PostgreSQL

---

## 16. MVP Acceptance Criteria

The MVP is complete when:

1. A user can view seeded support tickets.
2. A user can open a ticket and start an AI investigation.
3. The agent can classify the ticket.
4. The agent can retrieve relevant runbook sections.
5. The agent can call at least two diagnostic tools.
6. The agent can generate a structured resolution report.
7. The UI shows the agent trace.
8. State-changing actions require approval.
9. The system stores agent run history.
10. The project includes basic tests and eval cases.
11. The README explains architecture, setup, agent workflow, and evaluation results.

---

## 17. Future Enhancements

After the MVP, possible enhancements include:

1. Slack integration
2. Jira integration
3. Zendesk integration
4. Datadog or OpenTelemetry log ingestion
5. Multi-agent investigation workflow
6. Admin dashboard for agent performance
7. A dedicated prompt-injection detection model or classifier (structural defenses — data boundaries, tool restriction, approval enforced in code — are already required in the MVP; see `docs/03-technical-design.md §19.3`)
8. Better access control
9. Automated regression evals in CI
10. Model comparison dashboard
11. Fine-tuned ticket classification model
12. Production-grade deployment hardening (multi-region availability, formal SLAs, dedicated observability and alerting) and real external integrations that replace the MVP's simulated actions with actual API calls — requiring the separate idempotent action design described in `docs/03-technical-design.md §8.2` and `§33` (open question 6), not merely swapping mock data for real credentials

---

## 18. Resume Positioning

This project should be positioned as a production-style AI agent system, not a chatbot.

**These are templates, not current claims.** The project has not been implemented yet. Every description and bullet below is a target for use *after* the corresponding functionality has been implemented and validated — do not publish or claim any of this text before the underlying work, tests, and measurements actually exist (see `docs/03-technical-design.md §31 Portfolio and Resume Deliverables`, which requires resume claims to use measured results from the finished project, never invented numbers).

Planned resume description:

**OpsPilot — AI Support & Incident Resolution Agent**

Built a production-style AI agent using Claude, NestJS, React, PostgreSQL, and pgvector, with tool-calling workflows to triage support tickets, retrieve operational runbooks, inspect simulated logs, generate resolution plans, and require human approval before state-changing actions.

Potential future resume bullets:

* Built an AI support operations agent with Claude tool calling, RAG, and structured agent traces to investigate support tickets and generate resolution plans.
* Implemented runbook retrieval with PostgreSQL, pgvector, document chunking, embeddings, and citation-grounded responses.
* Designed modular read-only diagnostic tools for log search, service health checks, account lookup, runbook retrieval, and similar-incident search, plus typed human-approved action proposals for escalations, ticket updates, and customer-response drafts.
* Added human-in-the-loop approval controls for state-changing actions to improve agent safety and production readiness.
* Created eval cases to measure classification accuracy, tool selection quality, citation correctness, hallucination risk, latency, and token cost.
