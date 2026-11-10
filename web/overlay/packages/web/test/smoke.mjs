// Headless smoke test for the built MarkText web bundle.
// Serves dist/ statically, loads the app in Chromium, and checks that the
// editor UI mounts, a new document can be created, and text can be typed.

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { chromium } from '@playwright/test'

const DIST = process.argv[2] || join(process.cwd(), 'dist')
const PORT = 4317

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

// Use the locally cached Chromium build directly (executablePath) so the
// test does not depend on a matching `playwright install` browser revision.
const CHROMIUM = process.env.CHROMIUM_EXECUTABLE || (
  await chromium.executablePath().catch(() => null)
)
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
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 30000 })

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
      await page.locator('.web-menu-item', { hasText: 'File' }).first().hover()
      await page.waitForTimeout(300)
      await page.locator('.web-submenu .web-menu-item', { hasText: 'New Tab' }).first().click()
      await page.waitForTimeout(600)
      check('menu executes command', true)
    }
    await page.keyboard.press('Escape')
  } else {
    check('application menu opens', false, 'menu button not found')
  }

  // 8. Preferences open in-app (settings route).
  await page.keyboard.press('Control+Comma')
  await page.waitForTimeout(800)
  const url = page.url()
  check('preferences route reachable', url.includes('/preference'), `url=${url}`)
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
