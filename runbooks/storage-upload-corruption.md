---
runbookId: storage-upload-corruption-runbook
serviceSlug: object-storage
category: DATA_QUALITY
---

# Storage Upload Corruption

## Object Storage Uploads Rejected For A Checksum Mismatch

<!-- chunkId: runbook-storage-upload-corruption-001 -->

Uploads to object storage are rejected with a checksum mismatch when the bytes that
arrived differ from the digest the client declared. The bucket has plenty of remaining
space, so this is a corruption problem rather than a capacity problem — a truncated
multipart part or a proxy rewriting the body are the usual causes. Re-upload from the
original source and compare digests.
