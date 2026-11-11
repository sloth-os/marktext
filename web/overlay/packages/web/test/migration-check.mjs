// One-shot manual verification of the tab-bar state migration:
//  1. seed a session blob as the pre-fix build wrote it (tabBar visible:false)
//  2. load the app — the migration must flip it to visible
//  3. reload — the marker keeps the migrated value and the bar stays visible
//  4. hide the bar via View > Toggle Tab Bar, reload — the deliberate choice
//     must survive (migration never runs again)
// Run: CHROMIUM_EXECUTABLE=... node migration-check.mjs <dist>
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { chromium } from '@playwright/test'

const DIST = process.argv[2] || join(process.cwd(), '../../../dist')
const PORT = 4319

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
}

const indexHtml = await readFile(join(DIST, 'index.html'), 'utf8')
const baseMatch = /(?:src|href)="\/([a-z0-9._-]+)\/(?:assets|registerSW\.js|manifest|sw\.js|icon|favicon)/i.exec(indexHtml)
const BASE = baseMatch ? `/${baseMatch[1]}` : ''

const server = createServer(async(req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (BASE && pathname === '/') {
      res.writeHead(302, { location: `${BASE}/` })
      res.end()
      return
    }
    if (BASE && pathname.startsWith(BASE)) pathname = pathname.slice(BASE.length) || '/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = normalize(join(DIST, pathname))
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end('forbidden')
      return
    }
    const body = await readFile(file)
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store'
    })
    res.end(body)
  } catch {
    try {
      const body = await readFile(join(DIST, 'index.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  }
})
await new Promise((resolve) => server.listen(PORT, resolve))
console.log(`serving ${DIST} at http://localhost:${PORT}`)

// Same Chromium resolution as smoke.mjs / repro-tab-switch.mjs: prefer the
// env var, then playwright's expected revision if present on disk, then any
// binary found in the playwright cache.
const resolveChromium = () => {
  if (process.env.CHROMIUM_EXECUTABLE) return process.env.CHROMIUM_EXECUTABLE
  try {
    const candidate = chromium.executablePath()
    if (typeof candidate === 'string' && existsSync(candidate)) return candidate
  } catch {
    // fall through to the cache scan below
  }
  const cache = join(process.env.HOME ?? '', '.cache', 'ms-playwright')
  if (!existsSync(cache)) return null
  const revisionDirs = readdirSync(cache)
    .filter((name) => /^chromium(-\d+)?$/.test(name))
    .sort()
    .reverse()
  for (const revisionDir of revisionDirs) {
    for (const platform of readdirSync(join(cache, revisionDir))) {
      const candidate = join(cache, revisionDir, platform, 'chrome')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

const CHROMIUM = resolveChromium()
const browser = await chromium.launch({
  headless: true,
  ...(CHROMIUM ? { executablePath: CHROMIUM } : {})
})

// A session blob exactly as the pre-fix build persisted it: layout present
// with the poisoned false default, no migrations field (old blob).
const poisonedState = JSON.stringify({
  contextToken: 'pre-fix-token',
  untitledCounter: 1,
  documents: [],
  activeDocumentId: null,
  layout: {
    sidebar: { visible: false, activeView: 'files', preferredWidthPx: 280, openedFiles: { expanded: true, preferredHeightPx: 112 } },
    outline: { visible: true, position: 'left', preferredWidthPx: 220 },
    tabBar: { visible: false },
    modes: { sourceCode: false, focus: false, typewriter: false }
  },
  projectView: { roots: [] },
  recentDocuments: []
})

const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}

try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  const page = await context.newPage()
  // NOTE: addInitScript runs on EVERY navigation (including reloads), so the
  // seed must be one-shot — otherwise each reload would overwrite the live
  // session (and its migration marker) with the poisoned blob again.
  await page.addInitScript((blob) => {
    if (localStorage.getItem('mtweb:session-state') === null) {
      localStorage.setItem('mtweb:session-state', blob)
    }
  }, poisonedState)

  await page.goto(`http://localhost:${PORT}${BASE || ''}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.title-bar, .recent-files-projects, .editor-placeholder', { timeout: 45000 })
  await page.waitForTimeout(2500)

  // Open an editor (the seeded session has no documents, so the app boots to
  // the recent-files screen where the tab strip is not rendered at all).
  const newFileButton = page.getByRole('button').filter({ hasText: /new file|新建/i }).first()
  if (await newFileButton.count()) await newFileButton.click()
  await page.waitForSelector('.mu-editor, .editor-wrapper', { timeout: 15000 })
  await page.waitForTimeout(1200)

  // Give the tab content: empty untitled documents are not restored across
  // reloads, and the test needs the editor present after each reload.
  await page.evaluate(() => {
    const target = document.querySelector('.mu-editor [contenteditable], .mu-editor')
    if (target instanceof HTMLElement) target.focus()
  })
  await page.keyboard.type('migration check content', { delay: 15 })
  await page.waitForTimeout(800)

  // 1. The poisoned session must load with a visible tab strip after migration.
  let box = await page.locator('.editor-tabs').boundingBox()
  check('poisoned session: tab bar visible after migration', (box?.height ?? 0) > 0, `height=${box?.height ?? 'none'}`)

  // 2. The migration ran exactly once and recorded its marker.
  let state = await page.evaluate(() => JSON.parse(localStorage.getItem('mtweb:session-state') || '{}'))
  const markerSet = Array.isArray(state.migrations) && state.migrations.includes('tabbar-visible-default')
  const migratedValue = state.layout?.tabBar?.visible === true
  check('migration marker recorded', markerSet, JSON.stringify(state.migrations))
  check('persisted layout tabBar.visible flipped to true', migratedValue, JSON.stringify(state.layout?.tabBar))

  // 3. Reload: the marker prevents re-migration and the bar stays visible.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  box = await page.locator('.editor-tabs').boundingBox()
  check('reload keeps tab bar visible', (box?.height ?? 0) > 0, `height=${box?.height ?? 'none'}`)
  state = await page.evaluate(() => JSON.parse(localStorage.getItem('mtweb:session-state') || '{}'))
  check('reload keeps marker single', (state.migrations ?? []).filter((m) => m === 'tabbar-visible-default').length === 1, JSON.stringify(state.migrations))

  // 4. A deliberate user toggle after migration must survive reload.
  const menuButton = page.locator('.frameless-titlebar-menu').first()
  await menuButton.click()
  await page.waitForTimeout(400)
  await page.locator('.web-menu-item', { hasText: 'View' }).first().hover()
  await page.waitForTimeout(300)
  await page.locator('.web-submenu .web-menu-item', { hasText: 'Toggle Tab Bar' }).first().click()
  await page.waitForTimeout(800)
  box = await page.locator('.editor-tabs').boundingBox()
  check('View > Toggle Tab Bar hides the bar', (box?.height ?? 0) === 0, `height=${box?.height ?? 'none'}`)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  box = await page.locator('.editor-tabs').boundingBox()
  check('deliberate hide survives reload (migration not re-run)', (box?.height ?? 0) === 0, `height=${box?.height ?? 'none'}`)
  state = await page.evaluate(() => JSON.parse(localStorage.getItem('mtweb:session-state') || '{}'))
  check('persisted tabBar.visible stays false', state.layout?.tabBar?.visible === false, JSON.stringify(state.layout?.tabBar))

  await context.close()
} finally {
  await browser.close()
  server.close()
}
