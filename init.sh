#!/usr/bin/env bash
# Install the pi extensions and skills from this repository.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
EXT_SRC="$REPO_DIR/extensions"
SKILL_SRC="$REPO_DIR/skills"
EXT_DEST="$PI_AGENT_DIR/extensions"
SKILL_DEST="$PI_AGENT_DIR/skills"
MODELS_SRC="$REPO_DIR/models.json"
MODELS_DEST="$PI_AGENT_DIR/models.json"
MODE="copy"

usage() {
  cat <<'EOF'
Usage: ./init.sh [--link|--copy]

Install the extensions and skills in this repository into the pi agent dir,
then merge the Bailian provider from models.json into the agent's models.json.

Default: copy the files into the pi agent directory.
  --link   create symlinks instead, so edits in this repository are picked up directly
  --copy   copy the files (default)
  --help   show this help

Environment:
  PI_AGENT_DIR   target agent directory (default: ~/.pi/agent)
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --copy) MODE="copy"; shift ;;
    --link) MODE="link"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -d "$EXT_SRC" ]] || { echo "missing directory: $EXT_SRC" >&2; exit 1; }
[[ -d "$SKILL_SRC" ]] || { echo "missing directory: $SKILL_SRC" >&2; exit 1; }

mkdir -p "$PI_AGENT_DIR" "$EXT_DEST" "$SKILL_DEST"

install_item() {
  local src="$1" dest="$2" name="$3"
  if [[ -L "$dest" && "$(readlink "$dest")" == "$src" ]]; then
    printf 'ok       %s (already linked)\n' "$name"
    return
  fi
  if [[ -e "$dest" || -L "$dest" ]]; then
    local backup="${dest}.bak-$(date +%Y%m%d-%H%M%S)"
    mv "$dest" "$backup"
    printf 'backup   %s -> %s\n' "$dest" "$backup"
  fi
  if [[ "$MODE" == "copy" ]]; then
    if [[ -d "$src" ]]; then cp -R "$src" "$dest"; else cp "$src" "$dest"; fi
    printf 'copied   %s\n' "$name"
  else
    ln -s "$src" "$dest"
    printf 'linked   %s -> %s\n' "$name" "$src"
  fi
  if [[ -d "$dest" ]]; then
    find -L "$dest" -type f -name '*.sh' -exec chmod +x {} + 2>/dev/null || true
  fi
}

for src in "$EXT_SRC"/*; do
  [[ -e "$src" ]] || continue
  base="$(basename "$src")"
  [[ "$base" == .* ]] && continue
  install_item "$src" "$EXT_DEST/$base" "$base"
done

for src in "$SKILL_SRC"/*; do
  [[ -e "$src" ]] || continue
  base="$(basename "$src")"
  [[ "$base" == .* ]] && continue
  install_item "$src" "$SKILL_DEST/$base" "$base"
done

if [[ -f "$MODELS_SRC" ]]; then
  command -v python3 >/dev/null 2>&1 || {
    echo "python3 is required to merge models.json" >&2
    exit 1
  }
  python3 "$REPO_DIR/merge_models.py" "$MODELS_SRC" "$MODELS_DEST"
  if [[ -f "$MODELS_DEST" ]] && grep -q '\$BAILIAN_API_KEY' "$MODELS_DEST" && [[ -z "${BAILIAN_API_KEY:-}" ]]; then
    echo "note: BAILIAN_API_KEY is not set; export it (or use pi /login) before selecting Bailian models."
  fi
fi

echo
echo "Installed into $PI_AGENT_DIR ($MODE mode)."
echo "Next: start pi and run /reload (or restart pi) to load the extensions."
echo "Agent Hive skill: configure credentials in ~/.agent-hive/ and see skills/agent-hive-skill/SKILL.md."
for bin in pi node python3 curl openssl; do
  if command -v "$bin" >/dev/null 2>&1; then
    printf '  %-8s %s\n' "$bin" "$(command -v "$bin")"
  else
    printf '  %-8s NOT FOUND (needed by some extensions/skills)\n' "$bin"
  fi
done
