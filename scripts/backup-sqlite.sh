#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/var/www/restaurant-system/current}"
DATABASE_PATH="${DATABASE_PATH:-/var/www/restaurant-system/shared/restaurant-system.db}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/restaurant-system}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

mkdir -p "$BACKUP_DIR"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/restaurant-system-$TIMESTAMP.db"

if [[ ! -f "$DATABASE_PATH" ]]; then
  echo "Banco nao encontrado em: $DATABASE_PATH" >&2
  exit 1
fi

if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DATABASE_PATH" ".backup '$BACKUP_FILE'"
else
  cp "$DATABASE_PATH" "$BACKUP_FILE"
fi

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'restaurant-system-*.db' -mtime +"$BACKUP_RETENTION_DAYS" -delete

echo "Backup criado em: $BACKUP_FILE"
