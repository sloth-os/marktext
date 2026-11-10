# MarkText Web

A Progressive Web App (PWA) build of [MarkText](https://github.com/marktext/marktext),
the WYSIWYG markdown editor. The web build reuses the renderer (Vue 3 + Muya)
from the upstream monorepo and replaces the Electron main process with a
browser shim, so the same editor runs at a URL, installs to your device, and
works offline.

**Live site**: published weekly to this repository's GitHub Pages URL by
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml).

## How it works

This repository does **not** fork MarkText's source. Instead, at build time it:

1. Clones upstream `marktext/marktext` (latest `develop`).
2. Applies small patches ([`patches/`](patches)):
   - fixes an upstream CSS `var()` typo that trips strict minifiers,
   - makes muya share a single Prism instance (web bundlers can duplicate
     prismjs copies across chunks; Electron's single bundle never hits this).
3. Overlays [`web/overlay/`](web/overlay) onto the monorepo, adding a
   `packages/web` workspace package that:
   - compiles the **unmodified renderer sources** through Vite with the same
     aliases the Electron build uses (`@/`, `common/`, `@shared/`),
   - provides browser equivalents for everything the renderer expects from
     Electron's preload: `window.electron` (IPC), `window.path`,
     `window.fileUtils` (Origin Private File System), `window.ripgrep`
     (in-browser search), `window.i18nUtils`, and more — see
     [`web/overlay/packages/web/src/web-shim/`](web/overlay/packages/web/src/web-shim),
   - implements the `mt::state::*` document/session protocol (the main
     process's state host) on top of OPFS + localStorage.
4. Produces a static `dist/` bundle with a service worker (`vite-plugin-pwa`).
5. Publishes `dist/` to GitHub Pages every week (and on demand).

## Features

- **Full MarkText editor** — WYSIWYG markdown editing, themes, source-code
  mode, typewriter/focus modes, math (KaTeX), Mermaid/PlantUML diagrams,
  Prism syntax highlighting, export, preferences.
- **PWA** — installable app with icons and standalone window.
- **Works offline** — the service worker precaches the entire app shell
  (~700 assets); after the first visit no network access is required.
- **PWA File Handling** — the manifest registers `file_handlers` for
  `.md`/`.markdown`/… files with `launch_handler: focus-existing`: opening a
  markdown file from the OS launches (or focuses) the app and loads the file
  into a new tab. Files are imported into OPFS for editing; with the
  File System Access API the app also keeps live handles so `Save`/`Save As`
  write back to the real file on disk.
- **Persistent sessions** — untitled tabs and opened files live in the
  browser's OPFS and are restored on the next launch.
- **Keyboard shortcuts & menus** — the desktop keybinding set runs through a
  global handler; the ☰ application menu and right-click context menus are
  rendered as HTML menus speaking the same `mt::menu::*` protocol.
- **In-browser search** — Quick Open and sidebar search use an OPFS walker
  speaking the ripgrep event protocol.

## Local development

```bash
# 1. Fetch upstream MarkText into ./marktext
./scripts/fetch-upstream.sh

# 2. Install + patch + build (single command does everything)
./scripts/build-web.sh

# 3. Serve the result
cd marktext/packages/web && pnpm exec vite preview
# or: npx serve marktext/dist

# 4. Run the headless smoke test (app boot, editor, menus, SW, offline)
cd marktext/packages/web && node test/smoke.mjs ../../dist
```

Requirements: Node.js ≥ 22.12, pnpm ≥ 10 (`corepack enable pnpm`).

## Repository layout

```
scripts/fetch-upstream.sh   clone/update upstream marktext (develop)
scripts/apply-patches.sh    idempotent patch + overlay application
scripts/build-web.sh        full build pipeline
patches/                    upstream patches (unified diffs)
web/overlay/packages/web/   the web package (shim sources, PWA assets, Vite)
  src/bootstrap.ts          web entry point (installs bridge, boots renderer)
  src/web-shim/             browser implementation of the Electron bridge
  src/sw.ts                 custom service worker (offline precache)
  test/smoke.mjs            headless browser smoke test
.github/workflows/deploy.yml  weekly Pages deployment
```

## Deployment

The workflow runs every Monday 03:00 UTC (and on manual dispatch — optionally
pinning an upstream ref — plus on pushes to `main` that touch the build):

1. Check out upstream MarkText at the requested ref.
2. Apply this repo's patches and overlay.
3. Install the pnpm workspace and build the web bundle.
4. Verify the PWA artifacts (manifest `file_handlers`, maskable icons, SW
   precache) and run the headless smoke test.
5. Upload `dist/` and deploy to GitHub Pages.

The repository needs Pages enabled with the **GitHub Actions** source (the
first deploy configures this via `actions/configure-pages`).

## License

MIT — same as upstream MarkText. The deployed bundle includes MarkText's
code and its third-party dependencies.
