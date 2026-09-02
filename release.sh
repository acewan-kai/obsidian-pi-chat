#!/usr/bin/env bash
#
# Build the plugin for release and bundle it into a versioned zip ready
# to upload to a GitHub Release.
#
# Usage:  ./release.sh         (auto-detects version from manifest.json)
#         VERSION=0.2.0 ./release.sh
#
# Output: <repo-root>/pi-chat-<version>.zip  +  the individual files there.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

VERSION="${VERSION:-$(node -p "require('./manifest.json').version")}"

echo "==> Building version $VERSION"
npm run build

# Sanity: required files must be present.
for f in main.js styles.css manifest.json versions.json; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: missing required file: $f" >&2
    exit 1
  fi
done

# The community-plugin guidelines require minAppVersion in versions.json to
# match the lowest Obsidian version the plugin still works on. Update it to
# match manifest.json's minAppVersion.
node -e "
const fs = require('fs');
const m = require('./manifest.json');
let v = {};
try { v = JSON.parse(fs.readFileSync('versions.json', 'utf8')); } catch {}
v[m.version] = m.minAppVersion;
fs.writeFileSync('versions.json', JSON.stringify(v, null, 2) + '\n');
console.log('==> versions.json updated:', JSON.stringify(v));
"

# Bundle.
OUT_ZIP="$REPO_ROOT/pi-chat-${VERSION}.zip"
rm -f "$OUT_ZIP"
# Use system zip (no deps). On Windows we use PowerShell's Compress-Archive.
if command -v zip >/dev/null 2>&1; then
  zip -j "$OUT_ZIP" main.js styles.css manifest.json versions.json
else
  powershell -NoProfile -Command \
    "Compress-Archive -Force -Path 'main.js','styles.css','manifest.json','versions.json' -DestinationPath '$OUT_ZIP'"
fi

echo "==> Done."
echo "    $OUT_ZIP"
echo
echo "Next:"
echo "  1. Create a GitHub Release with tag v$VERSION"
echo "  2. Upload $OUT_ZIP as the release asset"
echo "  3. Add an entry to https://github.com/obsidianmd/obsidian-releases community-plugins.json"