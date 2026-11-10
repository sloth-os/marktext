#!/usr/bin/env bash
# Build the MarkText web bundle:
#   1. ensure upstream checkout exists (fetch if missing)
#   2. apply patches + web overlay (adds packages/web to the workspace)
#   3. install workspace dependencies from the monorepo root
#   4. run the Vite PWA build from packages/web
# The static result lands in dist/ at the repository root.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_DIR="${MARKTEXT_DIR:-$REPO_DIR/marktext}"

cd "$REPO_DIR"

if [ ! -d "$UPSTREAM_DIR/.git" ]; then
  "$REPO_DIR/scripts/fetch-upstream.sh"
fi

echo "==> Applying patches and web overlay"
# The overlay adds packages/web, which the workspace root then installs.
"$REPO_DIR/scripts/apply-patches.sh"

# Some git-hosted deps (github:file-icons/atom) resolve over SSH by default;
# rewrite to HTTPS so fetches never hang waiting for keys.
git config --global url."https://github.com/".insteadOf "git@github.com:" || true

cd "$UPSTREAM_DIR"

PNPM="pnpm"
if ! command -v pnpm >/dev/null 2>&1; then
  PNPM="corepack pnpm"
fi

echo "==> Installing workspace dependencies at the monorepo root"
# packages/web is part of the pnpm workspace (packages/*), so one root install
# covers it. --ignore-scripts skips electron downloads and native rebuilds the
# web build never runs.
$PNPM install --ignore-scripts

echo "==> Building web bundle"
cd "$UPSTREAM_DIR/packages/web"
$PNPM exec vite build

echo "==> Done: static bundle in $UPSTREAM_DIR/dist"
