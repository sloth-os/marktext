// Regression test: long menus must be scrollable. The web menu closes on
// scroll events (so it detaches when the page underneath scrolls), but the
// window-level capture listener also saw the menu's OWN overflow scrolling —
// the first wheel tick over a long menu dismissed it. Also checks submenu
// viewport flipping near the bottom edge.
// Run: node test/repro-menu-scroll.mjs <dist>
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { chromium } from '@playwright/test'

const DIST = process.argv[2] || join(process.cwd(), '../../../dist')
const PORT = 4337
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm' }
const indexHtml = await readFile(join(DIST, 'index.html'), 'utf8')
const baseMatch = /(?:src|href)="\/([a-z0-9._-]+)\/(?:assets|registerSW\.js|manifest|sw\.js|icon|favicon)/i.exec(indexHtml)
const BASE = baseMatch ? `/${baseMatch[1]}` : ''
const server = createServer(async(req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    if (BASE && pathname === '/') { res.writeHead(302, { location: `${BASE}/` }); res.end(); return }
    if (BASE && pathname.startsWith(BASE)) pathname = pathname.slice(BASE.length) || '/'
    if (pathname.endsWith('/')) pathname += 'index.html'
    const file = normalize(join(DIST, pathname))
    if (!file.startsWith(DIST)) { res.writeHead(403).end('forbidden'); return }
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    try { const body = await readFile(join(DIST, 'index.html')); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(body) } catch { res.writeHead(404).end('not found') }
  }
})
await new Promise((r) => server.listen(PORT, r))

const resolveChromium = () => {
  if (process.env.CHROMIUM_EXECUTABLE) return process.env.CHROMIUM_EXECUTABLE
  try { const c = chromium.executablePath(); if (typeof c === 'string' && existsSync(c)) return c } catch {}
  const cache = join(process.env.HOME ?? '', '.cache', 'ms-playwright')
  if (!existsSync(cache)) return null
  for (const d of readdirSync(cache).filter((n) => /^chromium(-\d+)?$/.test(n)).sort().reverse())
    for (const p of readdirSync(join(cache, d))) { const c = join(cache, d, p, 'chrome'); if (existsSync(c)) return c }
  return null
}
const browser = await chromium.launch({ headless: true, ...(resolveChromium() ? { executablePath: resolveChromium() } : {}) })
// Short viewport so the Paragraph submenu (15+ items) exceeds its 60vh cap
// and becomes genuinely scrollable.
const context = await browser.newContext({ viewport: { width: 900, height: 420 } })
const page = await context.newPage()

const results = {}
const check = (name, ok, detail = '') => {
  results[name] = [ok, detail]
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

try {
  await page.goto(`http://localhost:${PORT}${BASE || ''}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.title-bar, .recent-files-projects, .editor-placeholder', { timeout: 45000 })
  const newFileButton = page.getByRole('button').filter({ hasText: /new file|新建/i }).first()
  if (await newFileButton.count()) await newFileButton.click()
  await page.waitForSelector('.mu-editor, .editor-wrapper', { timeout: 15000 })
  await page.waitForTimeout(1200)

  const openParagraphSubmenu = async() => {
    await page.locator('.frameless-titlebar-menu').first().click()
    await page.waitForTimeout(350)
    await page.locator('.web-menu-item', { hasText: 'Paragraph' }).first().hover()
    await page.waitForTimeout(350)
    return page.locator('.web-submenu').last()
  }

  // 1. The submenu is overflowing and scrollable.
  const sub = await openParagraphSubmenu()
  const overflow = await sub.evaluate((el) => ({ scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }))
  check('long submenu overflows its max-height', overflow.scrollHeight > overflow.clientHeight + 20,
    `scrollHeight=${overflow.scrollHeight} clientHeight=${overflow.clientHeight}`)

  // 2. Wheel-scrolling over the menu scrolls it WITHOUT closing it.
  const subBox = await sub.boundingBox()
  await page.mouse.move(subBox.x + subBox.width / 2, subBox.y + subBox.height / 2)
  await page.mouse.wheel(0, 300)
  await page.waitForTimeout(400)
  const menuStillOpen = (await page.locator('.web-menu').count()) > 0 && (await page.locator('.web-submenu').count()) > 0
  const scrollTop = await sub.evaluate((el) => el.scrollTop)
  check('wheel scroll keeps the menu open', menuStillOpen, `menu open=${menuStillOpen}`)
  check('wheel scroll scrolls the submenu', scrollTop > 0, `scrollTop=${scrollTop}`)

  // 3. A bottom item remains clickable after scrolling down (Task List is the
  //    last entry in the Paragraph menu).
  const taskList = sub.locator('.web-menu-item', { hasText: 'Task List' }).first()
  const visible = await taskList.isVisible().catch(() => false)
  check('scrolled-to bottom item is visible', visible)
  if (visible) {
    await taskList.click()
    await page.waitForTimeout(700)
    const menuClosed = (await page.locator('.web-menu').count()) === 0
    check('clicking a scrolled item executes and closes the menu', menuClosed)
  }

  // 4. A submenu opened near the bottom of the viewport flips upward instead
  //    of overflowing off-screen, and page scroll still closes an open menu.
  await openParagraphSubmenu()
  const subBox2 = await page.locator('.web-submenu').last().boundingBox()
  check('submenu stays inside the viewport',
    subBox2.y >= 0 && subBox2.y + subBox2.height <= 421,
    `top=${subBox2.y} bottom=${subBox2.y + subBox2.height} viewport=420`)
  // The editor page may not scroll; dispatch a scroll event from an element
  // outside the menu — the shim listens on window with capture, so any
  // non-menu scroll bubbles there.
  await page.evaluate(() => {
    const el = document.querySelector('.editor-container') ?? document.scrollingElement
    el.dispatchEvent(new Event('scroll', { bubbles: true }))
  })
  await page.waitForTimeout(400)
  const closedOnOutsideScroll = (await page.locator('.web-menu').count()) === 0
  check('outside scroll still closes the menu', closedOnOutsideScroll)
} catch (error) {
  check('test completed without throwing', false, error?.message ?? String(error))
} finally {
  const failed = Object.entries(results).filter(([, [ok]]) => !ok)
  console.log(`\n${Object.keys(results).length - failed.length}/${Object.keys(results).length} checks passed`)
  await browser.close()
  server.close()
  process.exit(failed.length > 0 ? 1 : 0)
}
