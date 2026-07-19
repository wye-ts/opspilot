---
runbookId: auth-failures-runbook
serviceSlug: auth-service
category: AUTHENTICATION
---

# Authentication Failures

## Authentication Failures — Symptoms

<!-- chunkId: runbook-auth-failures-001 -->

Authentication failures present as customers unable to log in, elevated 401 responses from auth-service, or repeated password-reset requests. Check auth-service status and recent deploys before assuming a customer-side credential issue.

## Authentication Failures — Root Causes

<!-- chunkId: runbook-auth-failures-002 -->

Common root causes of authentication failures include an expired signing key, a misconfigured identity provider integration, or clock drift on auth-service hosts invalidating time-based tokens. Correlate with the most recent auth-service deploy timestamp.
