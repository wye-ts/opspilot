---
runbookId: notification-rate-limit-runbook
serviceSlug: notification-service
category: RATE_LIMITING
---

# Notification Rate Limit

## Notification Provider Rate Limit Rejections

<!-- chunkId: runbook-notification-rate-limit-001 -->

Outbound email and push providers begin returning HTTP 429 rejections once a
tenant exceeds its per-minute send allowance. This looks like slow delivery from
the customer side, but the notification worker pool is healthy and the provider
is actively throttling the tenant. Confirm the 429 reject rate in the egress log
before scaling workers, because adding capacity raises the reject rate instead of
clearing it.

## Notification Rate Limit Remediation Steps

<!-- chunkId: runbook-notification-rate-limit-002 -->

To clear a throttled notification tenant: lower the outbound send concurrency,
spread bulk sends across a longer window, and request a higher allowance from the
provider. Never immediately retry a rejected send — the retry counts against the
same allowance and extends the throttle window.
