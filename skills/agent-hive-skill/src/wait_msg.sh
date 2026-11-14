#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Usage: wait_msg.sh [--timeout SECONDS] [--interval SECONDS]

Wait until *new* unread messages exist, print who sent the latest one and the
total unread count, then exit. Every conversation is watched (the user plus all
connected agents); there is no single-conversation mode. This command is silent
while waiting and does not mark messages as read.

wait_msg.sh remembers the ids of unread messages it has already reported in
<workspace>/.agent-hive/<session_id>/wait-seen/<target>. A later run keeps
waiting while the only unread messages are ones it already printed, so a
background waiter can be restarted without firing again for the same backlog.
The stored ids are replaced after each report and drop out once read.

Options:
  --timeout    Maximum wait in seconds; 0 waits forever (default: 0)
  --interval   Poll interval in seconds, 1 to 60 (default: 2)

Exit status:
  0    New unread messages exist
  124  --timeout elapsed with no new unread message

Environment:
  HIVE_SESSION_ID   Registered session id
  HIVE_SESSION_PWD  Session password
EOF
}

timeout="0"
interval="2"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout)
      [[ $# -ge 2 ]] || die "--timeout requires a value"
      timeout="$2"
      shift 2
      ;;
    --interval)
      [[ $# -ge 2 ]] || die "--interval requires a value"
      interval="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[[ "$timeout" =~ ^(0|[1-9][0-9]*)$ ]] || die "--timeout must be 0 or a positive number"
[[ "$interval" =~ ^[1-9][0-9]?$ ]] || die "--interval must be between 1 and 60"
[[ "$interval" -le 60 ]] || die "--interval must be between 1 and 60"

load_session

unread_path="/api/agent/unread"

# wait_msg.sh tracks the ids it has already reported so restarting a background
# waiter does not fire again for the same unread backlog.
seen_dir="$SESSION_DIR/wait-seen"
mkdir -p "$seen_dir" 2>/dev/null || true
chmod 700 "$seen_dir" 2>/dev/null || true

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

safe_target() {
  printf '%s' "$1" | tr -c 'A-Za-z0-9._-' '_'
}

encode_target() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$1"
}

started=$SECONDS

while true; do
  body="$(http_get "$unread_path")"
  count="$(json_field unread_count "$body")"

  if [[ "$count" =~ ^[1-9][0-9]*$ ]]; then
    # Cheap fast path: if the newest unread id was already reported, nothing
    # newer can be unseen, so avoid fetching message bodies on every poll.
    latest_json="$(json_field latest "$body" 2>/dev/null || true)"
    latest_id=""
    latest_target=""
    if [[ -n "$latest_json" ]]; then
      latest_id="$(json_field id "$latest_json" 2>/dev/null || true)"
      latest_target="$(json_field target "$latest_json" 2>/dev/null || true)"
    fi
    stale="0"
    if [[ -n "$latest_id" && -n "$latest_target" ]]; then
      latest_seen_file="$seen_dir/$(safe_target "$latest_target")"
      if [[ -f "$latest_seen_file" ]] && grep -Fxq "$latest_id" "$latest_seen_file"; then
        stale="1"
      fi
    fi

    if [[ "$stale" == "0" ]]; then
      # Wait on every conversation: the user plus each connected peer.
      contacts_json="$(http_get "/api/agent/contacts")"
      target_list="user"$'\n'"$(printf '%s' "$contacts_json" | python3 "$HIVE_PY" contact-ids)"

      found_new="0"
      while IFS= read -r conversation; do
        [[ -n "$conversation" ]] || continue
        conversation_key="$(safe_target "$conversation")"
        messages_file="$work_dir/$conversation_key.json"
        http_get "/api/agent/messages?with=$(encode_target "$conversation")&last=200" >"$messages_file"
        if HIVE_WAIT_SEEN_FILE="$seen_dir/$conversation_key" \
          python3 "$HIVE_PY" filter-unseen <"$messages_file" |
          python3 "$HIVE_PY" has-messages; then
          found_new="1"
        fi
      done <<<"$target_list"

      if [[ "$found_new" == "1" ]]; then
        printf '%s' "$body" | python3 "$HIVE_PY" render-unread
        # Remember every currently unread incoming id as reported. Replacing
        # the file (instead of appending) also drops ids that became read, so
        # it stays bounded by the current unread backlog.
        while IFS= read -r conversation; do
          [[ -n "$conversation" ]] || continue
          conversation_key="$(safe_target "$conversation")"
          HIVE_WAIT_SEEN_FILE="$seen_dir/$conversation_key" \
            python3 "$HIVE_PY" update-seen <"$work_dir/$conversation_key.json"
        done <<<"$target_list"
        exit 0
      fi
    fi
  fi

  if [[ "$timeout" -gt 0 && $((SECONDS - started)) -ge "$timeout" ]]; then
    printf 'No unread messages within %s seconds.\n' "$timeout" >&2
    exit 124
  fi

  sleep "$interval"
done
