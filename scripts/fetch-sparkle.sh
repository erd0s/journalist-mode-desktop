#!/usr/bin/env bash
set -euo pipefail
JM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JM_SPARKLE_VERSION=2.9.6
JM_SPARKLE_SHA=52bf9e88cdd972fc0c81501377a880e90d47031bd8ca5462488f843e2609e192
JM_SPARKLE_DIR="$JM_ROOT/build/sparkle"
if [[ -f "$JM_SPARKLE_DIR/.version" && "$(cat "$JM_SPARKLE_DIR/.version")" == "$JM_SPARKLE_VERSION:$JM_SPARKLE_SHA" && -f "$JM_SPARKLE_DIR/Sparkle.framework/Sparkle" ]]; then
    exit 0
fi
JM_SPARKLE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/jm-sparkle.XXXXXX")"
trap 'rm -rf "$JM_SPARKLE_TMP"' EXIT
curl --fail --location --retry 3 --output "$JM_SPARKLE_TMP/Sparkle.tar.xz" \
    "https://github.com/sparkle-project/Sparkle/releases/download/$JM_SPARKLE_VERSION/Sparkle-$JM_SPARKLE_VERSION.tar.xz"
[[ "$(shasum -a 256 "$JM_SPARKLE_TMP/Sparkle.tar.xz" | awk '{print $1}')" == "$JM_SPARKLE_SHA" ]] || { echo 'Sparkle checksum mismatch' >&2; exit 1; }
mkdir -p "$JM_SPARKLE_TMP/extracted"
tar -xJf "$JM_SPARKLE_TMP/Sparkle.tar.xz" -C "$JM_SPARKLE_TMP/extracted" ./Sparkle.framework ./bin ./LICENSE
rm -rf "$JM_SPARKLE_DIR"
mv "$JM_SPARKLE_TMP/extracted" "$JM_SPARKLE_DIR"
printf '%s:%s\n' "$JM_SPARKLE_VERSION" "$JM_SPARKLE_SHA" > "$JM_SPARKLE_DIR/.version"
