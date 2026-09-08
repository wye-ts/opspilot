---
runbookId: cache-invalidation-runbook
serviceSlug: edge-cache
category: DATA_QUALITY
---

# Cache Invalidation

## Stale Cache Entries After A Content Update

<!-- chunkId: runbook-cache-invalidation-001 -->

Users continue to see superseded content when an edge cache key was never purged after
a content update. The origin already serves the new body, so comparing the origin
response against the cached response is the fastest way to confirm a purge was missed
rather than a rendering defect.
