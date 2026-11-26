#!/usr/bin/env bash
# Upgrade (run as root), at a shift change:
#   sudo bash /opt/m100/current/deploy/linux/upgrade.sh /home/<user>/upload/m100-<version>.tar.gz
#   sudo bash /opt/m100/current/deploy/linux/upgrade.sh --rollback
# Order: pre-upgrade backup, unpack, migrate, switch the "current" link, restart, health check. Unhealthy after 60 s:
# the link goes back to the previous release. A one-way migration (like 0006) is NOT undone by that: read the notes.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }
BASE=/opt/m100
cd "$BASE"
NODE="$(readlink -f "$(command -v node)")"

health() {
  for _ in $(seq 1 30); do
    curl -fsS http://127.0.0.1:3110/v1/health >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

switch_to() {
  ln -sfn "$BASE/releases/$1" "$BASE/current"
  chcon -h -t httpd_sys_content_t "$BASE/current" 2>/dev/null || true
  systemctl restart m100-api
}

if [ "${1:-}" = "--rollback" ]; then
  [ -f previous-release.txt ] || { echo "No previous-release.txt." >&2; exit 1; }
  PREV="$(basename "$(cat previous-release.txt)")"
  switch_to "$PREV"
  health && echo "Rolled back to $PREV." || { echo "Not healthy: journalctl -u m100-api" >&2; exit 1; }
  exit 0
fi

PKG="${1:-}"
[ -f "$PKG" ] || { echo "Usage: upgrade.sh <m100-version.tar.gz> | --rollback" >&2; exit 1; }

STAGE="$(mktemp -d /tmp/m100-up.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT
tar -xzf "$PKG" -C "$STAGE"
VERSION="$(tr -d '\r\n' < "$STAGE/VERSION")"
[ -d "$BASE/releases/$VERSION" ] && { echo "Release $VERSION is already installed." >&2; exit 1; }
[ -f "$STAGE/api/dist/main.js" ] || { echo "Not an M100 release." >&2; exit 1; }
echo "Upgrading to $VERSION"

echo "1/6 backup"
"$NODE" "$BASE/current/api/dist/cli/backup.js" --kind pre-upgrade

echo "2/6 unpack"
mv "$STAGE" "$BASE/releases/$VERSION"; trap - EXIT
chown -R root:root "$BASE/releases/$VERSION"
chmod -R a+rX,go-w "$BASE/releases/$VERSION"
command -v restorecon >/dev/null && restorecon -R "$BASE/releases/$VERSION"
cp -f "$BASE/releases/$VERSION/deploy/linux/m100.conf" /etc/nginx/conf.d/m100.conf.new
cp -f "$BASE/releases/$VERSION/deploy/linux/m100-headers.conf" /etc/nginx/snippets/m100-headers.conf.new

echo "3/6 migrate"
sudo -u m100 "$NODE" "$BASE/releases/$VERSION/api/dist/cli/db-migrate.js"

echo "4/6 switch"
readlink -f current > previous-release.txt
switch_to "$VERSION"

echo "5/6 health"
if ! health; then
  echo "Not healthy in 60 s: back to $(cat previous-release.txt)" >&2
  switch_to "$(basename "$(cat previous-release.txt)")"
  exit 1
fi

echo "6/6 keep the last 5 releases"
ls -1dt "$BASE"/releases/*/ | tail -n +6 | xargs -r rm -rf

echo "Release $VERSION is running."
echo "Nginx files of this release were saved as /etc/nginx/conf.d/m100.conf.new and snippets/m100-headers.conf.new."
echo "If they differ from the installed ones: diff, copy over, nginx -t && systemctl reload nginx."
rm -f "$PKG" 2>/dev/null || true
