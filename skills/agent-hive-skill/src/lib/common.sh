#!/usr/bin/env bash
# Shared helpers for the agent-hive skill.
set -euo pipefail

COMMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HIVE_SRC_DIR="$(cd "$COMMON_DIR/.." && pwd)"
HIVE_SKILL_DIR="$(cd "$HIVE_SRC_DIR/.." && pwd)"
HIVE_PY="$HIVE_SRC_DIR/lib/hive.py"
MAX_FILE_SIZE=52428800

# Optional local overrides. The server URL comes from AGENT_HIVE_URL.
if [[ -f "$HIVE_SKILL_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  source "$HIVE_SKILL_DIR/.env"
fi

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

require_common() {
  require_cmd curl
  require_cmd python3
  require_cmd openssl
}

json_field() {
  local key="$1"
  local json="$2"
  printf '%s' "$json" | python3 "$HIVE_PY" get "$key"
}

response_error() {
  local body="$1"
  local status="$2"
  local message=""
  message="$(json_field error "$body" 2>/dev/null || true)"
  printf '%s' "${message:-Request failed (HTTP $status).}"
}

normalize_server_url() {
  local url="$1"
  case "$url" in
    http://*|https://*) ;;
    *) die "server URL must start with http:// or https://" ;;
  esac
  printf '%s' "${url%/}"
}

find_session_dir() {
  if [[ -n "${HIVE_SESSION_DIR:-}" ]]; then
    [[ -f "$HIVE_SESSION_DIR/credentials.enc" ]] ||
      die "no credentials.enc in HIVE_SESSION_DIR"
    printf '%s' "$HIVE_SESSION_DIR"
    return
  fi

  local state_dir="${HIVE_STATE_DIR:-${HOME:-}/.agent-hive-sessions}"
  if [[ -n "${HIVE_STATE_DIR:-}${HOME:-}" && -f "$state_dir/$HIVE_SESSION_ID" ]]; then
    local registered_workspace
    registered_workspace="$(cat "$state_dir/$HIVE_SESSION_ID" 2>/dev/null || true)"
    if [[ -n "$registered_workspace" && -f "$registered_workspace/.agent-hive/$HIVE_SESSION_ID/credentials.enc" ]]; then
      printf '%s' "$registered_workspace/.agent-hive/$HIVE_SESSION_ID"
      return
    fi
  fi

  if [[ -n "${HIVE_WORKSPACE:-}" ]]; then
    if [[ -f "$HIVE_WORKSPACE/.agent-hive/$HIVE_SESSION_ID/credentials.enc" ]]; then
      printf '%s' "$HIVE_WORKSPACE/.agent-hive/$HIVE_SESSION_ID"
      return
    fi
  fi

  local dir="$PWD"
  while true; do
    if [[ -f "$dir/.agent-hive/$HIVE_SESSION_ID/credentials.enc" ]]; then
      printf '%s' "$dir/.agent-hive/$HIVE_SESSION_ID"
      return
    fi
    if [[ "$dir" == "/" ]]; then
      break
    fi
    dir="$(dirname "$dir")"
  done

  die "session directory not found for $HIVE_SESSION_ID; run from the agent workspace or set HIVE_WORKSPACE"
}

require_session_env() {
  [[ -n "${HIVE_SESSION_ID:-}" ]] || die "missing environment variable: HIVE_SESSION_ID"
  [[ -n "${HIVE_SESSION_PWD:-}" ]] || die "missing environment variable: HIVE_SESSION_PWD"
}

load_session() {
  require_common
  require_session_env

  local session_dir credentials configured_url configured_id credentials_tmp
  session_dir="$(find_session_dir)"
  export HIVE_CRED_KEY="${HIVE_SESSION_ID}:${HIVE_SESSION_PWD}"
  credentials_tmp="$(mktemp)"

  if ! openssl enc -d -aes-256-cbc -salt -pbkdf2 -iter 100000 -md sha256 -base64 -A \
    -in "$session_dir/credentials.enc" -out "$credentials_tmp" \
    -pass env:HIVE_CRED_KEY 2>/dev/null; then
    rm -f "$credentials_tmp"
    die "unable to decrypt session credentials; check HIVE_SESSION_ID and HIVE_SESSION_PWD"
  fi
  credentials="$(cat "$credentials_tmp")"
  rm -f "$credentials_tmp"
  session_dir="$(cd "$session_dir" && pwd -P)"

  configured_id="$(json_field session_id "$credentials" 2>/dev/null || true)"
  [[ "$configured_id" == "$HIVE_SESSION_ID" ]] ||
    die "session credentials do not match HIVE_SESSION_ID"

  configured_url="$(json_field server_url "$credentials" 2>/dev/null || true)"
  requested_url="${AGENT_HIVE_URL:-$configured_url}"
  [[ -n "$requested_url" ]] ||
    die "missing AGENT_HIVE_URL; export the Agent Hive server URL"
  SERVER_URL="$(normalize_server_url "$requested_url")"
  SESSION_DIR="$session_dir"
  CREDENTIALS_JSON="$credentials"
  export HIVE_INBOX_DIR="$SESSION_DIR/inbox"
  export AGENT_HIVE_URL="$SERVER_URL"
}

http_post_json() {
  local path="$1"
  local payload="$2"
  local tmp status body
  tmp="$(mktemp)"

  if ! status="$(
    curl -sS -o "$tmp" -w '%{http_code}' \
      -X POST \
      -H "Content-Type: application/json" \
      -H "X-Hive-Session-Id: $HIVE_SESSION_ID" \
      -H "X-Hive-Session-Pwd: $HIVE_SESSION_PWD" \
      -d "$payload" \
      "$SERVER_URL$path"
  )"; then
    rm -f "$tmp"
    die "unable to reach $SERVER_URL"
  fi

  body="$(cat "$tmp")"
  rm -f "$tmp"

  if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
    die "$(response_error "$body" "$status")"
  fi
  printf '%s' "$body"
}

http_get() {
  local path="$1"
  local tmp status body
  tmp="$(mktemp)"

  if ! status="$(
    curl -sS -o "$tmp" -w '%{http_code}' \
      -H "X-Hive-Session-Id: $HIVE_SESSION_ID" \
      -H "X-Hive-Session-Pwd: $HIVE_SESSION_PWD" \
      "$SERVER_URL$path"
  )"; then
    rm -f "$tmp"
    die "unable to reach $SERVER_URL"
  fi

  body="$(cat "$tmp")"
  rm -f "$tmp"

  if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
    die "$(response_error "$body" "$status")"
  fi
  printf '%s' "$body"
}

assert_contact() {
  local target="$1"
  if [[ "$target" == "user" ]]; then
    return 0
  fi
  [[ "$target" != "$HIVE_SESSION_ID" ]] || die "cannot target the current session"

  local contacts
  contacts="$(http_get "/api/agent/contacts")"
  if ! printf '%s' "$contacts" | python3 "$HIVE_PY" has-contact "$target"; then
    die "contact not found: $target"
  fi
}
