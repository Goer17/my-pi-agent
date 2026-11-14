#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

MAX_ATTACHMENTS=10
MAX_TOTAL_FILE_SIZE=104857600

usage() {
  cat <<'EOF'
Usage: send.sh [--session_id TARGET] (--text TEXT | --text-file PATH) [--file PATH]...

Send a message and/or files to the user or to a connected agent. TARGET
defaults to "user". Each file is limited to 50 MB; one message can carry up to
10 files and 100 MB total. Repeat --file to attach several files:

  ./send.sh --text "Two tables attached." --file a.png --file b.png

--text and --text-file are mutually exclusive. With --text-file the file is read
as Markdown; image links that point at absolute local paths or http(s) URLs are
uploaded to the server first (remote images are downloaded), then rewritten to
server-served URLs (/api/files/<id>) before the message is sent. Paths
containing spaces can use angle brackets:
  ![alt](</absolute/path with spaces.png>)

Environment:
  HIVE_SESSION_ID   Registered session id
  HIVE_SESSION_PWD  Session password
EOF
}

target="user"
text=""
text_file=""
text_from_file="0"
files=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session_id)
      [[ $# -ge 2 ]] || die "--session_id requires a value"
      target="$2"
      shift 2
      ;;
    --text)
      [[ $# -ge 2 ]] || die "--text requires a value"
      text="$2"
      shift 2
      ;;
    --text-file)
      [[ $# -ge 2 ]] || die "--text-file requires a value"
      text_file="$2"
      shift 2
      ;;
    --file)
      [[ $# -ge 2 ]] || die "--file requires a value"
      files+=("$2")
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

if [[ -n "$text" && -n "$text_file" ]]; then
  die "--text and --text-file cannot be used together"
fi

if [[ -n "$text_file" ]]; then
  [[ -f "$text_file" ]] || die "text file not found: $text_file"
  text="$(cat "$text_file")"
  text_from_file="1"
fi

if [[ -z "$text" && ${#files[@]} -eq 0 ]]; then
  die "provide --text/--text-file and/or --file"
fi

if [[ ${#files[@]} -gt "$MAX_ATTACHMENTS" ]]; then
  die "a message supports at most $MAX_ATTACHMENTS files"
fi

total_file_size=0
for attached_file in ${files[@]+"${files[@]}"}; do
  [[ -f "$attached_file" ]] || die "file not found: $attached_file"
  file_size="$(wc -c <"$attached_file" | tr -d '[:space:]')"
  [[ "$file_size" -le "$MAX_FILE_SIZE" ]] || die "file exceeds the 50 MB limit: $attached_file"
  total_file_size=$((total_file_size + file_size))
done
[[ "$total_file_size" -le "$MAX_TOTAL_FILE_SIZE" ]] || die "attachments exceed the 100 MB total limit"

load_session
assert_contact "$target"

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

# Upload local and remote images referenced by the Markdown file and rewrite
# their links to server URLs. Only --text-file is processed; --text is sent
# verbatim.
if [[ "$text_from_file" == "1" && -n "$text" ]]; then
  image_paths="$(printf '%s' "$text" | python3 "$HIVE_PY" md-image-paths)"
  if [[ -n "$image_paths" ]]; then
    image_map="$tmpdir/image-map.json"
    printf '{}' >"$image_map"

    remote_index="0"
    while IFS= read -r image_ref; do
      [[ -n "$image_ref" ]] || continue

      upload_path=""
      extension=""
      if [[ "$image_ref" == http://* || "$image_ref" == https://* ]]; then
        remote_index=$((remote_index + 1))
        download_path="$tmpdir/remote-$remote_index"
        if ! content_type="$(
          curl -L -sS --fail --connect-timeout 10 --max-time 60 --max-filesize "$MAX_FILE_SIZE" \
            -o "$download_path" -w '%{content_type}' "$image_ref"
        )"; then
          die "failed to download image: $image_ref"
        fi
        case "$content_type" in
          image/png*) extension="png" ;;
          image/jpeg*) extension="jpg" ;;
          image/gif*) extension="gif" ;;
          image/webp*) extension="webp" ;;
          image/avif*) extension="avif" ;;
          *) die "unsupported remote image type (${content_type:-unknown}): $image_ref" ;;
        esac
        download_size="$(wc -c <"$download_path" | tr -d '[:space:]')"
        [[ "$download_size" -le "$MAX_FILE_SIZE" ]] || die "remote image exceeds the 50 MB limit: $image_ref"
        upload_path="$tmpdir/remote-image-$remote_index.$extension"
        mv "$download_path" "$upload_path"
      else
        [[ "$image_ref" == /* ]] || die "image path must be absolute or an http(s) URL: $image_ref"
        [[ -f "$image_ref" ]] || die "image not found: $image_ref"

        extension="$(printf '%s' "${image_ref##*.}" | tr '[:upper:]' '[:lower:]')"
        case "$extension" in
          png|jpg|jpeg|gif|webp|avif) ;;
          *) die "unsupported image type (use png/jpg/jpeg/gif/webp/avif): $image_ref" ;;
        esac

        image_size="$(wc -c <"$image_ref" | tr -d '[:space:]')"
        [[ "$image_size" -le "$MAX_FILE_SIZE" ]] || die "image exceeds the 50 MB limit: $image_ref"
        upload_path="$image_ref"
      fi

      upload_response_file="$tmpdir/upload.json"
      if ! upload_status="$(
        curl -sS -o "$upload_response_file" -w '%{http_code}' \
          --connect-timeout 10 \
          -X POST \
          -H "X-Hive-Session-Id: $HIVE_SESSION_ID" \
          -H "X-Hive-Session-Pwd: $HIVE_SESSION_PWD" \
          -F "file=@${upload_path}" \
          "$SERVER_URL/api/agent/files"
      )"; then
        die "unable to reach $SERVER_URL"
      fi

      upload_response="$(cat "$upload_response_file")"
      if [[ "$upload_status" -lt 200 || "$upload_status" -ge 300 ]]; then
        die "$(response_error "$upload_response" "$upload_status")"
      fi

      uploaded_file="$(json_field file "$upload_response")"
      image_url="$(json_field url "$uploaded_file")"
      [[ -n "$image_url" ]] || die "server did not return an image URL for $image_ref"

      python3 "$HIVE_PY" md-add-image "$image_map" "$image_ref" "$image_url"
    done <<<"$image_paths"

    text="$(printf '%s' "$text" | HIVE_IMAGE_MAP_FILE="$image_map" python3 "$HIVE_PY" md-replace-images)"
  fi
fi

response_file="$tmpdir/response.json"

curl_args=(
  -sS
  -o "$response_file"
  -w '%{http_code}'
  --connect-timeout 10
  -X POST
  -H "X-Hive-Session-Id: $HIVE_SESSION_ID"
  -H "X-Hive-Session-Pwd: $HIVE_SESSION_PWD"
  --form-string "to=$target"
)

if [[ -n "$text" ]]; then
  curl_args+=(--form-string "text=$text")
fi
if [[ ${#files[@]} -gt 0 ]]; then
  for attached_file in "${files[@]}"; do
    curl_args+=(-F "files=@${attached_file}")
  done
fi

if ! status="$(curl "${curl_args[@]}" "$SERVER_URL/api/agent/messages")"; then
  die "unable to reach $SERVER_URL"
fi

response="$(cat "$response_file")"
if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
  die "$(response_error "$response" "$status")"
fi

printf 'Sent to %s.\n' "$target"