#!/usr/bin/env bash
# Authoritative, idempotent creation of the opspilot_test and opspilot_shadow
# databases.
#
# docker/postgres-init/001-create-test-db.sql only runs on a brand-new
# Postgres data volume (first container boot). This script is what actually
# guarantees both databases exist, safe to rerun on a fresh volume, an old
# volume created before this migration, or a volume where they already exist.
#
# opspilot_shadow (deviation from the approved plan, discovered only by
# running the real Prisma 7.9.0 CLI — see docs/11-agent-run-persistence.md):
# `prisma migrate diff --to-config-datasource` (db:migrate:drift) requires
# its shadowDatabaseUrl target to already exist. Unlike `migrate dev`'s
# shadow database, Prisma does not auto-create it for `migrate diff`.
set -euo pipefail

if ! docker compose ps --status running postgres >/dev/null 2>&1 || \
   [ -z "$(docker compose ps --status running -q postgres 2>/dev/null)" ]; then
  echo "The 'postgres' Docker Compose service is not running. Run: pnpm infra:up"
  exit 1
fi

ensure_database() {
  local db_name="$1"
  local exists
  exists=$(docker compose exec -T postgres psql -U opspilot -d opspilot -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '${db_name}'")

  if [ "$exists" != "1" ]; then
    echo "Creating ${db_name} database..."
    docker compose exec -T postgres psql -U opspilot -d opspilot -c \
      "CREATE DATABASE ${db_name} OWNER opspilot;" >/dev/null
    echo "${db_name} created."
  else
    echo "${db_name} already exists."
  fi
}

ensure_database "opspilot_test"
ensure_database "opspilot_shadow"
