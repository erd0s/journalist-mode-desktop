#!/usr/bin/env bash

set -euo pipefail

JM_PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly JM_PROJECT_DIR
readonly JM_APP_PATH="$JM_PROJECT_DIR/build/bin/Journalist Mode.app"
readonly JM_BUNDLE_ID="com.dirkstewart.journalist-mode"
readonly JM_ICON_SOURCE="$JM_PROJECT_DIR/assets/logo-1024.png"
readonly JM_WAILS_ICON="$JM_PROJECT_DIR/build/appicon.png"

fail() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}

require_command() {
    command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

discover_developer_id() {
    /usr/bin/security find-identity -v -p codesigning 2>/dev/null \
        | /usr/bin/sed -n 's/.*"\(Developer ID Application:[^"]*\)".*/\1/p' \
        | /usr/bin/head -n 1
}

sign_path() {
    local path="$1"
    /usr/bin/codesign "${JM_SIGN_ARGS[@]}" "$path"
}

require_command wails3
require_command file
require_command xcrun

cd "$JM_PROJECT_DIR"

[[ -f "$JM_ICON_SOURCE" ]] || fail "app icon not found: $JM_ICON_SOURCE"
JM_ICON_WIDTH="$(/usr/bin/sips -g pixelWidth "$JM_ICON_SOURCE" 2>/dev/null \
    | /usr/bin/awk '/pixelWidth:/ { print $2 }')"
JM_ICON_HEIGHT="$(/usr/bin/sips -g pixelHeight "$JM_ICON_SOURCE" 2>/dev/null \
    | /usr/bin/awk '/pixelHeight:/ { print $2 }')"
[[ "$JM_ICON_WIDTH" == "1024" && "$JM_ICON_HEIGHT" == "1024" ]] \
    || fail "app icon must be a 1024x1024 PNG"
/usr/bin/ditto "$JM_ICON_SOURCE" "$JM_WAILS_ICON"

wails3 package

[[ -d "$JM_APP_PATH" ]] || fail "Wails did not produce: $JM_APP_PATH"

JM_SIGNING_IDENTITY="${JM_CODESIGN_IDENTITY:-}"
if [[ -z "$JM_SIGNING_IDENTITY" ]]; then
    JM_SIGNING_IDENTITY="$(discover_developer_id)"
fi
if [[ -z "$JM_SIGNING_IDENTITY" ]]; then
    JM_SIGNING_IDENTITY="-"
    printf 'No Developer ID Application certificate found; using an ad-hoc signature.\n'
fi

JM_SIGN_ARGS=(--force --options runtime --sign "$JM_SIGNING_IDENTITY")
if [[ "$JM_SIGNING_IDENTITY" == "-" ]]; then
    JM_SIGN_ARGS+=(--timestamp=none)
else
    JM_SIGN_ARGS+=(--timestamp)
fi

printf 'Signing with: %s\n' "$JM_SIGNING_IDENTITY"

# Sign every Mach-O payload first. Wails currently has one executable, but this
# keeps the package correct if helpers or native libraries are added later.
while IFS= read -r -d '' JM_CODE_PATH; do
    if /usr/bin/file -b "$JM_CODE_PATH" | /usr/bin/grep -q 'Mach-O'; then
        sign_path "$JM_CODE_PATH"
    fi
done < <(/usr/bin/find "$JM_APP_PATH/Contents" -type f -print0)

# Sign nested bundles from deepest to shallowest before sealing the outer app.
while IFS= read -r JM_NESTED_BUNDLE; do
    [[ -n "$JM_NESTED_BUNDLE" ]] && sign_path "$JM_NESTED_BUNDLE"
done < <(/usr/bin/find "$JM_APP_PATH/Contents" -depth -type d \
    \( -name '*.app' -o -name '*.appex' -o -name '*.framework' -o -name '*.xpc' \) \
    -print)

sign_path "$JM_APP_PATH"

/usr/bin/codesign --verify --deep --strict --verbose=2 "$JM_APP_PATH"

JM_NOTARY_PROFILE_VALUE="${JM_NOTARY_PROFILE:-}"
if [[ -n "$JM_NOTARY_PROFILE_VALUE" ]]; then
    [[ "$JM_SIGNING_IDENTITY" != "-" ]] \
        || fail "notarization requires a Developer ID Application signature"

    JM_PACKAGE_TMP="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/journalist-mode-notary.XXXXXX")"
    trap '/bin/rm -rf "$JM_PACKAGE_TMP"' EXIT
    JM_NOTARY_ZIP="$JM_PACKAGE_TMP/Journalist Mode.zip"

    /usr/bin/ditto -c -k --keepParent "$JM_APP_PATH" "$JM_NOTARY_ZIP"
    xcrun notarytool submit "$JM_NOTARY_ZIP" \
        --keychain-profile "$JM_NOTARY_PROFILE_VALUE" \
        --wait
    xcrun stapler staple "$JM_APP_PATH"
    xcrun stapler validate "$JM_APP_PATH"
    /usr/bin/codesign --verify --deep --strict --verbose=2 "$JM_APP_PATH"
    /usr/sbin/spctl --assess --type execute --verbose=2 "$JM_APP_PATH"
else
    printf 'Notarization skipped. Set JM_NOTARY_PROFILE to submit and staple.\n'
fi

JM_SIGNED_IDENTIFIER="$(/usr/bin/codesign -d --verbose=4 "$JM_APP_PATH" 2>&1 \
    | /usr/bin/sed -n 's/^Identifier=//p')"
[[ "$JM_SIGNED_IDENTIFIER" == "$JM_BUNDLE_ID" ]] \
    || fail "unexpected signed bundle identifier: $JM_SIGNED_IDENTIFIER"

printf '\nReady to install:\n%s\n' "$JM_APP_PATH"
