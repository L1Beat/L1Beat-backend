#!/usr/bin/env bash
# Deploys origin/main when it has a new commit whose CI passed: fast-forward,
# npm ci if the lockfile changed, restart, health check. A failed health check
# rolls back to the previous commit, and that commit is skipped until main
# moves again. Run every few minutes by deploy/l1beat-deploy.timer.
#
# Pull-based: the server only reads the public repo and GitHub's public API,
# so no deploy key or inbound access is needed.
set -euo pipefail

REPO_DIR=${REPO_DIR:-/home/selim/l1beat-backend}
GITHUB_REPO=${GITHUB_REPO:-L1Beat/L1Beat-backend}
SERVICE=${SERVICE:-l1beat-backend}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:5001/health}
STATE_DIR=${STATE_DIR:-/home/selim/.local/state/l1beat-deploy}
export PATH=/opt/node22/bin:$PATH

cd "$REPO_DIR"
mkdir -p "$STATE_DIR"

git fetch -q origin main
current=$(git rev-parse HEAD)
target=$(git rev-parse origin/main)
[ "$current" = "$target" ] && exit 0

if [ "$(cat "$STATE_DIR/failed" 2>/dev/null)" = "$target" ]; then
  exit 0 # Already rolled back from this commit
fi

# Every check run on the commit must have finished successfully. While CI is
# still running, try again on the next timer run.
ci=$(curl -fsS -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$GITHUB_REPO/commits/$target/check-runs" |
  python3 -c '
import json, sys
runs = json.load(sys.stdin)["check_runs"]
if not runs or any(r["status"] != "completed" for r in runs):
    print("pending")
elif all(r["conclusion"] in ("success", "skipped", "neutral") for r in runs):
    print("success")
else:
    print("failure")
')
case "$ci" in
  pending) echo "CI not finished for ${target:0:7}; waiting"; exit 0 ;;
  failure) echo "CI failed for ${target:0:7}; not deploying" >&2
           echo "$target" > "$STATE_DIR/failed"; exit 1 ;;
esac

install_and_restart() {
  if ! git diff --quiet "$1" "$2" -- package-lock.json; then
    npm ci --omit=dev --no-audit --no-fund
  fi
  sudo -n /usr/bin/systemctl restart "$SERVICE"
}

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS -m 5 "$HEALTH_URL" 2>/dev/null | grep -q '"status":"ok"'; then
      return 0
    fi
    sleep 2
  done
  return 1
}

echo "deploying ${current:0:7} -> ${target:0:7}"
git merge -q --ff-only "$target"
install_and_restart "$current" "$target"

if healthy; then
  echo "deployed ${target:0:7}: $(git log -1 --format=%s)"
  exit 0
fi

echo "health check failed on ${target:0:7}; rolling back to ${current:0:7}" >&2
echo "$target" > "$STATE_DIR/failed"
git reset -q --hard "$current"
install_and_restart "$target" "$current"
healthy || echo "still unhealthy after rollback" >&2
exit 1
