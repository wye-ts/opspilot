#!/bin/sh
set -e

# The first database contact in the container is `prisma migrate deploy`,
# not the application (see docs/08-cicd-deployment.md and
# docs/10-engineering-challenges.md Challenge 7). A Neon free-tier database
# that has auto-suspended needs a few seconds to wake, so the retry lives
# here — anywhere later is unreachable, because the container would already
# have exited. PrismaLifecycleService stays fail-fast and unchanged: this is
# the only retry policy in the system.

PRISMA_BIN="${PRISMA_BIN:-/app/packages/database/node_modules/.bin/prisma}"
ATTEMPTS="${MIGRATION_RETRY_ATTEMPTS:-5}"
DELAY_SECONDS="${MIGRATION_RETRY_DELAY_SECONDS:-3}"

# packages/database/prisma.config.ts unconditionally declares
# datasource.shadowDatabaseUrl. `migrate deploy` never connects to it — only
# `migrate dev`/`migrate diff` do — but Prisma 7.9's CLI still validates it
# for every command regardless of whether that command uses it: empty
# string fails with P1013 ("must not be an empty string"), and a value
# identical to DATABASE_URL is explicitly rejected too ("shadow database
# you configured appears to be the same as the main database") — both
# verified by running the real CLI in a container. The fixed .invalid
# placeholder (RFC 2606 — guaranteed never to resolve) satisfies both
# checks without creating any real second-database dependency.
export SHADOW_DATABASE_URL="${SHADOW_DATABASE_URL:-postgres://unused:unused@shadow-database.invalid:5432/unused_shadow}"

case "$ATTEMPTS" in
  *[!0-9]* | "")
    echo "MIGRATION_RETRY_ATTEMPTS must be a positive integer, got: '${ATTEMPTS}'" >&2
    exit 1
    ;;
esac
if [ "$ATTEMPTS" -lt 1 ]; then
  echo "MIGRATION_RETRY_ATTEMPTS must be a positive integer, got: '${ATTEMPTS}'" >&2
  exit 1
fi

case "$DELAY_SECONDS" in
  *[!0-9]* | "")
    echo "MIGRATION_RETRY_DELAY_SECONDS must be a non-negative integer, got: '${DELAY_SECONDS}'" >&2
    exit 1
    ;;
esac

# Only the exact lowercase strings "true"/"false" are accepted — a typo like
# "ture" must abort startup rather than silently being treated as "not
# true" and skipping migrations, which would let the API start against a
# potentially stale schema.
RUN_MIGRATIONS_ON_START="${RUN_MIGRATIONS_ON_START:-true}"
case "$RUN_MIGRATIONS_ON_START" in
  true | false) ;;
  *)
    echo "RUN_MIGRATIONS_ON_START must be exactly 'true' or 'false', got: '${RUN_MIGRATIONS_ON_START}'" >&2
    exit 1
    ;;
esac

run_migrations() {
  if [ ! -x "$PRISMA_BIN" ]; then
    echo "Prisma CLI not found or not executable at $PRISMA_BIN" >&2
    return 1
  fi

  cd /app/packages/database
  attempt=1
  while :; do
    if [ -n "$MIGRATION_DATABASE_URL" ]; then
      DATABASE_URL="$MIGRATION_DATABASE_URL" "$PRISMA_BIN" migrate deploy && return 0
    else
      "$PRISMA_BIN" migrate deploy && return 0
    fi

    if [ "$attempt" -ge "$ATTEMPTS" ]; then
      echo "prisma migrate deploy failed after ${attempt} attempt(s); aborting startup" >&2
      return 1
    fi

    echo "prisma migrate deploy attempt ${attempt}/${ATTEMPTS} failed; retrying in ${DELAY_SECONDS}s" >&2
    attempt=$((attempt + 1))
    sleep "$DELAY_SECONDS"
  done
}

if [ "$RUN_MIGRATIONS_ON_START" = "true" ]; then
  run_migrations
  cd /app
fi

exec node apps/api/dist/main.js
