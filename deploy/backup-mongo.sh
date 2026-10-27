#!/usr/bin/env bash
# Nightly dump of the l1beat database from the l1beat-mongo container.
# Keeps the newest $KEEP archives. Run by deploy/l1beat-backup.timer.
#
# Restore one (replaces the current data):
#   docker exec -i l1beat-mongo mongorestore --archive --gzip --drop < <file>.gz
set -euo pipefail

DIR=${BACKUP_DIR:-/home/selim/backups/l1beat}
KEEP=${KEEP:-7}
CONTAINER=${CONTAINER:-l1beat-mongo}
# A real dump is several MB; anything smaller means mongodump failed quietly.
MIN_BYTES=${MIN_BYTES:-1000000}

mkdir -p "$DIR"
out="$DIR/l1beat-$(date -u +%Y%m%dT%H%MZ).gz"
tmp="$out.partial"

docker exec "$CONTAINER" mongodump --db=l1beat --archive --gzip --quiet > "$tmp"

# Never rotate on a bad dump, so a broken run can't push out good backups.
size=$(wc -c < "$tmp" | tr -d ' ')
if [ "$size" -lt "$MIN_BYTES" ]; then
  echo "backup too small ($size bytes); left $tmp for inspection" >&2
  exit 1
fi
mv "$tmp" "$out"

ls -1t "$DIR"/l1beat-*.gz | tail -n +"$((KEEP + 1))" | xargs -r rm --
echo "wrote $out ($size bytes)"

# Off-site copy to Cloudflare R2, when configured in /etc/l1beat-backup.env.
# rclone reads the "r2" remote from RCLONE_CONFIG_R2_* variables. R2-side
# retention is a bucket lifecycle rule, not handled here. The token is scoped
# to the one bucket, so skip rclone's bucket-exists check (it needs more rights).
if [ -n "${R2_BUCKET:-}" ]; then
  rclone copyto "$out" "r2:$R2_BUCKET/$(basename "$out")" --s3-no-check-bucket
  echo "uploaded to r2:$R2_BUCKET/$(basename "$out")"
fi
