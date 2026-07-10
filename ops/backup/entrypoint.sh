#!/usr/bin/env bash
# PRODUCTION REFERENCE — nightly logical backup + retention. Wire into the compose
# pg-backup service (or a host cron). Pair with continuous WAL archiving for PITR.
# Restore drill monthly into a scratch DB — untested backups do not count.
set -euo pipefail

: "${DATABASE_HOST:=postgres}"
: "${DATABASE_USER:=gameapi}"
: "${DATABASE_NAME:=gameapi}"
: "${BACKUP_DIR:=/backups}"
: "${BACKUP_RETENTION_DAYS:=14}"

export PGPASSWORD="$(cat /run/secrets/postgres_password 2>/dev/null || echo "${PGPASSWORD:-}")"

run_backup() {
  local ts file
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  file="${BACKUP_DIR}/${DATABASE_NAME}_${ts}.sql.gz"
  echo "backup: dumping to ${file}"
  pg_dump -h "${DATABASE_HOST}" -U "${DATABASE_USER}" -d "${DATABASE_NAME}" | gzip > "${file}"

  # retention
  find "${BACKUP_DIR}" -name "${DATABASE_NAME}_*.sql.gz" -mtime "+${BACKUP_RETENTION_DAYS}" -delete || true

  # offsite (3-2-1): configure rclone with RCLONE_REMOTE
  if [ -n "${RCLONE_REMOTE:-}" ]; then
    rclone copy "${file}" "${RCLONE_REMOTE}" || echo "backup: rclone copy failed"
  fi
  echo "backup: done"
}

# simple loop: run once per day (replace with a real cron in production)
while true; do
  run_backup || echo "backup: FAILED"
  sleep 86400
done
