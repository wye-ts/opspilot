---
runbookId: database-runbook
serviceSlug: database
category: CONFIGURATION
---

# Database Connections

## Database Connection Pool Saturation

<!-- chunkId: runbook-database-connection-saturation-001 -->

Connection pool saturation presents as intermittent timeouts across multiple services sharing the same database. Check active connection count against the configured pool size; a sudden spike in long-running queries or a leaked connection from a recent deploy are the most common causes.
