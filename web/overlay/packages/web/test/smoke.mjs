// Headless smoke test for the built MarkText web bundle.
// Serves dist/ statically, loads the app in Chromium, and checks that the
// editor UI mounts, a new document can be created, and text can be typed.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { chromium } from '@playwright/test'

const DIST = process.argv[2] || join(process.cwd(), 'dist')
const PORT = 4317

// The bundle may be built with a base path (GitHub Pages: /<repo>/). Detect
// it from the built index.html so the test server strips it from request
// paths — otherwise every asset request would404→index.html fallback.
const indexHtml = await readFile(join(DIST, 'index.html'), 'utf8')
const baseMatch = /(?:src|href)="\u002f([a-z0-9._-]+)\u002f(?:assets|registerSW\.js|manifest|sw\.js|icon|favicon)/i.exec(indexHtml)
const BASE = baseMatch ? `/${baseMatch[1]}` : ''
console.log(`serving base: '${BASE || '/'}'`)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
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

const server = createServer(async(req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    // Serve the SPA at both / and /<base>/ like GitHub Pages does.
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
    // SPA fallback for client-side routes.
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

// Use the locally cached Chromium build directly so the test does not depend
// on a matching `playwright install` browser revision. Note:
// `executablePath()` is synchronous in playwright 1.64 and points at the
// revision this playwright version expects, which is often not the installed
// one — so verify the path exists and otherwise fall back to scanning the
// playwright cache for any usable Chromium binary.
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
      // Linux layout: chromium-<rev>/chrome-linux[-arm64]/chrome
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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })

const errors = []
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
})

const results = {}
const check = (name, ok, detail = '') => {
  results[name] = [ok, detail]
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  await page.goto(`http://localhost:${PORT}${BASE || ''}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })

  // 1. Boot splash disappears and the app mounts.
  const appMounted = await page
    .waitForSelector('.title-bar, .recent-files-projects, .editor-placeholder', { timeout: 20000 })
    .then(() => true)
    .catch(() => false)
  check('app mounts', appMounted)

  // 2. Splash removed after mount.
  await page.waitForTimeout(1500)
  const splashGone = (await page.locator('#boot-splash').count()) === 0
  check('boot splash removed', splashGone)

  // 3. Service worker registers and controls the page (offline support).
  const swState = await page.evaluate(async() => {
    if (!('serviceWorker' in navigator)) return 'unsupported'
    const reg = await navigator.serviceWorker.getRegistration()
    if (!reg) return 'none'
    // Precaching ~700 assets takes a while; wait for activation.
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (navigator.serviceWorker.controller) return 'active'
      await reg.update().catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return `registered:${reg.active ? 'active' : 'installing'}`
  })
  check('service worker active', swState === 'active', `state=${swState}`)

  // 4. OPFS available (persistent document storage).
  const opfsOk = await page.evaluate(async() => {
    try {
      const root = await navigator.storage.getDirectory()
      await root.getDirectoryHandle('marktext-web', { create: true })
      return true
    } catch {
      return false
    }
  })
  check('OPFS storage available', opfsOk)

  // 5. Create a new untitled document (the Recent screen's New File button).
  const newFileButton = page.getByRole('button').filter({ hasText: /new file|新建/i }).first()
  if (await newFileButton.count()) {
    await newFileButton.click()
    const editor = await page
      .waitForSelector('.mu-editor, .editor-wrapper, .CodeMirror', { timeout: 10000 })
      .then(() => true)
      .catch(() => false)
    check('new document opens editor', editor)
  } else {
    // The app may auto-open with an untitled tab or keyboard shortcut works.
    await page.keyboard.press('Control+T')
    const editor = await page
      .waitForSelector('.mu-editor, .editor-wrapper, .CodeMirror', { timeout: 10000 })
      .then(() => true)
      .catch(() => false)
    check('Ctrl+T opens new tab', editor)
  }

  // 6. Type markdown into the editor.
  const typed = await page.evaluate(() => {
    const target = document.querySelector('.mu-editor [contenteditable], .mu-editor')
    if (target instanceof HTMLElement) {
      target.focus()
      return document.activeElement === target
    }
    return false
  })
  if (typed) {
    await page.keyboard.type('# Hello Web\n\nThe **MarkText** PWA build works.', { delay: 20 })
    await page.waitForTimeout(800)
    const html = await page.content()
    const headingRendered = html.includes('Hello Web') && (html.includes('<h1') || html.includes('mu-editor'))
    check('markdown typing works', headingRendered)
  } else {
    check('markdown typing works', false, 'no editable target found')
  }

  // 7. The hamburger/application menu opens (web menu shim).
  const menuButton = page.locator('.frameless-titlebar-menu').first()
  if (await menuButton.count()) {
    await menuButton.click()
    await page.waitForTimeout(400)
    const menuVisible = (await page.locator('.web-menu').count()) > 0
    check('application menu opens', menuVisible)
    if (menuVisible) {
      // Click File → New Tab to prove menu-driven commands work end to end.
      const tabsBefore = await page.locator('.tabs-container li').count()
      const firstTabId = await page.locator('.tabs-container li').first().getAttribute('data-id')
      await page.locator('.web-menu-item', { hasText: 'File' }).first().hover()
      await page.waitForTimeout(300)
      await page.locator('.web-submenu .web-menu-item', { hasText: 'New Tab' }).first().click()
      await page.waitForTimeout(600)
      // Regression (double command execution): one click must create exactly
      // one new tab — the pre-fix build registered the command-center ipc
      // listener twice, so a single click opened two documents.
      const tabsAfter = await page.locator('.tabs-container li').count()
      check('menu executes command', tabsAfter === tabsBefore + 1, `tabs ${tabsBefore} -> ${tabsAfter}`)
      // Regression (invisible tab bar): the tab strip is the only way to
      // switch documents on the web, so it must render with height.
      const tabBarBox = await page.locator('.editor-tabs').boundingBox()
      check('tab bar visible', (tabBarBox?.height ?? 0) > 0, `height=${tabBarBox?.height ?? 'none'}`)
      // Regression ("if create new tab, cannot change to old tab"): click the
      // original tab and verify it becomes the active one.
      if (firstTabId && tabsAfter === tabsBefore + 1) {
        const oldTab = page.locator(`.tabs-container li[data-id="${firstTabId}"]`)
        await oldTab.click()
        await page.waitForTimeout(800)
        const oldTabActive = await oldTab.evaluate((li) => li.classList.contains('active'))
        check('old tab becomes active after click', oldTabActive)
      }
    }
    await page.keyboard.press('Escape')
  } else {
    check('application menu opens', false, 'menu button not found')
  }

  // 8. Preferences open in their own window (desktop parity) and never
  // unmount the editor App. The old in-place route unmounted it, and the
  // app's onMounted re-registered all ipc/bus listeners on every return —
  // after one settings visit a single New Tab click created four tabs.
  await menuButton.click()
  await page.waitForTimeout(400)
  const popupPromise = page.waitForEvent('popup', { timeout: 10000 })
  await page.locator('.web-menu-item', { hasText: 'File' }).first().hover()
  await page.waitForTimeout(300)
  await page.locator('.web-submenu .web-menu-item', { hasText: 'Preferences' }).first().click()
  let settingsPage = null
  try {
    settingsPage = await popupPromise
  } catch {
    settingsPage = null
  }
  const settingsMounted = settingsPage
    ? await settingsPage
        .waitForSelector('.pref-container', { timeout: 20000 })
        .then(() => true)
        .catch(() => false)
    : false
  check('preferences window opens', settingsMounted, settingsPage ? `url=${settingsPage.url()}` : 'no popup')
  // The editor App must remain mounted in the original window.
  const editorStillMounted = (await page.locator('.editor-container').count()) > 0
  check('editor stays mounted while settings open', editorStillMounted)
  if (settingsPage) await settingsPage.close()
  await page.waitForTimeout(500)

  // 9. After a settings round-trip, menu commands must still execute exactly
  // once (regression: listener stacking made one click create 4+ tabs).
  await menuButton.click()
  await page.waitForTimeout(400)
  const tabsBeforeSettings = await page.locator('.tabs-container li').count()
  await page.locator('.web-menu-item', { hasText: 'File' }).first().hover()
  await page.waitForTimeout(300)
  await page.locator('.web-submenu .web-menu-item', { hasText: 'New Tab' }).first().click()
  await page.waitForTimeout(600)
  const tabsAfterSettings = await page.locator('.tabs-container li').count()
  check(
    'menu command executes once after settings round-trip',
    tabsAfterSettings === tabsBeforeSettings + 1,
    `tabs ${tabsBeforeSettings} -> ${tabsAfterSettings}`
  )
  await page.keyboard.press('Escape')
} finally {
  const fatal = errors.filter((e) =>
    !/favicon|sourcemap|Download the React DevTools|Autofocus|favicon\.svg/i.test(e)
  )
  check('no page errors', fatal.length === 0, fatal.slice(0, 5).join(' | ') || 'clean')
  await browser.close()
  server.close()
  const failed = Object.entries(results).filter(([, [ok]]) => !ok)
  console.log(`\n${Object.keys(results).length - failed.length}/${Object.keys(results).length} checks passed`)
  process.exit(failed.length > 0 ? 1 : 0)
}
