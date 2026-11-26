#!/usr/bin/env sh
set -eu

REPO_URL="${CACHE_GUARD_REPO:-https://github.com/wingkit123/agy-cache-guard.git}"
TARGET_DIR="${HOME}/.gemini/config/plugins/cache-guard"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js >= 20 is required." >&2
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Error: Node.js >= 20 is required (found v$NODE_MAJOR)." >&2
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "Error: git is required." >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET_DIR")"

if [ -d "$TARGET_DIR/.git" ]; then
  echo "Updating existing cache-guard installation..."
  git -C "$TARGET_DIR" pull --ff-only
elif [ -e "$TARGET_DIR" ]; then
  echo "Error: $TARGET_DIR already exists and is not a git repository." >&2
  exit 1
else
  echo "Cloning cache-guard into $TARGET_DIR..."
  git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
fi

cd "$TARGET_DIR"
node tests/guard.test.mjs

echo "cache-guard installed successfully. Open a new Antigravity session to activate hooks."
