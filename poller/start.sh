#!/usr/bin/env bash
# Start / stop / check the transcript poller in the background on this box.
#   poller/start.sh            start (nohup) unless already running; extra args go to poller.mjs
#   poller/start.sh stop       stop it (SIGTERM; the lock file is removed on exit)
#   poller/start.sh status     running? plus the health check (exit 1 if unhealthy)
# Secrets: ~/.post-it-poller/env (chmod 600, KEY=VALUE, see poller/.env.example). poller.mjs reads that file
# itself, so secret values never appear on a command line or in `ps`.
set -euo pipefail
HOME_DIR="${POLLER_HOME:-$HOME/.post-it-poller}"
ENV_FILE="${POLLER_ENV_FILE:-$HOME_DIR/env}"
LOCK="$HOME_DIR/poller.lock"
HERE="$(cd "$(dirname "$0")" && pwd)"
running_pid() { local p; p="$(cat "$LOCK" 2>/dev/null || true)"; [ -n "$p" ] && kill -0 "$p" 2>/dev/null && echo "$p"; }

case "${1:-start}" in
  stop)
    if p="$(running_pid)"; then kill "$p"; echo "stopped poller (pid $p)"; else echo "poller is not running"; fi
    exit 0 ;;
  status)
    if p="$(running_pid)"; then echo "running (pid $p)"; else echo "not running"; fi
    exec node "$HERE/poller.mjs" --health ;;
  start) shift || true ;;
esac

mkdir -p "$HOME_DIR" && chmod 700 "$HOME_DIR"
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE: copy poller/.env.example there, fill it in, chmod 600" >&2; exit 1; }
[ "$(stat -c %a "$ENV_FILE")" = 600 ] || { echo "Run: chmod 600 $ENV_FILE" >&2; exit 1; }
for k in GROK_COOKIE INBOX_GITHUB_TOKEN; do
  grep -Eq "^\s*(export\s+)?$k=.+" "$ENV_FILE" || { echo "$k is not set in $ENV_FILE" >&2; exit 1; }
done
if p="$(running_pid)"; then echo "already running (pid $p)"; exit 0; fi
command -v node >/dev/null || { echo "node not found" >&2; exit 1; }

nohup node "$HERE/poller.mjs" --quiet "$@" >> "$HOME_DIR/nohup.out" 2>&1 &
echo "started poller (pid $!). Log: $HOME_DIR/poller.log  Health: $HERE/start.sh status  Stop: $HERE/start.sh stop"
