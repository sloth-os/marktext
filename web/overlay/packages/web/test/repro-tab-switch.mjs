// Focused regression test for: "if create new tab, cannot change to old tab".
// Serves dist/ (or targets the live site), creates a second tab via the app
// menu, then clicks the old tab and checks whether currentFile switched.
// Complements test/smoke.mjs, which carries the compact version of the same
// check; this script adds content and reload-persistence assertions.

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { chromium } from '@playwright/test'

const MODE = process.argv[2] || 'local' // local | live
const DIST = process.argv[3] || join(process.cwd(), '../../../dist')
const PORT = 4318
const LIVE = 'https://sloth-os.github.io/marktext/'

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

let BASE = ''
let server = null
if (MODE === 'local') {
  const indexHtml = await readFile(join(DIST, 'index.html'), 'utf8')
  const baseMatch = /(?:src|href)="\u002f([a-z0-9._-]+)\u002f(?:assets|registerSW\.js|manifest|sw\.js|icon|favicon)/i.exec(indexHtml)
  BASE = baseMatch ? `/${baseMatch[1]}` : ''
  console.log(`serving base: '${BASE || '/'}'`)
  server = createServer(async(req, res) => {
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
      await stat(file)
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
}

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
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
const page = await context.newPage()

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
  const url = MODE === 'live' ? LIVE : `http://localhost:${PORT}${BASE || ''}/`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.title-bar, .recent-files-projects, .editor-placeholder', { timeout: 45000 })
  await page.waitForTimeout(2500)
  console.log(`mode=${MODE} url=${page.url()}`)

  // Ensure exactly one starting tab: create a new untitled doc and type in it.
  const newFileButton = page.getByRole('button').filter({ hasText: /new file|新建/i }).first()
  if (await newFileButton.count()) await newFileButton.click()
  await page.waitForSelector('.mu-editor, .editor-wrapper', { timeout: 15000 })
  await page.waitForTimeout(1200)

  const ids1 = await page.evaluate(() =>
    [...document.querySelectorAll('.tabs-container li')].map((li) => ({
      id: li.dataset.id, active: li.classList.contains('active'), label: li.textContent.trim()
    }))
  )
  check('initial: exactly one tab', ids1.length === 1, JSON.stringify(ids1))
  const oldTabId = ids1[0]?.id

  // The tab strip must be visible: it is the only way to switch documents in
  // the web build (the pre-fix default hid it, which is why the old tab could
  // not be clicked back).
  const tabBarBox = await page.locator('.editor-tabs').boundingBox()
  check('tab bar visible', (tabBarBox?.height ?? 0) > 0, `height=${tabBarBox?.height ?? 'none'}`)

  // Type something in the first tab.
  await page.evaluate(() => {
    const target = document.querySelector('.mu-editor [contenteditable], .mu-editor')
    if (target instanceof HTMLElement) target.focus()
  })
  await page.keyboard.type('first tab content', { delay: 15 })
  await page.waitForTimeout(800)

  // Create a second tab (the app menu File → New Tab, same as smoke test).
  const menuButton = page.locator('.frameless-titlebar-menu').first()
  await menuButton.click()
  await page.waitForTimeout(400)
  await page.locator('.web-menu-item', { hasText: 'File' }).first().hover()
  await page.waitForTimeout(300)
  await page.locator('.web-submenu .web-menu-item', { hasText: 'New Tab' }).first().click()
  await page.waitForTimeout(1200)

  const ids2 = await page.evaluate(() =>
    [...document.querySelectorAll('.tabs-container li')].map((li) => ({
      id: li.dataset.id, active: li.classList.contains('active'), label: li.textContent.trim()
    }))
  )
  check('after new tab: two tabs exist', ids2.length === 2, JSON.stringify(ids2))
  const newTabId = ids2.find((t) => t.id !== oldTabId)?.id
  check('new tab is active', ids2.some((t) => t.id === newTabId && t.active))

  // Type in the second tab too (a content edit often surfaces the bug).
  await page.evaluate(() => {
    const target = document.querySelector('.mu-editor [contenteditable], .mu-editor')
    if (target instanceof HTMLElement) target.focus()
  })
  await page.keyboard.type('second tab content', { delay: 15 })
  await page.waitForTimeout(800)

  // THE REPRO: click the old tab and see if the app switches back.
  const oldTab = page.locator(`.tabs-container li[data-id="${oldTabId}"]`)
  await oldTab.click()
  await page.waitForTimeout(1500)

  const stateAfter = await page.evaluate(() =>
    [...document.querySelectorAll('.tabs-container li')].map((li) => ({
      id: li.dataset.id, active: li.classList.contains('active')
    }))
  )
  const switched = stateAfter.find((t) => t.id === oldTabId)?.active === true
  check('old tab becomes active after click', switched, JSON.stringify(stateAfter))

  // Also capture whether the editor content matches the old tab (via DOM).
  if (switched) {
    const body = await page.evaluate(() => document.querySelector('.mu-editor')?.textContent ?? '')
    check('editor shows old tab content', body.includes('first tab content'), body.slice(0, 80))
  }

  // Try switching again the other way for completeness.
  await page.locator(`.tabs-container li[data-id="${newTabId}"]`).click()
  await page.waitForTimeout(1500)
  const stateAfter2 = await page.evaluate(() =>
    [...document.querySelectorAll('.tabs-container li')].map((li) => ({
      id: li.dataset.id, active: li.classList.contains('active')
    }))
  )
  check('new tab re-activates on click', stateAfter2.find((t) => t.id === newTabId)?.active === true, JSON.stringify(stateAfter2))

  // Reload persistence check: reload and see what is restored.
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.tabs-container li', { timeout: 30000 })
  await page.waitForTimeout(2500)
  const restored = await page.evaluate(() =>
    [...document.querySelectorAll('.tabs-container li')].map((li) => ({
      id: li.dataset.id, active: li.classList.contains('active'), label: li.textContent.trim()
    }))
  )
  check('reload restores both tabs', restored.length === 2, JSON.stringify(restored))

  const fatal = errors.filter((e) => !/favicon|sourcemap|DevTools|Autofocus/i.test(e))
  check('no page errors', fatal.length === 0, fatal.slice(0, 8).join(' | ') || 'clean')
} finally {
  await browser.close().catch(() => {})
  await server?.close()
  const failed = Object.entries(results).filter(([, [ok]]) => !ok)
  console.log(`\n${Object.keys(results).length - failed.length}/${Object.keys(results).length} checks passed`)
  process.exit(failed.length > 0 ? 1 : 0)
}
