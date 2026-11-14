#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Usage: listen.sh [--timeout SECONDS] [--interval SECONDS] [--follow]

Wait until unread messages exist, print only the new ones (marking just those
read), then exit 0 so the caller can react. Every conversation is watched (the
user plus all connected agents).

Options:
  --session_id   Deprecated and ignored; every conversation is watched anyway.
  --all          Accepted for clarity; this is the default.
  --timeout      Maximum wait in seconds; 0 waits forever (default: 0)
  --interval     Poll interval in seconds, 1 to 60 (default: 1)
  --follow       Keep listening after the first batch and print each new batch
                 as it arrives; Ctrl-C stops it. Exit 124 still means --timeout
                 elapsed with nothing unread.
  --once         Accepted for clarity: identical to the default behaviour.

Exit status:
  0    A batch was printed and read (or --follow was interrupted)
  124  --timeout elapsed with no unread message in the window

Environment:
  HIVE_SESSION_ID   Registered session id
  HIVE_SESSION_PWD  Session password
EOF
}

target="user"
watch_all="1"
timeout="0"
interval="1"
once="1"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session_id)
      [[ $# -ge 2 ]] || die "--session_id requires a value"
      shift 2
      printf 'warning: --session_id is ignored; listen.sh watches every conversation.\n' >&2
      ;;
    --all)
      watch_all="1"
      shift
      ;;
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
    --once)
      once="1"
      shift
      ;;
    --follow)
      once="0"
      shift
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

# Fail fast on a broken session instead of looping on a bad credential.
load_session
if [[ "$watch_all" != "1" ]]; then
  assert_contact "$target"
fi

started=$SECONDS
wait_err="$(mktemp)"
trap 'rm -f "$wait_err"' EXIT

# Print a batch for one conversation, with a header for peers. --quiet keeps
# conversations without unread messages from adding noise to the watch-all loop.
# Print the batch separator once, immediately before the first output line.
print_separator() {
  if [[ "$printed" == "0" ]]; then
    printf '%s\n' '-----'
    printed=1
  fi
}

collect_batch() {
  local conversation="$1"
  local header="$2"
  local batch
  batch="$("$SCRIPT_DIR/check_msg.sh" --unread-only --session_id "$conversation" --quiet)"
  if [[ -z "$batch" ]]; then
    return 0
  fi
  print_separator
  if [[ -n "$header" ]]; then
    printf '== %s ==\n' "$header"
  fi
  printf '%s\n' "$batch"
  return 0
}

while true; do
  remaining="0"
  if [[ "$timeout" -gt 0 ]]; then
    remaining=$((timeout - (SECONDS - started)))
    if [[ "$remaining" -le 0 ]]; then
      printf 'No unread messages within %s seconds.\n' "$timeout" >&2
      exit 124
    fi
  fi

  wait_args=(--interval "$interval" --timeout "$remaining")

  set +e
  "$SCRIPT_DIR/wait_msg.sh" "${wait_args[@]}" 2>"$wait_err"
  wait_status=$?
  set -e

  # wait_msg.sh reports its own slice timeout; print the overall window instead.
  if [[ "$wait_status" -eq 124 ]]; then
    printf 'No unread messages within %s seconds.\n' "$timeout" >&2
    exit 124
  fi
  if [[ -s "$wait_err" ]]; then
    cat "$wait_err" >&2
  fi
  if [[ "$wait_status" -ne 0 ]]; then
    exit "$wait_status"
  fi

  printed=0
  if [[ "$watch_all" == "1" ]]; then
    # The unread summary covers every conversation, so the read step has to as
    # well: walk the user conversation plus each connected peer.
    collect_batch "user" ""
    while IFS= read -r peer; do
      [[ -n "$peer" ]] || continue
      collect_batch "$peer" "$peer"
    done <<<"$(http_get /api/agent/contacts | python3 "$HIVE_PY" contact-ids)"
  else
    batch="$("$SCRIPT_DIR/check_msg.sh" --unread-only --session_id "$target" --quiet)"
    if [[ -n "$batch" ]]; then
      print_separator
      printf '%s\n' "$batch"
    fi
  fi

  # An empty batch means another reader won the race, so keep waiting instead of
  # returning a result the caller cannot use. The short pause keeps a stuck
  # unread counter from turning the retry into a busy loop.
  if [[ "$printed" == "0" ]]; then
    sleep 1
    continue
  fi

  if [[ "$once" == "1" ]]; then
    exit 0
  fi
done