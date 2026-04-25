#!/usr/bin/env bash
set -euo pipefail

# Bring up Postgres and ensure ziphub_test exists.
# Idempotent — safe to run repeatedly.

cd "$(dirname "$0")/.."

docker compose up -d --wait postgres
docker exec ziphub-postgres \
  psql -U ziphub -d postgres -c "CREATE DATABASE ziphub_test OWNER ziphub" \
  >/dev/null 2>&1 || true
echo "ziphub Postgres ready (ziphub, ziphub_test)"
