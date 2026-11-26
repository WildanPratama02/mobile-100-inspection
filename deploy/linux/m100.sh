#!/usr/bin/env bash
# Operator commands (run as root or with sudo): m100.sh <command> [args]
#   status | logs | health | bootstrap | migrate | backup [--kind daily|pre-upgrade] | restore-test <folder> |
#   sweep [--dry-run] | admin-create [--username n] [--reset] | device-add --label "<l>" | device-list |
#   device-revoke --label "<l>" | import-master --dir <folder> [--dry-run]
set -euo pipefail

BASE=/opt/m100
cd "$BASE"
NODE="$(readlink -f "$(command -v node)")"
CLI="$BASE/current/api/dist/cli"
as_app() { sudo -u m100 "$NODE" "$CLI/$1.js" "${@:2}"; }

cmd="${1:-}"; shift || true
case "$cmd" in
  status)  systemctl status m100-api --no-pager; systemctl list-timers 'm100-*' --no-pager; cat current/VERSION ;;
  logs)    journalctl -u m100-api -f ;;
  health)  curl -s http://127.0.0.1:3110/v1/health; echo ;;
  bootstrap)
    read -rsp "postgres superuser password: " PGSUPER; echo
    read -rsp "new password for role m100_report: " REPORTPW; echo
    sudo -u m100 env ADMIN_DATABASE_URL="postgres://postgres:${PGSUPER}@127.0.0.1:5432/postgres" \
      REPORT_DB_PASSWORD="${REPORTPW}" "$NODE" "$CLI/db-bootstrap.js"
    ;;
  migrate) as_app db-migrate ;;
  backup)  "$NODE" "$CLI/backup.js" "$@" ;;
  restore-test)
    read -rsp "postgres superuser password: " PGSUPER; echo
    ADMIN_DATABASE_URL="postgres://postgres:${PGSUPER}@127.0.0.1:5432/postgres" \
      "$NODE" "$CLI/backup-restore.js" --from "${1:?backup folder}" --database m100_restore_test
    ;;
  sweep)          as_app sweep-photos "$@" ;;
  admin-create)   as_app admin-create "$@" ;;
  device-add)     as_app device-add "$@" ;;
  device-list)    as_app device-list "$@" ;;
  device-revoke)  as_app device-revoke "$@" ;;
  import-master)  as_app import-master "$@" ;;
  *) sed -n '2,6p' "$0"; exit 1 ;;
esac
