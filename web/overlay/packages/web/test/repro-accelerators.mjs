// Regression test for keyboard accelerators (Ctrl+A, Ctrl+C/V, Ctrl+1, Ctrl+K,
// Ctrl+Shift+P, ...). Desktop routes these through the MAIN-process command
// manager (menu actions that SEND ipc events); ids not registered in the
// renderer command center used to throw "command missing" on web and the
// shortcut silently did nothing. Clipboard keys were even preventDefaulted,
// blocking the browser's native copy/paste events muya consumes.
//
// Run: node test/repro-accelerators.mjs <dist>
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { chromium } from '@playwright/test'

const DIST = process.argv[2] || join(process.cwd(), '../../../dist')
const PORT = 4331
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
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } })
await context.grantPermissions(['clipboard-read', 'clipboard-write'])
const page = await context.newPage()

const results = {}
const check = (name, ok, detail = '') => {
  results[name] = [ok, detail]
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// Any "command missing" error means an accelerator was routed to the command
// center when desktop would have handled it in the main process.
const missingCommandErrors = []
page.on('console', (m) => { const t = m.text(); if (/because it's missing|No command found/i.test(t)) missingCommandErrors.push(t.slice(0, 120)) })
page.on('pageerror', (e) => { if (/because it's missing|No command found/i.test(e.message)) missingCommandErrors.push(e.message.slice(0, 120)) })

try {
  await page.goto(`http://localhost:${PORT}${BASE || ''}/`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.title-bar, .recent-files-projects, .editor-placeholder', { timeout: 45000 })
  const newFileButton = page.getByRole('button').filter({ hasText: /new file|新建/i }).first()
  if (await newFileButton.count()) await newFileButton.click()
  await page.waitForSelector('.mu-editor, .editor-wrapper', { timeout: 15000 })
  await page.waitForTimeout(1500)

  const focusEditor = async() => {
    await page.evaluate(() => {
      const t = document.querySelector('.mu-editor [contenteditable], .mu-editor')
      t instanceof HTMLElement && t.focus()
    })
  }
  await focusEditor()
  await page.keyboard.type('Alpha clipboard probe', { delay: 15 })
  await page.keyboard.press('Enter')
  await page.keyboard.type('Beta second line', { delay: 15 })
  await page.waitForTimeout(600)

  // --- Ctrl+A: select-all (desktop: mt::editor-edit-action 'selectAll') -------
  // Muya semantics (desktop parity): first Ctrl+A selects the current block,
  // a second press selects the whole document.
  await focusEditor()
  await page.keyboard.press('Control+A')
  await page.waitForTimeout(400)
  const blockSelected = await page.evaluate(() => window.getSelection()?.toString().trim().length ?? 0)
  await page.keyboard.press('Control+A')
  await page.waitForTimeout(400)
  const docSelected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  check('Ctrl+A selects current block then whole document',
    blockSelected > 0 && docSelected.includes('Alpha') && docSelected.includes('Beta'),
    `block=${blockSelected} chars, doc includes both lines=${docSelected.includes('Alpha') && docSelected.includes('Beta')}`)

  // --- Ctrl+C / Ctrl+V: native clipboard round-trip --------------------------
  // The shim must NOT preventDefault these: the browser fires real copy/paste
  // events which muya's document-level handlers consume (desktop parity with
  // the native cut/copy/paste menu roles).
  await page.keyboard.press('Control+C')
  await page.waitForTimeout(300)
  const clipText = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
  check('Ctrl+C writes to system clipboard', clipText.includes('Alpha') && clipText.includes('Beta'), `clipboard=${JSON.stringify(clipText.slice(0, 60))}`)

  // Collapse the selection to the document end so the paste appends instead
  // of replacing the selection (a paste over an identical selection would be
  // a no-op content-wise and could not be detected).
  await page.evaluate(() => {
    const sel = window.getSelection()
    sel.collapseToEnd()
  })
  await page.waitForTimeout(200)
  await page.keyboard.press('Control+V')
  await page.waitForTimeout(600)
  const bodyText = await page.evaluate(() => document.querySelector('.mu-editor')?.textContent ?? '')
  const occurrences = bodyText.split('Alpha clipboard probe').length - 1
  check('Ctrl+V pastes clipboard back into editor', occurrences >= 2, `occurrences=${occurrences}`)

  // --- Ctrl+Shift+P: command palette (desktop: mt::show-command-palette) -----
  await focusEditor()
  await page.keyboard.press('Control+Shift+P')
  await page.waitForTimeout(700)
  const paletteVisible = await page.locator('.command-palette input.search').first().isVisible().catch(() => false)
  check('Ctrl+Shift+P opens command palette', paletteVisible)
  if (paletteVisible) {
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
  }

  // --- Ctrl+K: toggle outline (desktop: mt::toggle-view-layout-entry showToc)-
  const tocSel = '.document-outline.is-visible'
  await focusEditor()
  const tocBefore = await page.locator(tocSel).count()
  await page.keyboard.press('Control+K')
  await page.waitForTimeout(600)
  const tocAfter = await page.locator(tocSel).count()
  check('Ctrl+K toggles the outline', tocBefore !== tocAfter, `visible before/after: ${tocBefore}/${tocAfter}`)
  await page.keyboard.press('Control+K') // restore
  await page.waitForTimeout(400)

  // --- Ctrl+1 / Ctrl+2: tab switching (desktop: mt::switch-tab-by-index) -----
  const menuButton = page.locator('.frameless-titlebar-menu').first()
  await menuButton.click()
  await page.waitForTimeout(350)
  await page.locator('.web-menu-item', { hasText: 'File' }).first().hover()
  await page.waitForTimeout(250)
  await page.locator('.web-submenu .web-menu-item', { hasText: 'New Tab' }).first().click()
  await page.waitForTimeout(800)
  const firstTabId = await page.locator('.tabs-container li').first().getAttribute('data-id')
  await focusEditor()
  await page.keyboard.press('Control+2')
  await page.waitForTimeout(500)
  await page.keyboard.press('Control+1')
  await page.waitForTimeout(600)
  const activeTabId = await page.locator('.tabs-container li.active').first().getAttribute('data-id').catch(() => null)
  check('Ctrl+1 switches back to the first tab', activeTabId === firstTabId, `first=${firstTabId} active=${activeTabId}`)

  // --- Ctrl+F: find (registered renderer command; must keep working) ---------
  await page.keyboard.press('Control+F')
  await page.waitForTimeout(600)
  const findVisible = await page.locator('.search-wrapper input, .input-wrapper input').first().isVisible().catch(() => false)
  check('Ctrl+F opens find', findVisible)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // --- Menu Edit > Copy / Paste / Select All ---------------------------------
  // Menu clicks have no native keyboard event, so the shim must synthesize the
  // clipboard action (execCommand / ClipboardEvent) instead of returning 'native'.
  const openEditMenu = async() => {
    await page.locator('.frameless-titlebar-menu').first().click()
    await page.waitForTimeout(350)
    await page.locator('.web-menu-item', { hasText: 'Edit' }).first().hover()
    await page.waitForTimeout(300)
  }
  await focusEditor()
  await openEditMenu()
  await page.locator('.web-submenu .web-menu-item', { hasText: 'Select All' }).first().click()
  await page.waitForTimeout(400)
  const menuSelected = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  check('Edit > Select All selects content', menuSelected.includes('Alpha'), `selected=${menuSelected.length} chars`)

  await openEditMenu()
  await page.locator('.web-submenu .web-menu-item', { hasText: /^Copy$/ }).first().click()
  await page.waitForTimeout(400)
  const menuClip = await page.evaluate(() => navigator.clipboard.readText().catch(() => ''))
  check('Edit > Copy writes to system clipboard', menuClip.includes('Alpha'), `clipboard=${JSON.stringify(menuClip.slice(0, 50))}`)

  await page.evaluate(() => window.getSelection()?.collapseToEnd())
  await page.waitForTimeout(200)
  await openEditMenu()
  await page.locator('.web-submenu .web-menu-item', { hasText: 'Paste' }).first().click()
  await page.waitForTimeout(700)
  const menuBody = await page.evaluate(() => document.querySelector('.mu-editor')?.textContent ?? '')
  const menuOccurrences = menuBody.split('Alpha clipboard probe').length - 1
  check('Edit > Paste inserts clipboard content', menuOccurrences >= 3, `occurrences=${menuOccurrences}`)

  check('no "command missing" errors while pressing accelerators', missingCommandErrors.length === 0, missingCommandErrors.slice(0, 3).join(' | ') || 'clean')
} catch (error) {
  check('test completed without throwing', false, error?.message ?? String(error))
} finally {
  const failed = Object.entries(results).filter(([, [ok]]) => !ok)
  console.log(`\n${Object.keys(results).length - failed.length}/${Object.keys(results).length} checks passed`)
  await browser.close()
  server.close()
  process.exit(failed.length > 0 ? 1 : 0)
}
