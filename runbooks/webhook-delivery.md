---
runbookId: webhook-delivery-runbook
serviceSlug: webhook-dispatcher
category: SERVICE_DEGRADATION
---

# Webhook Delivery

## Third-Party Webhook Delivery Retries And Dead-Letter Parking

<!-- chunkId: runbook-webhook-delivery-001 -->

Outbound webhooks to a partner endpoint fail when that endpoint returns a 5xx or closes
the socket before responding. The dispatcher retries with exponential backoff for six
hours and then parks the event in the dead-letter store. Inspect the partner endpoint's
own availability before replaying anything from the dead-letter store.
