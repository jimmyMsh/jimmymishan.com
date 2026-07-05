#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$HOME/jimmymishan.com"

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"
  echo "Docker installed. Log out and back in (docker group), then re-run this script."
  exit 0
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  if command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y sqlite
  else
    sudo apt-get update -y
    sudo apt-get install -y sqlite3
  fi
fi

mkdir -p "$APP_DIR/data/goatcounter" "$APP_DIR/backups" "$APP_DIR/scripts"
# The api (node) and goatcounter (uid 1000) containers run as non-root users
# and must be able to create their SQLite files in these host directories.
chmod 777 "$APP_DIR/data" "$APP_DIR/data/goatcounter"

cron_line="30 3 * * * $APP_DIR/scripts/backup-sqlite.sh"
(crontab -l 2>/dev/null | grep -vF 'backup-sqlite.sh' || true; echo "$cron_line") | crontab -

if [ ! -f "$APP_DIR/.env" ]; then
  echo "ERROR: $APP_DIR/.env is missing. Create it from .env.example, then re-run." >&2
  exit 1
fi

if [ -f "$APP_DIR/compose.prod.yaml" ]; then
  cd "$APP_DIR"
  docker compose -f compose.prod.yaml pull
  docker compose -f compose.prod.yaml up -d
else
  echo "compose.prod.yaml not present yet — the first CI deploy copies it."
fi

echo "Bootstrap complete."
