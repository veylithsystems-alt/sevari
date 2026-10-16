#!/usr/bin/env bash
# Starts a throwaway PostgreSQL 16 for local tests when Docker is unavailable.
# Usage: pnpm db:local   then   export SEVARI_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54329/postgres
set -euo pipefail
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
DATA="${SEVARI_PG_DATA:-/tmp/sevari-pg}"
PORT="${SEVARI_PG_PORT:-54329}"
RUN_AS="${SEVARI_PG_USER:-postgres}"
as_user() { if [ "$(id -u)" = "0" ]; then su "$RUN_AS" -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
if [ ! -f "$DATA/PG_VERSION" ]; then
  mkdir -p "$DATA"; [ "$(id -u)" = "0" ] && chown "$RUN_AS" "$DATA"
  as_user "$PGBIN/initdb -D $DATA -U postgres --auth=trust --no-sync >/dev/null"
fi
if ! as_user "$PGBIN/pg_ctl -D $DATA status" >/dev/null 2>&1; then
  as_user "$PGBIN/pg_ctl -D $DATA -l $DATA/log -o '-p $PORT -k /tmp -c fsync=off -c listen_addresses=127.0.0.1' -w start" >/dev/null
fi
echo "postgres://postgres@127.0.0.1:$PORT/postgres"
