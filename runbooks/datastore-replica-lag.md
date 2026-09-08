---
runbookId: datastore-replica-runbook
serviceSlug: datastore
category: SERVICE_DEGRADATION
---

# Datastore Replica Lag

## Datastore Read Replica Lag — Symptoms

<!-- chunkId: runbook-datastore-replica-lag-001 -->

Read replica lag presents as intermittent stale reads and slow read queries across
multiple services that share the same replica. Compare the replication delay metric
against the primary's write volume; a bulk import or a long-running migration is the
usual cause, and the primary itself stays healthy throughout.

## Datastore Replica Lag Remediation

<!-- chunkId: runbook-datastore-replica-lag-002 -->

Pause the bulk writer, let the replica catch up, and only then route reads back to it.
Promoting the replica while it is still behind loses the un-replicated writes, so never
promote to clear lag.
