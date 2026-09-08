---
runbookId: public-api-rate-limit-runbook
serviceSlug: public-api
category: RATE_LIMITING
---

# Public API Rate Limit

## Public API Rate Limit Exceeded

<!-- chunkId: runbook-public-api-rate-limit-001 -->

Integration partners receive HTTP 429 rejections once a client key exceeds its
published per-minute request quota. The edge tier enforces the quota before any
application code runs, so the throttled requests never appear in the application
log at all — only in the edge access log.

## Public API Quota Increase Procedure

<!-- chunkId: runbook-public-api-rate-limit-002 -->

Raising a partner's request quota requires a signed change record and a review of
the last seven days of request volume. Apply the new limit in the edge tier
configuration and confirm the 429 reject rate returns to zero within one minute.
