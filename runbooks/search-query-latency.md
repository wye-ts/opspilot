---
runbookId: search-query-latency-runbook
serviceSlug: search-service
category: SERVICE_DEGRADATION
---

# Search Query Latency

## Search Results Returning Slowly

<!-- chunkId: runbook-search-query-latency-001 -->

Search requests take several seconds to return when a shard is rebalancing or a wildcard
filter forces a full scan of the search cluster. Every record that should match is still
present in the results, so the symptom is slow rather than missing results. Check the
per-shard search latency percentiles before touching the indexing pipeline.
