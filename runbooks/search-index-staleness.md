---
runbookId: search-index-staleness-runbook
serviceSlug: search-service
category: DATA_QUALITY
---

# Search Index Staleness

## Search Results Missing Recently Created Records

<!-- chunkId: runbook-search-index-staleness-001 -->

Recently created records are absent from search results when the indexing pipeline has
stopped consuming its change stream. Every search request still returns quickly and the
search cluster reports green, so the only visible symptom is missing rather than slow
results. Compare the newest indexed document timestamp against the newest record
timestamp to confirm.

## Search Reindex Procedure

<!-- chunkId: runbook-search-index-staleness-002 -->

Restart the indexing pipeline from the last committed change-stream offset, then verify
the indexed document count converges on the record count. A full reindex is only needed
when the offset itself is unrecoverable.
