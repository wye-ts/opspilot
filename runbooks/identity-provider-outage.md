---
runbookId: identity-provider-runbook
serviceSlug: identity-provider
category: AUTHENTICATION
---

# Identity Provider Outage

## Identity Provider Unreachable — Symptoms

<!-- chunkId: runbook-identity-provider-outage-001 -->

When the upstream identity provider is unreachable, sign-in requests hang and
eventually time out instead of returning a clean rejection. Users already holding
a valid session are unaffected, which is what distinguishes an upstream provider
outage from a credential problem on our own side.

## Identity Provider Certificate Rotation

<!-- chunkId: runbook-identity-provider-outage-002 -->

A rotated SAML signing certificate that was never uploaded to our metadata store
causes every new sign-in to be rejected with an invalid signature error. Check the
certificate expiry recorded in the identity provider metadata before restarting
anything on our side.
