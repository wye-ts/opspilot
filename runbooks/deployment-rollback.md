---
runbookId: deployment-rollback-runbook
serviceSlug: release-pipeline
category: CONFIGURATION
---

# Deployment Rollback

## Deployment Rollback Decision Criteria

<!-- chunkId: runbook-deployment-rollback-001 -->

Roll back a release when the error budget burn rate triples within ten minutes of a
rollout and the regression is reproducible on the new revision but not the previous
one. A rollback is cheaper than a forward fix whenever the defect is in application
code rather than in a schema migration that has already run.

## Deployment Rollback Execution Steps

<!-- chunkId: runbook-deployment-rollback-002 -->

Pin the release pipeline to the last known-good revision, drain traffic from the new
revision, and confirm the burn rate returns to its baseline. A rollback never reverts
an applied schema migration, so a migration-driven regression needs a forward fix
instead.
