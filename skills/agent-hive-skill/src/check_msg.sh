#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Usage: check_msg.sh [--session_id TARGET] [--last COUNT] [--unread-only] [--quiet] [--all]

Read recent messages exchanged with the user or a connected agent. TARGET
defaults to "user" and COUNT defaults to 10. Attachments are downloaded to
<workspace>/.agent-hive/<session_id>/inbox/. This command does not wait; use
wait_msg.sh to block until unread messages exist.

With --all, read unread messages from the user and every connected agent in one
call, printing a `== <peer session id> ==` header before each peer batch. --all
implies --unread-only and cannot be combined with --session_id.

With --unread-only only messages that are still unread are printed and marked
read, and the command remembers how far it has read: the first run looks back
200 messages, later runs page forward from the last handled message id using the
`after` cursor, so a long absence cannot silently drop older unread messages.
The cursor lives in <workspace>/.agent-hive/<session_id>/cursors/<target> and is
only advanced after a batch has been printed and marked read. COUNT does not
apply to --unread-only. A conversation that was cleared resets the cursor
automatically (the server rejects an unknown id with 400 and the command falls
back to the newest 200 messages).

With --quiet, "No unread messages." is not printed; an empty batch produces no
output at all, which keeps watch-all loops quiet.

Environment:
  HIVE_SESSION_ID   Registered session id
  HIVE_SESSION_PWD  Session password
EOF
}

target="user"
last="10"
unread_only="0"
quiet="0"
all="0"
target_set="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --unread-only)
      unread_only="1"
      shift
      ;;
    --quiet)
      quiet="1"
      shift
      ;;
    --all)
      all="1"
      unread_only="1"
      shift
      ;;
    --session_id)
      [[ $# -ge 2 ]] || die "--session_id requires a value"
      target="$2"
      target_set="1"
      shift 2
      ;;
    --last)
      [[ $# -ge 2 ]] || die "--last requires a value"
      last="$2"
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

[[ "$last" =~ ^[1-9][0-9]{0,2}$ ]] || die "--last must be between 1 and 200"
[[ "$last" -le 200 ]] || die "--last must be between 1 and 200"

load_session

if [[ "$all" == "1" ]]; then
  [[ "$target_set" == "0" ]] || die "--all cannot be combined with --session_id"

  args=(--unread-only --session_id user --quiet)
  batch="$("$SCRIPT_DIR/check_msg.sh" "${args[@]}")"
  any="0"
  if [[ -n "$batch" ]]; then
    printf '%s\n' "$batch"
    any="1"
  fi

  contacts_json="$(http_get "/api/agent/contacts")"
  while IFS= read -r peer; do
    [[ -n "$peer" ]] || continue
    args=(--unread-only --session_id "$peer" --quiet)
    batch="$("$SCRIPT_DIR/check_msg.sh" "${args[@]}")"
    if [[ -n "$batch" ]]; then
      printf '== %s ==\n%s\n' "$peer" "$batch"
      any="1"
    fi
  done <<<"$(printf '%s' "$contacts_json" | python3 "$HIVE_PY" contact-ids)"

  if [[ "$any" == "0" && "$quiet" != "1" ]]; then
    printf 'No unread messages.\n'
  fi
  exit 0
fi

assert_contact "$target"

encoded_target="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$target")"

if [[ "$unread_only" == "1" ]]; then
  # Page forward with the `after` cursor so a long absence cannot silently drop
  # unread messages older than a fixed `last=N` window. The cursor only moves
  # after the batch has been printed and marked read.
  cursor_dir="$SESSION_DIR/cursors"
  safe_target="$(printf '%s' "$target" | tr -c 'A-Za-z0-9._-' '_')"
  cursor_file="$cursor_dir/$safe_target"
  cursor_tmp="$(mktemp)"
  mkdir -p "$cursor_dir" 2>/dev/null || true
  chmod 700 "$cursor_dir" 2>/dev/null || true

  body="$(
    HIVE_FETCH_TARGET="$target" \
    HIVE_FETCH_CURSOR_FILE="$cursor_file" \
    HIVE_FETCH_CURSOR_OUT="$cursor_tmp" \
    HIVE_FETCH_BOOTSTRAP="200" \
    python3 "$HIVE_PY" fetch-unread
  )"
else
  cursor_tmp=""
  body="$(http_get "/api/agent/messages?with=$encoded_target&last=$last")"
fi

if [[ "$unread_only" == "1" ]]; then
  body="$(printf '%s' "$body" | python3 "$HIVE_PY" filter-unread)"
  if ! printf '%s' "$body" | python3 "$HIVE_PY" has-messages; then
    [[ "$quiet" == "1" ]] || printf 'No unread messages.\n'
    # Everything up to the newest message was already read, so the cursor can
    # move without losing anything.
    [[ -n "$cursor_tmp" && -s "$cursor_tmp" ]] && mv "$cursor_tmp" "$cursor_file"
    [[ -n "$cursor_tmp" ]] && rm -f "$cursor_tmp"
    exit 0
  fi
fi

printf '%s' "$body" |
  HIVE_INBOX_DIR="$SESSION_DIR/inbox" \
  AGENT_HIVE_URL="$SERVER_URL" \
  python3 "$HIVE_PY" render-messages

read_payloads="$(
  printf '%s' "$body" |
    HIVE_TARGET="$target" \
    HIVE_READ_CHUNK="200" \
    python3 "$HIVE_PY" make-read-json
)"

while IFS= read -r read_payload; do
  [[ -n "$read_payload" ]] || continue
  http_post_json "/api/agent/messages/read" "$read_payload" >/dev/null
done <<<"$read_payloads"

# The batch is read, so the cursor may advance past it.
if [[ -n "$cursor_tmp" ]]; then
  [[ -s "$cursor_tmp" ]] && mv "$cursor_tmp" "$cursor_file"
  rm -f "$cursor_tmp"
fi
