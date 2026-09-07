# Production image for the single-origin FAKE-provider deployment — see
# docs/08-cicd-deployment.md §13. Five stages: base -> deps -> build -> prod-deps -> runtime.

FROM node:22.21.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# packageManager in package.json (pnpm@11.13.1) pins the exact version
# corepack activates the first time `pnpm` runs inside /app, below.
RUN corepack enable
WORKDIR /app

# ---- dependencies: manifests + lockfile only, for maximal layer caching ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json               apps/api/
COPY apps/web/package.json               apps/web/
COPY apps/worker/package.json            apps/worker/
COPY packages/contracts/package.json     packages/contracts/
COPY packages/database/package.json      packages/database/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/provider-claude/package.json packages/provider-claude/
# --ignore-scripts is never used: pnpm-workspace.yaml's own allowBuilds
# block is the only way prisma/@prisma/engines/esbuild's install scripts run.
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY . .
RUN pnpm db:generate \
 && pnpm --filter @opspilot/api run build \
 && pnpm --filter @opspilot/web run build

# ---- production dependencies only ----
FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json               apps/api/
COPY apps/web/package.json               apps/web/
COPY apps/worker/package.json            apps/worker/
COPY packages/contracts/package.json     packages/contracts/
COPY packages/database/package.json      packages/database/
COPY packages/agent-runtime/package.json packages/agent-runtime/
COPY packages/provider-claude/package.json packages/provider-claude/
# "@opspilot/api..." = @opspilot/api plus its full dependency closure. As of
# PR 6B1 that closure includes @opspilot/provider-claude and, through it,
# @anthropic-ai/sdk: the API can now execute a requested LIVE run, so the SDK
# belongs in the runtime image. What the filter still excludes is voyageai and
# all of apps/web's dev-only dependencies.
#
# The SDK reaches only the server-side provider path. It is not a dependency of
# apps/web and therefore cannot enter the browser bundle — asserted
# independently by apps/web's build guard, which fails on the SDK specifier, on
# ANTHROPIC_API_KEY, and on a literal sk-ant-* credential.
RUN pnpm install --frozen-lockfile --prod --filter "@opspilot/api..."

# ---- runtime ----
FROM node:22.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 AGENT_RUN_PROVIDER_MODE=FAKE
WORKDIR /app

# Copied as one layer so pnpm's relative symlinks into node_modules/.pnpm/
# survive the stage copy (see docs/10-engineering-challenges.md Challenge 6)
# — never cherry-pick node_modules subdirectories.
COPY --from=prod-deps /app /app
COPY --from=build /app/apps/api/dist               apps/api/dist
COPY --from=build /app/apps/web/dist               apps/web/dist
COPY --from=build /app/packages/contracts/dist     packages/contracts/dist
COPY --from=build /app/packages/database/dist      packages/database/dist
COPY --from=build /app/packages/agent-runtime/dist packages/agent-runtime/dist
COPY --from=build /app/packages/provider-claude/dist packages/provider-claude/dist
COPY packages/database/prisma            packages/database/prisma
COPY packages/database/prisma.config.ts  packages/database/prisma.config.ts
# Runtime data, not build output: apps/api's RUNBOOK_RETRIEVER loads this
# corpus from disk at startup (issue #72 — see docs/08-cicd-deployment.md
# §17/§23). Copied from the build context directly, not --from=build.
COPY runbooks                            runbooks
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/opspilot-entrypoint

# Build-time assertions: fail the build now, not at container start. Node's
# require.resolve() walks up from the *file's* directory, not the process
# cwd — so each check runs from the package that actually declares the
# dependency (apps/api for the workspace packages it imports directly;
# packages/database for @prisma/client, which apps/api never depends on
# directly). The Prisma CLI path is verified, never assumed.
RUN test -x /app/packages/database/node_modules/.bin/prisma \
 && test -f /app/apps/api/dist/main.js \
 && test -f /app/apps/web/dist/index.html \
 && test -x /usr/local/bin/opspilot-entrypoint \
 && (cd /app/apps/api && node -e "require.resolve('@opspilot/database'); require.resolve('@opspilot/agent-runtime'); require.resolve('@opspilot/provider-claude')") \
 && (cd /app/packages/provider-claude && node -e "require.resolve('@anthropic-ai/sdk')") \
 && (cd /app/packages/database && node -e "require.resolve('@prisma/client')")

USER node
EXPOSE 3000
ENTRYPOINT ["opspilot-entrypoint"]
