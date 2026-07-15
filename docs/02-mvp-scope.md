# OpsPilot — MVP Scope v1

## 1. Purpose

This document defines the MVP scope for OpsPilot, an AI Support and Incident Resolution Agent.

The goal of the MVP is to build a small but complete production-style AI agent workflow that demonstrates:

- Ticket triage
- LLM tool calling
- Runbook retrieval
- Diagnostic investigation
- Agent trace logging
- Human approval for state-changing actions
- Structured resolution generation

The MVP should be focused enough to complete quickly, but strong enough to demonstrate real AI agent engineering ability.

---

## 2. MVP Goal

The MVP should allow a user to open a support ticket, run an AI investigation, review the agent's steps, inspect the evidence, and approve or reject a suggested action.

The core user flow is:

```text
Open ticket
→ Click "Analyze Ticket"
→ Agent classifies the issue
→ Agent retrieves relevant runbooks
→ Agent calls diagnostic tools
→ Agent generates a structured resolution
→ User reviews the agent trace
→ User approves or rejects a suggested action
```

The MVP is successful when this flow works end-to-end with seeded mock data.

---

## 3. MVP Principles

The MVP should follow these principles:

1. **Small but complete**
   - Build one complete workflow instead of many incomplete features.

2. **Mock external systems**
   - Use simulated logs, services, customers, and incidents instead of real third-party integrations.

3. **Agent behavior must be visible**
   - Every agent run should produce trace logs showing what happened.

4. **Actions must be safe**
   - Read-only tools can run automatically.
   - State-changing tools require human approval.

5. **RAG should be grounded**
   - The agent should retrieve relevant runbook sections and include citations when possible.

6. **Implementation should stay portfolio-ready**
   - The project should be easy to explain in a README, demo, and interview.

---

## 4. In Scope

The MVP includes the following features.

### 4.1 Ticket Inbox

The system should provide a ticket inbox page with seeded mock support tickets.

Each ticket should include:

- ID
- Title
- Description
- Customer name
- Priority
- Status
- Created time
- Optional issue category

The user should be able to:

- View all tickets
- Select a ticket
- Open a ticket detail page

### 4.2 Ticket Detail Page

The ticket detail page should display:

- Ticket title
- Ticket description
- Customer information
- Priority
- Status
- Created time
- Current investigation status
- Button to start AI analysis

The primary action on this page is:

```text
Analyze Ticket
```

Clicking this button should start an agent investigation.

### 4.3 Agent Investigation Flow

The agent should perform a multi-step investigation.

The MVP agent flow should include:

1. Read the ticket.
2. Classify the issue category.
3. Retrieve relevant runbook sections.
4. Select diagnostic tools.
5. Call one or more tools.
6. Analyze the evidence.
7. Generate a structured resolution report.
8. Propose a next action if needed.

The agent should not perform unlimited reasoning or unlimited tool calls.

Recommended limits:

- Maximum tool calls per investigation: 5
- Maximum retrieved runbook chunks: 5
- Maximum agent runtime target: under 30 seconds for local/demo usage

### 4.4 Agent Trace Panel

The UI should display an agent trace for each investigation.

Each trace step should include:

- Step name
- Step type
- Status
- Timestamp
- Tool name, if applicable
- Input summary
- Output summary
- Error message, if applicable

Example step types:

- `classification`
- `retrieval`
- `tool_call`
- `analysis`
- `final_report`
- `approval_required`
- `action_executed`

The goal is to make the agent inspectable and debuggable.

### 4.5 Runbook Knowledge Base

The MVP should include seeded markdown runbooks.

Initial runbooks:

- Password reset email not received
- Elevated API error rate
- Payment webhook failure
- Account verification delay
- Notification delivery troubleshooting

The system should support:

- Reading markdown runbooks from the repo
- Splitting runbooks into chunks
- Creating embeddings for chunks
- Storing chunks in PostgreSQL with pgvector
- Retrieving relevant chunks during ticket investigation
- Returning citation metadata to the agent

Each retrieved chunk should include:

- Runbook ID
- Runbook title
- Section heading
- Chunk text
- Similarity score

### 4.6 Diagnostic Tools

The MVP should include mock diagnostic tools.

Read-only tools:

- `search_runbooks`
- `search_logs`
- `check_service_status`
- `find_similar_incidents`
- `lookup_customer_account`

State-changing tools:

- `update_ticket_status`
- `create_escalation`
- `draft_customer_reply`

Read-only tools may execute automatically.

State-changing tools must create a pending approval request before execution.

### 4.7 Resolution Report

After the investigation, the agent should generate a structured resolution report.

The report should include:

- Issue category
- Probable root cause
- Confidence level
- Evidence summary
- Runbook citations
- Tools used
- Recommended next steps
- Customer response draft
- Internal engineering note
- Suggested action

The report should be stored and displayed in the UI.

### 4.8 Human Approval Flow

The MVP should include human approval for state-changing actions.

When the agent suggests an action such as updating a ticket status or creating an escalation, the system should:

1. Create a pending action.
2. Display the action to the user.
3. Allow the user to approve or reject it.
4. Execute the simulated action only after approval.
5. Save the approval decision in the agent trace.

The MVP should not allow the agent to directly perform state-changing actions without approval.

### 4.9 Agent Run History

The system should persist agent runs.

Each agent run should include:

- Agent run ID
- Ticket ID
- Status
- Started time
- Completed time
- Model name
- Final report
- Error message, if any
- Token usage, if available
- Latency, if available

Users should be able to view the latest investigation result for a ticket.

### 4.10 Basic Evaluation Cases

The MVP should include a small set of eval cases.

Initial eval cases should cover:

- Email delivery issue
- API error rate issue
- Payment webhook issue
- Account verification issue
- Unknown or ambiguous issue

Each eval case should define:

- Input ticket
- Expected category
- Expected tools
- Expected runbook reference
- Expected resolution points

The MVP eval runner should measure:

- Category correctness
- Expected tool usage
- Presence of relevant citations
- Required resolution keywords
- Latency
- Basic pass/fail result

### 4.11 Basic CI

The MVP should include a basic GitHub Actions workflow.

CI should run:

- Install dependencies
- Type check
- Lint
- Unit tests
- Build backend
- Build frontend

The first CI version does not need full deployment automation.

---

## 5. Out of Scope

The following features are intentionally excluded from the MVP.

### 5.1 Real Third-Party Integrations

The MVP will not integrate with:

- Jira
- Zendesk
- Slack
- Datadog
- PagerDuty
- Sentry
- OpenTelemetry production pipelines
- Real customer databases

All external systems should be simulated with mock data and local tools.

### 5.2 Real Production Actions

The MVP will not perform real production actions such as:

- Restarting services
- Changing configuration
- Deleting data
- Sending real customer emails
- Creating real Jira tickets
- Paging real on-call engineers

All state-changing actions should be simulated.

### 5.3 Multi-Agent System

The MVP will not include multiple specialized agents.

Examples of excluded agents:

- Triage agent
- Investigation agent
- Response agent
- Manager review agent
- Escalation agent

The MVP should use one main agent executor.

### 5.4 Fine-Tuning

The MVP will not include:

- Model fine-tuning
- LoRA or QLoRA
- Custom model training
- Training data pipelines

The MVP should use hosted LLM APIs.

### 5.5 Complex Authentication

The MVP will not include full authentication or enterprise authorization.

Excluded features:

- OAuth login
- SSO
- Role-based access control
- Team management
- Admin settings

A simple mock user or no-auth local demo is acceptable.

### 5.6 Advanced Analytics Dashboard

The MVP will not include a full analytics dashboard.

Excluded features:

- Long-term trend analysis
- Team performance analytics
- Cost dashboard
- Model comparison dashboard
- Advanced incident reporting

Basic eval results and trace data are enough for the MVP.

### 5.7 Production Deployment Automation

The MVP does not require full production deployment.

Optional deployment is acceptable, but the MVP is considered complete if it runs locally with clear setup instructions.

---

## 6. First Vertical Slice

The first vertical slice should be the smallest end-to-end version of the product.

The first vertical slice includes:

1. Seed mock tickets in the database.
2. Display tickets in the frontend.
3. Open a ticket detail page.
4. Click `Analyze Ticket`.
5. Backend calls Claude with ticket content.
6. Agent returns a basic structured analysis.
7. Frontend displays the analysis result.

This first slice does not need:

- Real RAG
- Multiple tools
- Approval flow
- Eval runner
- Full trace logging

The purpose of the first vertical slice is to connect the frontend, backend, database, and LLM call.

---

## 7. MVP Build Order

The recommended build order is:

### Phase 1: Planning

- PRD
- MVP scope
- Technical design
- Agent design
- Tool design
- RAG design
- Evaluation plan

### Phase 2: Project Scaffold

- Monorepo structure
- React frontend app
- NestJS backend app
- PostgreSQL setup
- Prisma setup
- Docker Compose
- Environment variables
- Basic README

### Phase 3: Ticket Vertical Slice

- Ticket database model
- Seed ticket data
- Ticket list API
- Ticket detail API
- Ticket inbox UI
- Ticket detail UI
- Basic frontend-backend integration

### Phase 4: Basic Agent

- Claude client
- Agent run model
- Basic ticket analysis endpoint
- Structured JSON output
- Simple agent result UI

### Phase 5: Tools

- Tool registry
- Mock diagnostic tools
- Tool call execution
- Tool result persistence
- Tool trace display

### Phase 6: RAG

- Runbook markdown files
- Runbook ingestion script
- Chunking
- Embeddings
- pgvector storage
- Runbook retrieval
- Citation display

### Phase 7: Approval Flow

- Pending action model
- Approval UI
- Approve/reject endpoint
- Simulated action execution
- Approval trace logging

### Phase 8: Evals and CI

- Eval case format
- Eval runner
- Basic scoring
- GitHub Actions CI
- Tests and build validation

### Phase 9: Portfolio Polish

- README
- Architecture diagram
- Agent workflow diagram
- Screenshots
- Demo script
- Resume bullets

---

## 8. MVP Acceptance Criteria

The MVP is complete when all of the following are true:

- A user can view seeded support tickets.
- A user can open a ticket detail page.
- A user can start an AI investigation.
- The agent can classify the ticket.
- The agent can retrieve relevant runbook context.
- The agent can call at least two diagnostic tools.
- The system stores agent trace steps.
- The UI displays the agent trace.
- The agent generates a structured resolution report.
- State-changing actions require human approval.
- The user can approve or reject a suggested action.
- The system stores the approval decision.
- The project includes at least five eval cases.
- The project includes basic automated tests.
- GitHub Actions runs lint, typecheck, tests, and build.
- The README explains how to run the project locally.
- The README explains the agent workflow and system architecture.

---

## 9. Demo-Ready Requirements

The project is demo-ready when a reviewer can:

1. Start the app locally using documented commands.
2. Open the frontend.
3. View mock support tickets.
4. Select a ticket.
5. Run the AI investigation.
6. Watch agent trace steps appear.
7. Review the final resolution report.
8. See runbook citations.
9. Approve or reject a suggested action.
10. Read the README and understand the architecture.

The demo should use mock data only.

No private data, real customer data, or real production credentials should be required.

---

## 10. Success Definition

The MVP should prove that OpsPilot is more than a chatbot.

It should demonstrate that the system can:

- Orchestrate an LLM agent workflow
- Retrieve grounded operational knowledge
- Call diagnostic tools
- Preserve traceability
- Require approval for risky actions
- Produce structured, reviewable resolutions

The project should be strong enough to discuss in interviews as a production-style AI agent system.

---

## 11. Implementation Boundary for Claude Code

When using Claude Code, implementation tasks should follow strict boundaries.

Claude Code should not be asked to build the entire project at once.

Each task should reference the relevant document and focus on one small scope.

Good task example:

```text
Read docs/02-mvp-scope.md and docs/03-technical-design.md.
Implement only the Ticket model, seed data, and GET /tickets APIs.
Do not implement agent logic yet.
```

Bad task example:

```text
Build the entire OpsPilot app.
```

The recommended workflow is:

```text
One issue
→ one focused Claude Code task
→ one pull request or commit
→ one review
→ merge
→ move issue to Done
```