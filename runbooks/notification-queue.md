---
runbookId: notification-queue-runbook
serviceSlug: notification-service
category: SERVICE_DEGRADATION
---

# Notification Queue

## Notification Queue Backlog — Symptoms

<!-- chunkId: runbook-notification-queue-backlog-001 -->

A growing backlog in the notification queue presents as customers reporting delayed emails or push notifications, even when the notification-service itself reports OPERATIONAL. Backlogs typically follow a burst of ticket-related notifications or a slow downstream provider.

## Notification Queue Backlog — Remediation Steps

<!-- chunkId: runbook-notification-queue-backlog-002 -->

To remediate a notification queue backlog: verify downstream provider status, scale the notification worker pool if CPU-bound, and communicate expected delivery delays to affected customers. Do not purge the queue without confirming duplicate notifications are acceptable.
