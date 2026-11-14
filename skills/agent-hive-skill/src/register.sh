#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Usage: register.sh (--token TOKEN | --token-file PATH) [--workspace PATH] --task TASK [--harness NAME]

Register this agent session with the Agent Hive server. The workspace defaults
to the current directory. Credentials are written to
<workspace>/.agent-hive/<session_id>/credentials.enc.

Pass the registration token with exactly one of:
  --token TOKEN        Token value on the command line (visible in ps/history).
  --token-file PATH    File holding the token; the file is read and not echoed.
                       Preferred: it keeps the token out of `ps` and shell
                       history. Delete the file once registration succeeds.

Environment:
  AGENT_HIVE_URL    Agent Hive server URL (required)
  HIVE_HOST         Host name reported to the server (default: hostname)
EOF
}

token=""
token_file=""
workspace="."
task=""
harness=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --token)
      [[ $# -ge 2 ]] || die "--token requires a value"
      token="$2"
      shift 2
      ;;
    --token-file)
      [[ $# -ge 2 ]] || die "--token-file requires a value"
      token_file="$2"
      shift 2
      ;;
    --workspace)
      [[ $# -ge 2 ]] || die "--workspace requires a value"
      workspace="$2"
      shift 2
      ;;
    --task)
      [[ $# -ge 2 ]] || die "--task requires a value"
      task="$2"
      shift 2
      ;;
    --harness)
      [[ $# -ge 2 ]] || die "--harness requires a value"
      harness="$2"
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

require_common
require_cmd hostname

[[ -n "$token" || -n "$token_file" ]] || die "missing --token or --token-file"
[[ -z "$token" || -z "$token_file" ]] || die "--token and --token-file are mutually exclusive"
[[ -n "$task" ]] || die "missing --task"
[[ -d "$workspace" ]] || die "workspace does not exist: $workspace"
[[ -n "${AGENT_HIVE_URL:-}" ]] || die "missing environment variable: AGENT_HIVE_URL"

if [[ -n "$token_file" ]]; then
  [[ -e "$token_file" ]] || die "token file not found: $token_file"
  [[ -f "$token_file" ]] || die "token file is not a regular file: $token_file"
  [[ -r "$token_file" ]] || die "token file is not readable: $token_file"
  if [[ -n "$(find "$token_file" -maxdepth 0 -perm /077 2>/dev/null)" ]]; then
    printf 'warning: %s is readable by other users; chmod 600 is recommended\n' "$token_file" >&2
  fi
  # Strip line endings and surrounding whitespace so a trailing newline is fine.
  token="$(tr -d '\r\n' <"$token_file")"
  token="${token#"${token%%[![:space:]]*}"}"
  token="${token%"${token##*[![:space:]]}"}"
  [[ -n "$token" ]] || die "token file is empty: $token_file"
fi

workspace="$(cd -- "$workspace" && pwd -P)"
server_url="$(normalize_server_url "$AGENT_HIVE_URL")"
host="${HIVE_HOST:-$(hostname)}"

payload="$(
  HIVE_TOKEN="$token" \
  HIVE_WORKSPACE="$workspace" \
  HIVE_TASK="$task" \
  HIVE_HARNESS="$harness" \
  HIVE_HOST="$host" \
  python3 "$HIVE_PY" make-register-json
)"

response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT

if ! status="$(
  curl -sS -o "$response_file" -w '%{http_code}' \
    --connect-timeout 10 \
    -X POST "$server_url/api/agent/register" \
    -H "Content-Type: application/json" \
    --data-binary "$payload"
)"; then
  die "unable to reach $server_url"
fi

response="$(cat "$response_file")"
if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
  die "$(response_error "$response" "$status")"
fi

session_id="$(json_field session_id "$response" 2>/dev/null || true)"
session_pwd="$(json_field session_pwd "$response" 2>/dev/null || true)"
name="$(json_field name "$response" 2>/dev/null || true)"
returned_workspace="$(json_field workspace "$response" 2>/dev/null || true)"

[[ -n "$session_id" ]] || die "registration response is missing session_id"
[[ -n "$session_pwd" ]] || die "registration response is missing session_pwd"
[[ -n "$name" ]] || die "registration response is missing name"
workspace="${returned_workspace:-$workspace}"

session_dir="$workspace/.agent-hive/$session_id"
mkdir -p "$session_dir"
chmod 700 "$workspace/.agent-hive" "$session_dir"

credentials="$(
  AGENT_HIVE_URL="$server_url" \
  HIVE_HOST="$host" \
  python3 "$HIVE_PY" make-credentials <<<"$response"
)"

credentials_tmp="$(mktemp)"
trap 'rm -f "$response_file" "$credentials_tmp"' EXIT
printf '%s' "$credentials" >"$credentials_tmp"

if ! HIVE_CRED_KEY="$session_id:$session_pwd" openssl enc \
  -aes-256-cbc -salt -pbkdf2 -iter 100000 -md sha256 -base64 -A \
  -in "$credentials_tmp" -out "$session_dir/credentials.enc" \
  -pass env:HIVE_CRED_KEY 2>/dev/null; then
  die "failed to encrypt session credentials"
fi

chmod 600 "$session_dir/credentials.enc"
mkdir -p "$session_dir/inbox"
chmod 700 "$session_dir/inbox"
rm -f "$credentials_tmp"

state_dir="${HIVE_STATE_DIR:-${HOME:-}/.agent-hive-sessions}"
if [[ -n "${HIVE_STATE_DIR:-}${HOME:-}" ]]; then
  mkdir -p "$state_dir" 2>/dev/null || true
  chmod 700 "$state_dir" 2>/dev/null || true
  printf '%s\n' "$workspace" >"$state_dir/$session_id" 2>/dev/null || true
  chmod 600 "$state_dir/$session_id" 2>/dev/null || true
fi

printf 'Registered %s\n' "$name"
printf 'session_id=%s\n' "$session_id"
printf 'session_pwd=%s\n' "$session_pwd"
printf 'name=%s\n' "$name"
printf 'workspace=%s\n' "$workspace"
printf 'server=%s\n' "$server_url"
printf '\nExport these values for subsequent commands:\n'
printf '  export HIVE_SESSION_ID=%q\n' "$session_id"
printf '  export HIVE_SESSION_PWD=%q\n' "$session_pwd"
