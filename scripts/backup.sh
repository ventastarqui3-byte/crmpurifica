#!/usr/bin/env bash
# Respaldo de la base de datos del CRM (Postgres) con pg_dump.
# Uso manual (en el host, con pg_dump instalado y DATABASE_URL definida):
#   DATABASE_URL="postgres://purifica:CLAVE@localhost:5432/purifica" ./scripts/backup.sh
# O en Docker (el respaldo diario automático ya lo hace el servidor a las 02:00):
#   docker compose --profile backup run --rm backup
# Guarda en backups/purifica-YYYY-MM-DD-HHmm.sql.gz y borra los de más de
# BACKUP_KEEP_DAYS días (por defecto 7).
set -euo pipefail
cd "$(dirname "$0")/.."
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
if [ -z "${DATABASE_URL:-}" ]; then
  echo "Falta DATABASE_URL. Ejemplo:"
  echo "  DATABASE_URL=\"postgres://purifica:CLAVE@localhost:5432/purifica\" $0"
  exit 1
fi
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "pg_dump no está instalado. En Debian/Ubuntu: sudo apt install postgresql-client"
  exit 1
fi
mkdir -p backups
FILE="backups/purifica-$(date +%F-%H%M).sql.gz"
pg_dump "$DATABASE_URL" | gzip > "$FILE"
find backups -name "purifica-*.sql.gz" -mtime "+$KEEP_DAYS" -delete || true
echo "Respaldo guardado en $FILE ($(du -h "$FILE" | cut -f1))"

# Restaurar un respaldo (¡borra los datos actuales y los reemplaza!):
#   gunzip -c backups/purifica-2026-11-06-0200.sql.gz | psql "$DATABASE_URL"
