#!/usr/bin/env bash
# Apply this repository's patches onto the upstream MarkText tree and lay the
# web overlay files on top. Patches are plain unified diffs applied with
# `git apply`; the overlay is rsynced from web/overlay.
#
# The script is idempotent: already-applied patches and up-to-date overlay
# files are detected and skipped, so it is safe to run repeatedly.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DIR="${MARKTEXT_DIR:-$REPO_DIR/marktext}"

if [ ! -d "$UPSTREAM_DIR" ]; then
  echo "!! $UPSTREAM_DIR not found; run scripts/fetch-upstream.sh first." >&2
  exit 1
fi

echo "==> Applying patches to $UPSTREAM_DIR"
shopt -s nullglob
PATCHES=("$REPO_DIR"/patches/*.patch)
if [ ${#PATCHES[@]} -eq 0 ]; then
  echo "    (no patches found)"
fi
for patch in "${PATCHES[@]}"; do
  if git -C "$UPSTREAM_DIR" apply --check --reverse "$patch" >/dev/null 2>&1; then
    echo "    already applied: $(basename "$patch")"
  elif git -C "$UPSTREAM_DIR" apply --check "$patch" >/dev/null 2>&1; then
    echo "    applying $(basename "$patch")"
    git -C "$UPSTREAM_DIR" apply --whitespace=nowarn "$patch"
  else
    echo "    !! $(basename "$patch") does not apply (neither forward nor reverse)" >&2
    exit 1
  fi
done

echo "==> Overlaying web/ files onto the upstream tree"
if [ -d "$REPO_DIR/web/overlay" ]; then
  rsync -a --checksum --exclude .gitignore "$REPO_DIR/web/overlay/" "$UPSTREAM_DIR/"
fi

echo "==> Patches and overlay applied"
