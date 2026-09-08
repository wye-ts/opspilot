---
runbookId: storage-quota-exhaustion-runbook
serviceSlug: object-storage
category: CONFIGURATION
---

# Storage Quota Exhaustion

## Object Storage Uploads Rejected When A Bucket Quota Is Full

<!-- chunkId: runbook-storage-quota-exhaustion-001 -->

Uploads to object storage are rejected with an insufficient-space error once a bucket
reaches its configured quota. The bytes that were accepted before the quota was reached
are intact and readable, so this is a capacity problem rather than a corruption problem.
Raise the bucket quota or expire old objects, then replay the rejected uploads.
