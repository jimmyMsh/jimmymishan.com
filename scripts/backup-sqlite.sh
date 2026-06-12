#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${DATA_DIR:-$HOME/jimmymishan.com/data}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/jimmymishan.com/backups}"
MAX_AGE_DAYS="${MAX_AGE_DAYS:-14}"
MAX_DIR_MB="${MAX_DIR_MB:-500}"
LOG_FILE="$BACKUP_DIR/backup.log"

mkdir -p "$BACKUP_DIR"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >>"$LOG_FILE"; }

shopt -s nullglob
dbs=("$DATA_DIR"/*.db)
if [ ${#dbs[@]} -eq 0 ]; then
  log "no databases in $DATA_DIR, nothing to back up"
  exit 0
fi

stamp="$(date -u +%Y%m%d-%H%M%S)"
for db in "${dbs[@]}"; do
  name="$(basename "$db" .db)"
  tmp="$(mktemp)"
  sqlite3 "$db" ".backup '$tmp'"
  gzip -c "$tmp" >"$BACKUP_DIR/$name-$stamp.db.gz"
  rm -f "$tmp"
  log "backed up $name"
done

find "$BACKUP_DIR" -name '*.db.gz' -mtime "+$MAX_AGE_DAYS" -delete

while [ "$(du -sm "$BACKUP_DIR" | cut -f1)" -gt "$MAX_DIR_MB" ]; do
  oldest="$(find "$BACKUP_DIR" -name '*.db.gz' -printf '%T@ %p\n' | sort -n | head -n 1 | cut -d' ' -f2-)"
  [ -z "$oldest" ] && break
  rm -f "$oldest"
  log "size cap exceeded: removed $oldest"
done

if [ "$(wc -l <"$LOG_FILE")" -gt 1000 ]; then
  tail -n 500 "$LOG_FILE" >"$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
fi
