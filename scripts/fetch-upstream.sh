#!/usr/bin/env bash
# Fetch the upstream MarkText monorepo into ./marktext at the latest commit
# of the default development branch. Keeps an existing checkout and pulls
# instead of re-cloning.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DIR="${MARKTEXT_DIR:-$REPO_DIR/marktext}"
UPSTREAM_URL="${MARKTEXT_URL:-https://github.com/marktext/marktext.git}"
# develop is the active integration branch of MarkText; releases are cut from it.
UPSTREAM_BRANCH="${MARKTEXT_BRANCH:-develop}"

if [ -d "$UPSTREAM_DIR/.git" ]; then
  echo "==> Updating existing checkout at $UPSTREAM_DIR"
  git -C "$UPSTREAM_DIR" fetch origin "$UPSTREAM_BRANCH"
  git -C "$UPSTREAM_DIR" checkout "$UPSTREAM_BRANCH"
  git -C "$UPSTREAM_DIR" reset --hard "origin/$UPSTREAM_BRANCH"
else
  echo "==> Cloning $UPSTREAM_URL (branch $UPSTREAM_BRANCH) into $UPSTREAM_DIR"
  mkdir -p "$UPSTREAM_DIR"
  git clone --depth 1 --branch "$UPSTREAM_BRANCH" "$UPSTREAM_URL" "$UPSTREAM_DIR"
fi

COMMIT="$(git -C "$UPSTREAM_DIR" rev-parse HEAD)"
echo "==> Upstream MarkText at $COMMIT"
echo "$COMMIT" > "$REPO_DIR/.upstream-commit"
