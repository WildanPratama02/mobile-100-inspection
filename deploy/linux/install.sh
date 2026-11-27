#!/usr/bin/env bash
# First installation on CentOS Stream 10 (run as root, from the unpacked release):
#   tar -xzf m100-<version>.tar.gz -C /tmp/m100-rel && sudo bash /tmp/m100-rel/deploy/linux/install.sh
# Safe to run again: existing .env, jwt.key, photos and database are never overwritten.
# It does not create the database (m100.sh bootstrap) and does not issue the certificate (docs/deploy-centos-nginx.md).
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VERSION="$(tr -d '\r\n' < "$SRC/VERSION")"
BASE=/opt/m100
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node not found in PATH." >&2; exit 1; }
NODE="$(readlink -f "$NODE")"
"$NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' \
  || { echo "Node.js >= 22 required, found $("$NODE" -v)." >&2; exit 1; }
echo "Node $("$NODE" -v) at $NODE, release $VERSION"

# 1. user and folders
id m100 >/dev/null 2>&1 || useradd --system --home-dir "$BASE" --shell /sbin/nologin m100
install -d -o root -g m100 -m 0751 "$BASE"
install -d -o root -g m100 -m 0750 "$BASE/secrets"
install -d -o m100 -g m100 -m 0750 "$BASE/photos"
install -d -o root -g root -m 0755 "$BASE/releases"

# 2. secrets and .env (only when missing)
if [ ! -f "$BASE/secrets/jwt.key" ]; then
  head -c 32 /dev/urandom > "$BASE/secrets/jwt.key"
  chown root:m100 "$BASE/secrets/jwt.key"; chmod 0640 "$BASE/secrets/jwt.key"
  echo "jwt.key created."
fi
if [ ! -f "$BASE/.env" ]; then
  APP_PW="$(openssl rand -hex 24)"; MIG_PW="$(openssl rand -hex 24)"
  sed -e "s/__APP_PASSWORD__/$APP_PW/" -e "s/__MIGRATE_PASSWORD__/$MIG_PW/" \
    "$SRC/deploy/linux/env.example" > "$BASE/.env"
  chown root:m100 "$BASE/.env"; chmod 0640 "$BASE/.env"
  echo ".env created with random database passwords: review it ($BASE/.env)."
fi

# 3. release
if [ ! -d "$BASE/releases/$VERSION" ]; then
  cp -a "$SRC" "$BASE/releases/$VERSION"
fi
chown -R root:root "$BASE/releases/$VERSION"
chmod -R a+rX,go-w "$BASE/releases/$VERSION"
ln -sfn "$BASE/releases/$VERSION" "$BASE/current"

# 4. SELinux: nginx reads the release, the API (unconfined service) needs nothing more.
if command -v getenforce >/dev/null && [ "$(getenforce)" != "Disabled" ]; then
  # semanage comes from policycoreutils-python-utils, not installed on a minimal CentOS Stream 10.
  if ! command -v semanage >/dev/null; then
    dnf install -y policycoreutils-python-utils
  fi
  setsebool -P httpd_can_network_connect 1
  if ! semanage fcontext -l | grep -q "^$BASE/releases"; then
    semanage fcontext -a -t httpd_sys_content_t "$BASE/releases(/.*)?"
  fi
  restorecon -R "$BASE/releases"
  restorecon -h "$BASE/current"
  # the symlink itself must be readable by nginx too
  chcon -h -t httpd_sys_content_t "$BASE/current" || true
fi

# 5. systemd units
for unit in m100-api.service m100-backup.service m100-sweep.service; do
  sed "s|@NODE@|$NODE|" "$SRC/deploy/linux/$unit" > "/etc/systemd/system/$unit"
done
install -m 0644 "$SRC/deploy/linux/m100-backup.timer" /etc/systemd/system/
install -m 0644 "$SRC/deploy/linux/m100-sweep.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable m100-backup.timer m100-sweep.timer >/dev/null
systemctl start m100-backup.timer m100-sweep.timer

# 6. nginx
install -d /etc/nginx/snippets
install -m 0644 "$SRC/deploy/linux/m100-headers.conf" /etc/nginx/snippets/m100-headers.conf
install -m 0644 "$SRC/deploy/linux/m100.conf" /etc/nginx/conf.d/m100.conf
if [ -f /etc/letsencrypt/live/m100.qdms.web.id/fullchain.pem ]; then
  nginx -t && systemctl reload nginx
else
  echo "NO certificate yet: nginx not reloaded. Issue it (docs/deploy-centos-nginx.md section 7.1), then: nginx -t && systemctl reload nginx"
fi

# 7. firewall
if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http --add-service=https >/dev/null
  firewall-cmd --reload >/dev/null
fi

cat <<EOF

Installed release $VERSION.
Next steps (see docs/deploy-centos-nginx.md):
  1. $BASE/current/deploy/linux/m100.sh bootstrap      # roles + database (asks for the postgres password)
  2. $BASE/current/deploy/linux/m100.sh migrate
  3. systemctl enable --now m100-api && curl -s http://127.0.0.1:3110/v1/health
  4. $BASE/current/deploy/linux/m100.sh admin-create --username admin
EOF
