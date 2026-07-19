---
runbookId: notification-service-runbook
serviceSlug: notification-service
category: SERVICE_DEGRADATION
---

# Notification Service

## Notification Service Degradation

<!-- chunkId: runbook-notification-degradation-001 -->

The notification-service reports a DEGRADED status when downstream email or push delivery providers are slow to acknowledge requests. Symptoms include delayed notification emails and a rising queue depth on the notification worker. Confirm the service status via get_service_status before escalating.
