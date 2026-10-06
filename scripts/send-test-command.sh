#!/usr/bin/env bash
# Push one JSON command into the Post-it Board inbox and wait for its result.
#
#   scripts/send-test-command.sh                       # sends a clearly-named TEST add (see DEFAULT_CMD)
#   scripts/send-test-command.sh templates/command-add.json
#   scripts/send-test-command.sh my.json --no-wait
#   REPO=someone/post-it-board scripts/send-test-command.sh my.json
#
# Requires: gh (authenticated: `gh auth login`), base64, and node or python3 (for pretty output).
# Reads no secrets itself; gh uses your own login. WARNING: this writes to the LIVE board.
# Clean up a test by sending a delete command for your test pin (see templates/command-delete.json).
set -euo pipefail

REPO="${REPO:-mogesjohnson/post-it-board}"
BRANCH="${BRANCH:-inbox}"
DEFAULT_CMD='{"op":"add","pin":"how-to-post-it test","title":"Test from send-test-command.sh","body":"Temporary test note. Safe to delete."}'

file="" ; wait_for_result=1
for arg in "$@"; do
  case "$arg" in
    --no-wait) wait_for_result=0 ;;
    -h|--help) sed -n '2,10p' "$0" | sed -E 's/^# ?//'; exit 0 ;;
    *) file="$arg" ;;
  esac
done

if [ -n "$file" ]; then
  [ -f "$file" ] || { echo "No such file: $file" >&2; exit 1; }
  json="$(cat "$file")"
  slug="$(basename "$file" .json | tr -c 'a-zA-Z0-9-' '-' | tr 'A-Z' 'a-z' | sed 's/--*/-/g; s/^-//; s/-$//')"
else
  json="$DEFAULT_CMD"
  slug="test"
fi

command -v gh >/dev/null || { echo "gh CLI not found" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated (run: gh auth login)" >&2; exit 1; }

name="test-$(date -u +%Y%m%dT%H%M%SZ)-${slug}.json"
path="inbox/$name"
content="$(printf '%s' "$json" | base64 | tr -d '\n')"

echo "Pushing $path to $REPO@$BRANCH …"
gh api -X PUT "repos/$REPO/contents/$path" \
  -f message="inbox: test command ($name)" -f branch="$BRANCH" -f content="$content" \
  --jq '"commit " + .commit.sha[0:7]'

[ "$wait_for_result" = 1 ] || { echo "Not waiting. Result will appear at inbox/results/$name"; exit 0; }

echo "Waiting for the inbox workflow (up to 5 min) …"
for _ in $(seq 1 60); do
  sleep 5
  if out="$(gh api "repos/$REPO/contents/inbox/results/$name?ref=$BRANCH" --jq .content 2>/dev/null)"; then
    result="$(printf '%s' "$out" | base64 -d)"
    if command -v node >/dev/null; then
      printf '%s' "$result" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(`status:  ${r.status}\nmessage: ${r.message}\nmatched: ${JSON.stringify(r.matched)}`)})'
    else
      printf '%s\n' "$result"
    fi
    exit 0
  fi
done
echo "No result after 5 minutes; check https://github.com/$REPO/actions" >&2
exit 2
