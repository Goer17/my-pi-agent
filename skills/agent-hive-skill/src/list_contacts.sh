#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

usage() {
  cat <<'EOF'
Usage: list_contacts.sh

List the user and every agent connected to this session.

Environment:
  HIVE_SESSION_ID   Registered session id
  HIVE_SESSION_PWD  Session password
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

load_session
body="$(http_get "/api/agent/contacts")"
printf '%s' "$body" | python3 "$HIVE_PY" render-contacts
