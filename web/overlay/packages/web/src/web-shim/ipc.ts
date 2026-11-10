// Web implementation of the preload bridge: `window.electron`, `window.path`,
// `window.fileUtils`, `window.i18nUtils`, `window.ripgrep`, `window.uploader`,
// `window.fonts`, `window.diagram`, `window.commandExists`, `window.process`.
// The renderer already routes every OS capability through these globals, so
// providing browser equivalents lets the unmodified renderer code run.

import * as store from './opfs'
import { webStateHost, setCallbacks } from './stateHost'
import type { ManagedDocumentPayload, WindowInitialization } from './types'

type Listener = (event: unknown, ...args: unknown[]) => void

/** Registry of main→renderer event listeners, mirroring ipcRenderer.on. */
const listeners = new Map<string, Set<Listener>>()

export const emitToRenderer = (channel: string, ...args: unknown[]): void => {
  const set = listeners.get(channel)
  if (!set) return
  for (const listener of [...set]) {
    try {
      listener({}, ...args)
    } catch (error) {
      console.error(`[web-shim] listener for ${channel} failed`, error)
    }
  }
}

const on = (channel: string, listener: Listener): (() => void) => {
  let set = listeners.get(channel)
  if (!set) {
    set = new Set()
    listeners.set(channel, set)
  }
  set.add(listener)
  return () => {
    set?.delete(listener)
  }
}

const once = (channel: string, listener: Listener): (() => void) => {
  const off = on(channel, (event, ...args) => {
    off()
    listener(event, ...args)
  })
  return off
}

const removeAllListeners = (channel: string): void => {
  listeners.delete(channel)
}

// ---------------------------------------------------------------------------
// Keybindings: the web build ships the upstream Linux/Windows/Darwin default
// maps and lets the browser match them via the command center.
// ---------------------------------------------------------------------------

import keybindingsDarwin from '../../../desktop/src/main/keyboard/keybindingsDarwin'
import keybindingsLinux from '../../../desktop/src/main/keyboard/keybindingsLinux'
import keybindingsWindows from '../../../desktop/src/main/keyboard/keybindingsWindows'

const platform = navigator.platform.includes('Mac') || navigator.userAgent.includes('Mac')
  ? 'darwin'
  : 'linux'

const defaultKeybindings: Map<string, string> = platform === 'darwin' ? keybindingsDarwin : keybindingsLinux

const userKeybindings: Map<string, string> = store.readJson<Map<string, string>>('user-keybindings', new Map())

// Accelerator syntax → Web KeyboardEvent normalization (Ctrl/Cmd, Alt/Opt).
const acceleratorToBrowser = (accelerator: string): string => {
  if (!accelerator) return ''
  const isMac = platform === 'darwin'
  const parts = accelerator.split('+').map(part => part.trim())
  const modifiers = parts.slice(0, -1)
  const key = parts[parts.length - 1]
  const ctrl = modifiers.includes('Ctrl') || (isMac && modifiers.includes('Cmd') && false)
  const meta = isMac ? modifiers.includes('Cmd') || modifiers.includes('Command') : modifiers.includes('Meta')
  const alt = modifiers.includes('Alt') || modifiers.includes('Option')
  const shift = modifiers.includes('Shift')
  const out: string[] = []
  if (ctrl) out.push('Control')
  if (alt) out.push('Alt')
  if (shift) out.push('Shift')
  if (meta) out.push('Meta')
  out.push(key.length === 1 ? key.toLowerCase() : key)
  return out.join('+')
}

const activeKeybindings = (): Record<string, string> => {
  const merged: Record<string, string> = {}
  for (const [id, accelerator] of defaultKeybindings) merged[id] = accelerator
  for (const [id, accelerator] of userKeybindings) merged[id] = accelerator
  return merged
}

/** Attaches the global keyboard shortcut handler (replaces localShortcut). */
export const attachGlobalShortcuts = (executeCommand: (id: string) => void): void => {
  if (attachGlobalShortcuts.attached) return
  attachGlobalShortcuts.attached = true
  window.addEventListener('keydown', (event: KeyboardEvent) => {
    // The desktop build routes every accelerator through the application menu
    // (Electron localShortcut intercepts before-input-event), even while the
    // editor has focus — the renderer's command pipeline then performs the
    // edit actions itself (edit.copy/paste/undo...). Mirror that: all
    // accelerator matches are intercepted regardless of focus. Plain typing
    // is unaffected because every accelerator carries a modifier key.
    const key = [
      event.ctrlKey ? 'Control' : '',
      event.altKey ? 'Alt' : '',
      event.shiftKey ? 'Shift' : '',
      event.metaKey ? 'Meta' : '',
      event.key.length === 1 ? event.key.toLowerCase() : event.key
    ].filter(Boolean).join('+')

    for (const [id, accelerator] of Object.entries(activeKeybindings())) {
      if (acceleratorToBrowser(accelerator) === key) {
        event.preventDefault()
        executeCommand(id)
        return
      }
    }
  }, { capture: true })
}
attachGlobalShortcuts.attached = false

// ---------------------------------------------------------------------------
// Save dialogs: use the File System Access API when available, fall back to
// a download.
// ---------------------------------------------------------------------------

const hasFsAccessApi = (): boolean => typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'

const chooseSavePathViaPicker = async(suggestedName: string): Promise<string | null> => {
  if (!hasFsAccessApi()) return null
  try {
    const picker = (window as unknown as {
      showSaveFilePicker: (options: unknown) => Promise<FileSystemFileHandle>
    })
    const handle = await picker.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }]
    })
    // Remember the handle so a subsequent save writes back to the real file.
    const { rememberHandleForNextSave } = await import('./fileHandling')
    rememberHandleForNextSave(handle)
    return (handle as unknown as { name?: string }).name || suggestedName
  } catch {
    return null
  }
}

// Wire state host callbacks to renderer events.
setCallbacks({
  documentOpened: (payload: ManagedDocumentPayload) => emitToRenderer('mt::state::document-opened', payload),
  switchTab: (pathname, options) => emitToRenderer('mt::switch-tab-by-file_path', pathname, options),
  documentsEnded: ids => emitToRenderer('mt::state::documents-ended', ids),
  documentSaved: result => emitToRenderer('mt::state::document-saved', result),
  saveFailure: (id, message) => emitToRenderer('mt::tab-save-failure', id, message),
  chooseSavePath: async suggestedName => {
    const picked = await chooseSavePathViaPicker(suggestedName)
    return picked
  },
  onSaved: (documentId, _pathname, markdown, format) => {
    void (async() => {
      const { writeThroughHandle } = await import('./fileHandling')
      await writeThroughHandle(documentId, markdown, format)
    })()
  },
  contextChanged: (initialization: WindowInitialization) =>
    emitToRenderer('mt::state::context-changed', initialization),
  userPreference: preferences => emitToRenderer('mt::user-preference', preferences)
})

// ---------------------------------------------------------------------------
// fileUtils implementation over OPFS.
// ---------------------------------------------------------------------------

const MARKDOWN_EXTENSIONS = [
  'markdown', 'mdown', 'mkdn', 'md', 'mkd', 'mdwn', 'mdtxt', 'mdtext', 'mdx', 'text', 'txt'
]

const hasMarkdownExtension = (filename: string): boolean =>
  MARKDOWN_EXTENSIONS.some(ext => filename.toLowerCase().endsWith(`.${ext}`))

const isChildOfDirectory = (dir: string, child: string): boolean => {
  if (!dir || !child) return false
  const relative = posixPath.relative(dir, child)
  return !!relative && relative !== '..' && !relative.startsWith('../') && !posixPath.isAbsolute(relative)
}

const isSamePathSync = (pathA: string, pathB: string): boolean => {
  if (!pathA || !pathB) return false
  const a = posixPath.normalize(pathA)
  const b = posixPath.normalize(pathB)
  return a === b || a.toLowerCase() === b.toLowerCase()
}

const fileUtils = {
  isFile: async(p: string) => (await store.statEntry(p))?.isDirectory === false,
  isDirectory: (p: string) => store.isDirectory(p),
  emptyDir: async(p: string) => {
    for (const name of await store.listDirectory(p)) await store.removeFile(`${p}/${name}`)
  },
  copy: (src: string, dest: string) => store.copyFile(src, dest),
  copyWithContentHash: async(src: string, outputDir: string) => {
    await store.ensureDirectory(outputDir)
    const bytes = await store.readFile(src)
    const hash = await store.sha256Hex(bytes)
    const ext = posixPath.extname(src)
    const dest = `${outputDir}/${hash.slice(0, 16)}${ext}`
    await store.writeFile(dest, bytes)
    return dest
  },
  ensureDir: (p: string) => store.ensureDirectory(p),
  outputFile: (p: string, data: string | Uint8Array) => store.writeFile(p, data),
  move: (src: string, dest: string) => store.moveEntry(src, dest),
  stat: async(p: string) => {
    const entry = await store.statEntry(p)
    if (!entry) throw new Error(`ENOENT: ${p}`)
    return {
      isFile: () => !entry.isDirectory,
      isDirectory: () => entry.isDirectory,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      mtime: new Date(entry.mtimeMs)
    }
  },
  writeFile: (p: string, data: string | Uint8Array) => store.writeFile(p, data),
  readFile: async(p: string) => store.readFile(p),
  pathExists: (p: string) => store.fileExists(p),
  unlink: (p: string) => store.removeFile(p),
  readdir: (p: string) => store.listDirectory(p),
  isExecutable: async() => false,
  isChildOfDirectory,
  hasMarkdownExtension,
  isSamePathSync,
  isImageFile: async(p: string) =>
    /\.(jpeg|jpg|png|gif|svg|webp)$/i.test(p) && (await store.fileExists(p)),
  MARKDOWN_INCLUSIONS: MARKDOWN_EXTENSIONS.map(ext => `*.${ext}`)
}

// ---------------------------------------------------------------------------
// Minimal POSIX path implementation for `window.path` (the virtual tree is
// always `/`-rooted).
// ---------------------------------------------------------------------------

const normalizePosix = (pathname: string): string => {
  const absolute = pathname.startsWith('/')
  const out: string[] = []
  for (const part of pathname.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(part)
  }
  return (absolute ? '/' : '') + out.join('/')
}

const posixPath = {
  basename(pathname: string, ext?: string): string {
    const base = normalizePosix(pathname).split('/').pop() || ''
    return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base
  },
  dirname(pathname: string): string {
    const normalized = normalizePosix(pathname)
    const idx = normalized.lastIndexOf('/')
    if (idx <= 0) return idx === 0 ? '/' : '.'
    return normalized.slice(0, idx)
  },
  extname(pathname: string): string {
    const base = posixPath.basename(pathname)
    const idx = base.lastIndexOf('.')
    return idx > 0 ? base.slice(idx) : ''
  },
  join(...parts: string[]): string {
    return normalizePosix(parts.join('/'))
  },
  resolve(...parts: string[]): string {
    const joined = parts.reduce((acc, part) => (part.startsWith('/') ? part : `${acc}/${part}`), '')
    return normalizePosix(joined || '/')
  },
  relative(from: string, to: string): string {
    const a = normalizePosix(from).split('/').filter(Boolean)
    const b = normalizePosix(to).split('/').filter(Boolean)
    let i = 0
    while (i < a.length && i < b.length && a[i] === b[i]) i++
    const up = a.slice(i).map(() => '..')
    return [...up, ...b.slice(i)].join('/') || ''
  },
  isAbsolute(pathname: string): boolean {
    return pathname.startsWith('/')
  },
  normalize: normalizePosix,
  parse(pathname: string) {
    const normalized = normalizePosix(pathname)
    const dir = posixPath.dirname(normalized)
    const base = posixPath.basename(normalized)
    const ext = posixPath.extname(base)
    return { root: '/', dir, base, ext, name: base.slice(0, base.length - ext.length) }
  },
  format(pathObject: { root?: string; dir?: string; base?: string; ext?: string; name?: string }): string {
    const dir = pathObject.dir || ''
    const base = pathObject.base || `${pathObject.name || ''}${pathObject.ext || ''}`
    return normalizePosix(dir ? `${dir}/${base}` : base)
  },
  sep: '/',
  delimiter: ':'
}

// ---------------------------------------------------------------------------
// i18n: locale JSONs are bundled at build time (import.meta.glob).
// ---------------------------------------------------------------------------

const localeModules = import.meta.glob<{ default: Record<string, unknown> }>(
  '../../../desktop/static/locales/*.json'
)


const loadedLocales = new Map<string, Record<string, unknown>>()

const i18nUtils = {
  async loadTranslations(language: string): Promise<Record<string, unknown>> {
    const cached = loadedLocales.get(language)
    if (cached) return cached
    const loader = localeModules[`../../../desktop/static/locales/${language}.json`]
    if (!loader) return {}
    const translations = (await loader()).default
    loadedLocales.set(language, translations)
    return translations
  }
}

// ---------------------------------------------------------------------------
// Ripgrep replacement: an in-browser text/file search over the OPFS tree.
// The renderer wrapper (node/ripgrepSearcher.ts) generates a `searchId`,
// passes it in `start({searchId, mode, directories, pattern, options})` and
// matches envelopes `{searchId, payload?, num?, error?}` on the event
// channels. Quick Open uses mode 'files'; sidebar search uses 'text'.
// ---------------------------------------------------------------------------

interface RgStartRequest {
  searchId: string
  mode: 'text' | 'files'
  directories: string[]
  pattern: string
  options?: {
    isRegexp?: boolean
    isCaseSensitive?: boolean
    isWholeWord?: boolean
    inclusions?: string[]
    exclusions?: string[]
    [key: string]: unknown
  }
}

const cancelledSearches = new Set<string>()

/** Matches a glob-ish inclusion (`*.md`) or exclusion against a file name. */
const matchesInclusion = (name: string, patterns: string[] | undefined): boolean => {
  if (!patterns || patterns.length === 0) return true
  for (const pattern of patterns) {
    const base = pattern.replace(/\*\*\//g, '').replace(/^\*\*/, '')
    const ext = base.slice(base.lastIndexOf('.'))
    if (base.startsWith('*') && ext) {
      if (name.toLowerCase().endsWith(ext.toLowerCase())) return true
    } else if (name === base || name.endsWith(`/${base}`)) {
      return true
    }
  }
  return false
}

const runSearch = async(request: RgStartRequest): Promise<void> => {
  const { searchId, mode, directories, pattern, options = {} } = request
  const isCancelled = (): boolean => cancelledSearches.has(searchId)
  const envelope = (payload: object): { searchId: string } & Record<string, unknown> => ({
    searchId,
    ...payload
  })

  const isCaseSensitive = options.isCaseSensitive === true
  let matcher: RegExp | null = null
  if (pattern) {
    if (options.isRegexp) {
      try {
        matcher = new RegExp(pattern, isCaseSensitive ? 'g' : 'gi')
      } catch {
        matcher = null
      }
    }
    if (!matcher && options.isWholeWord) {
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      matcher = new RegExp(`\\b${escaped}\\b`, isCaseSensitive ? 'g' : 'gi')
    }
  }

  const containsPattern = (line: string): boolean => {
    if (!pattern) return true
    if (matcher) {
      matcher.lastIndex = 0
      return matcher.test(line)
    }
    return isCaseSensitive
      ? line.includes(pattern)
      : line.toLowerCase().includes(pattern.toLowerCase())
  }

  let searched = 0
  const walk = async(dir: string): Promise<void> => {
    if (isCancelled()) return
    let names: string[]
    try {
      names = await store.listDirectory(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (isCancelled()) return
      const fullPath = posixPath.join(dir, name)
      const entry = await store.statEntry(fullPath)
      if (!entry) continue
      if (entry.isDirectory) {
        await walk(fullPath)
        continue
      }
      searched++
      emitToRenderer('mt::rg::progress', envelope({ num: searched }))

      if (mode === 'files') {
        // Quick Open: payload is the plain path string; inclusion globs
        // decide which files participate.
        if (matchesInclusion(name, options.inclusions) && !matchesInclusion(name, options.exclusions)) {
          if (!pattern || name.toLowerCase().includes(pattern.toLowerCase())) {
            emitToRenderer('mt::rg::match', envelope({ payload: fullPath }))
          }
        }
        continue
      }

      // Text search: aggregate matches per file, one match event per file.
      if (!matchesInclusion(name, options.inclusions) || matchesInclusion(name, options.exclusions)) {
        continue
      }
      if (!hasMarkdownExtension(name) && !/\.txt$/i.test(name)) continue
      try {
        const text = await store.readTextFile(fullPath)
        const lines = text.split('\n')
        const matches: Array<{
          matchText: string
          lineText: string
          range: [[number, number], [number, number]]
          leadingContextLines: string[]
          trailingContextLines: string[]
        }> = []
        for (let i = 0; i < lines.length; i++) {
          if (!containsPattern(lines[i])) continue
          // Compute the match range as [line, column] pairs (0-based line).
          let start = 0
          let end = lines[i].length
          if (pattern) {
            const probe = isCaseSensitive ? lines[i] : lines[i].toLowerCase()
            const needle = isCaseSensitive ? pattern : pattern.toLowerCase()
            const idx = matcher
              ? (matcher.lastIndex = 0, matcher.exec(lines[i]))?.index ?? -1
              : probe.indexOf(needle)
            if (idx >= 0) {
              start = idx
              end = idx + (matcher ? (matcher.exec(lines[i])?.[0].length ?? pattern.length) : pattern.length)
            }
          }
          matches.push({
            matchText: lines[i].slice(start, end),
            lineText: lines[i],
            range: [[i, start], [i, end]],
            leadingContextLines: i > 0 ? [lines[i - 1]] : [],
            trailingContextLines: i + 1 < lines.length ? [lines[i + 1]] : []
          })
        }
        if (matches.length > 0) {
          emitToRenderer('mt::rg::match', envelope({ payload: { filePath: fullPath, matches } }))
        }
      } catch {
        // Unreadable file — skip.
      }
    }
  }

  try {
    for (const dir of directories) await walk(dir)
    if (isCancelled()) {
      emitToRenderer('mt::rg::cancelled', envelope({}))
    } else {
      emitToRenderer('mt::rg::done', envelope({}))
    }
  } catch (error) {
    emitToRenderer('mt::rg::error', envelope({ error: String(error) }))
  } finally {
    cancelledSearches.delete(searchId)
  }
}

const ripgrep = {
  start: async(req: unknown): Promise<{ searchId: string }> => {
    const request = req as RgStartRequest
    // Run asynchronously like the native binary would.
    void runSearch(request)
    return { searchId: request.searchId }
  },
  cancel: (searchId: string): void => {
    cancelledSearches.add(searchId)
  },
  onMatch: (handler: (payload: unknown) => void): (() => void) => on('mt::rg::match', handler as Listener),
  onProgress: (handler: (payload: unknown) => void): (() => void) => on('mt::rg::progress', handler as Listener),
  onDone: (handler: (payload: unknown) => void): (() => void) => on('mt::rg::done', handler as Listener),
  onError: (handler: (payload: unknown) => void): (() => void) => on('mt::rg::error', handler as Listener),
  onCancelled: (handler: (payload: unknown) => void): (() => void) => on('mt::rg::cancelled', handler as Listener)
}

// ---------------------------------------------------------------------------
// electron.ipcRenderer — routes renderer requests to the state host or to
// browser capabilities. Channels the desktop app handles in its main process
// but that make no sense in a browser become no-ops.
// ---------------------------------------------------------------------------

const COMMAND_TO_BUS: Record<string, string> = {
  'mt::editor-ask-file-save': 'mt::editor-ask-file-save',
  'mt::editor-ask-file-save-as': 'mt::editor-ask-file-save-as',
  'mt::editor-close-tab': 'mt::editor-close-tab',
  'mt::editor-move-file': 'mt::editor-move-file',
  'mt::editor-rename-file': 'mt::editor-rename-file',
  'mt::tabs-cycle-left': 'mt::tabs-cycle-left',
  'mt::tabs-cycle-right': 'mt::tabs-cycle-right'
}

// A tiny event bus used to route "menu-driven" commands back into the app
// without a real menu; the web bootstrap attaches the handlers.
const commandBusListeners = new Map<string, Set<() => void>>()
export const onAppCommand = (command: string, handler: () => void): (() => void) => {
  let set = commandBusListeners.get(command)
  if (!set) {
    set = new Set()
    commandBusListeners.set(command, set)
  }
  set.add(handler)
  return () => {
    set?.delete(handler)
  }
}
const dispatchAppCommand = (command: string): void => {
  commandBusListeners.get(command)?.forEach(handler => handler())
}

const downloadBlob = (data: string | Uint8Array, filename: string): void => {
  const blob = typeof data === 'string'
    ? new Blob([data], { type: 'text/markdown' })
    : new Blob([new Uint8Array(data)], { type: 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

const ipcRenderer = {
  send(channel: string, ...args: unknown[]): void {
    void (async() => {
      try {
        await handleSend(channel, args)
      } catch (error) {
        console.error(`[web-shim] send(${channel}) failed`, error)
      }
    })()
  },
  sendSync(channel: string, ...args: unknown[]): unknown {
    // Only two sync channels exist; boot info is supplied at startup.
    if (channel === 'mt::boot-info') {
      return {
        platform,
        arch: navigator.platform,
        versions: {},
        env: {},
        paths: { resources: '', userData: '/marktext', cwd: '/', ripgrepBinary: '' },
        isUpdatable: false,
        MARKDOWN_INCLUSIONS: fileUtils.MARKDOWN_INCLUSIONS
      }
    }
    if (channel === 'mt::paths::is-same-sync') return isSamePathSync(String(args[0]), String(args[1]))
    return undefined
  },
  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    return handleInvoke(channel, args)
  },
  on: (channel: string, listener: Listener) => on(channel, listener),
  once: (channel: string, listener: Listener) => once(channel, listener),
  removeAllListeners
}

async function handleSend(channel: string, args: unknown[]): Promise<void> {
  switch (channel) {
    // --- state channels -----------------------------------------------------
    case 'mt::window-initialized':
    case 'mt::project-renderer-ready':
      return
    // --- preferences --------------------------------------------------------
    case 'mt::ask-for-user-preference':
      emitToRenderer('mt::user-preference', webStateHost.readPreferences())
      return
    case 'mt::ask-for-user-data':
      emitToRenderer('mt::user-preference', webStateHost.readUserData())
      return
    case 'mt::set-user-preference':
    case 'set-user-preference': {
      const patch = args[0] as Record<string, unknown>
      webStateHost.updatePreferences(patch)
      // Reflect back like the desktop's broadcast does.
      emitToRenderer('mt::user-preference', webStateHost.readPreferences())
      if (typeof patch.autoSave === 'boolean') return
      return
    }
    case 'mt::set-user-data':
      webStateHost.updateUserData(args[0] as Record<string, unknown>)
      return
    case 'mt::get-current-language':
      emitToRenderer(
        'mt::current-language',
        String(webStateHost.readPreferences().language || 'en')
      )
      return

    // --- file dialogs / opening ---------------------------------------------
    case 'mt::cmd-open-file': {
      const { openFileDialog } = await import('./fileHandling')
      await openFileDialog()
      return
    }
    case 'mt::cmd-open-folder':
    case 'mt::cmd-add-folder': {
      const { openDirectoryDialog } = await import('./fileHandling')
      await openDirectoryDialog()
      return
    }
    case 'mt::cmd-new-editor-window':
      window.open(window.location.href, '_blank')
      return
    case 'mt::cmd-import-file': {
      const { openFileDialog } = await import('./fileHandling')
      await openFileDialog(true)
      return
    }
    case 'mt::open-file': {
      const [pathname, options] = args as [string, Record<string, unknown>]
      await webStateHost.openFile(pathname, options ?? {})
      return
    }
    case 'mt::open-file-by-window-id': {
      const [, pathname] = args as [number, string]
      await webStateHost.openFile(pathname, {})
      return
    }
    case 'mt::open-directory-by-window-id': {
      const { openDirectoryDialog } = await import('./fileHandling')
      await openDirectoryDialog()
      return
    }
    case 'mt::window::drop': {
      const paths = args[0] as string[]
      for (const pathname of paths) {
        if (hasMarkdownExtension(pathname)) await webStateHost.openFile(pathname, {})
      }
      return
    }
    case 'mt::remove-recently-used-document':
      webStateHost.removeRecentDocument(args[0] as string)
      return

    // --- save/export ----------------------------------------------------------
    case 'mt::response-print':
      window.print()
      return
    case 'mt::response-export': {
      const payload = args[0] as { type: string; content?: string; filename?: string; pathname?: string; title?: string }
      if (payload.type === 'pdf' || payload.type === 'html') {
        const { exportDocument } = await import('./fileHandling')
        await exportDocument(payload)
      }
      return
    }
    case 'mt::response-pandoc-export':
      // No pandoc in the browser; the export dialog handles HTML/PDF itself.
      return

    // --- menus → in-app commands ----------------------------------------------
    case 'mt::open-setting-window':
      dispatchAppCommand('open-settings')
      return
    case 'mt::cmd-close-window':
    case 'mt::app-try-quit':
      window.close()
      return
    case 'mt::make-screenshot':
      return
    case 'mt::check-for-update':
    case 'mt::NEED_UPDATE':
      emitToRenderer('mt::UPDATE_NOT_AVAILABLE', {})
      return
    case 'mt::format-link-click': {
      const payload = args[0] as { data?: { href?: string; isImage?: boolean } }
      const href = payload?.data?.href
      if (href && !payload?.data?.isImage) window.open(href, '_blank', 'noopener')
      return
    }
    case 'mt::request-keybindings':
      emitToRenderer('mt::keybindings-response', activeKeybindings())
      return
    case 'mt::handle-renderer-error':
      console.error('[web-shim] renderer error', args[0])
      return
    case 'mt::update-document-mode':
    case 'mt::view-layout-changed':
    case 'mt::set-editor-format-menus-enabled':
    case 'mt::update-line-ending-menu':
    case 'mt::update-format-menu':
    case 'mt::update-sidebar-menu':
    case 'mt::editor-selection-changed':
      // Menu bookkeeping only; no menus exist on the web.
      return
    case 'mt::ask-for-image-auto-path': {
      // The desktop searches the document directory for image path
      // completions; provide names from the virtual directory.
      const payload = args[0] as { pathname?: string; src?: string; id?: string }
      const dir = posixPath.dirname(payload.pathname || '/')
      const needle = posixPath.basename(payload.src || '').toLowerCase()
      const names = await store.listDirectory(dir)
      const matches = names
        .filter(name => /\.(jpeg|jpg|png|gif|svg|webp)$/i.test(name) && (!needle || name.toLowerCase().includes(needle)))
        .map(name => `${dir}/${name}`)
      emitToRenderer(`mt::response-of-image-path-${payload.id}`, matches)
      return
    }
    case 'mt::ask-for-modify-image-folder-path': {
      // Choose an image folder inside the virtual tree: default /assets.
      webStateHost.updateUserData({ imageFolderPath: '/assets' })
      emitToRenderer('mt::user-preference', { imageFolderPath: '/assets' })
      return
    }
    case 'mt::ask-for-image-path': {
      const { pickImageFile } = await import('./fileHandling')
      const path = await pickImageFile()
      emitToRenderer('mt::response-of-image-path-image-picker', path)
      return
    }
    case 'mt::set-document-read-only':
    case 'mt::rename':
    case 'mt::response-file-move-to':
    case 'mt::cancel-pending-preview':
    case 'mt::keybinding-debug-dump-keyboard-info':
    case 'mt::window-tab-closed':
    case 'mt::window-toggle-always-on-top':
    case 'mt::shell::show-item':
    case 'mt::cmd-toggle-autosave':
    case 'mt::add-recently-used-document':
    case 'menu-add-recently-used':
    case 'menu-clear-recently-used':
      return
    default:
      // Unknown send channels are ignored: main-process side effects (menus,
      // watchers, updaters) have no web equivalent.
      return
  }
}

async function handleInvoke(channel: string, args: unknown[]): Promise<unknown> {
  switch (channel) {
    // --- state channels ------------------------------------------------------
    case 'mt::state::get-window-initialization':
      return webStateHost.getWindowInitialization()
    case 'mt::state::register-untitled': {
      const [request] = args as [{ contextToken: string; title: string; markdown?: string; selected?: boolean }]
      return webStateHost.registerUntitled(
        request.contextToken,
        request.title,
        request.markdown ?? '',
        request.selected ?? true
      )
    }
    case 'mt::state::checkpoint':
      return webStateHost.checkpoint(args[0] as Parameters<typeof webStateHost.checkpoint>[0])
    case 'mt::state::save-document': {
      const [contextToken, documentId, saveAs] = args as [string, string, boolean]
      return webStateHost.saveDocument(contextToken, documentId, saveAs)
    }
    case 'mt::state::close-documents': {
      const [contextToken, ids] = args as [string, string[]]
      return webStateHost.closeDocuments(contextToken, ids)
    }

    // --- preferences ----------------------------------------------------------
    case 'mt::preferences::get':
      return webStateHost.readPreferences()
    case 'mt::preferences::update':
      webStateHost.updatePreferences(args[0] as Record<string, unknown>)
      emitToRenderer('mt::user-preference', webStateHost.readPreferences())
      return { status: 'updated' }
    case 'mt::preferences::choose-directory':
      return '/documents'

    // --- recent documents -----------------------------------------------------
    case 'mt::get-recently-used-documents':
      return webStateHost.getRecentDocuments()

    // --- keybindings ------------------------------------------------------------
    case 'mt::keybinding-get-pref-keybindings': {
      // Structured-clone-safe plain objects.
      const toPlain = (map: Map<string, string>): Record<string, string> => Object.fromEntries(map)
      return {
        defaultKeybindings: toPlain(defaultKeybindings),
        userKeybindings: toPlain(userKeybindings)
      }
    }
    case 'mt::keybinding-get-keyboard-info':
      // Browsers cannot enumerate keyboard layouts; an empty map disables
      // layout-aware normalization while keeping the configurator functional.
      return { layout: { id: 'browser', label: navigator.language }, keymap: {} }
    case 'mt::keybinding-save-user-keybindings': {
      const bindings = args[0] as Record<string, string>
      userKeybindings.clear()
      for (const [id, accelerator] of Object.entries(bindings)) userKeybindings.set(id, accelerator)
      store.writeJson('user-keybindings', Object.fromEntries(userKeybindings))
      emitToRenderer('mt::keybindings-response', activeKeybindings())
      return true
    }

    // --- filesystem (sidebar tree over the virtual OPFS tree) ------------------
    case 'mt::fs::is-file':
      return fileUtils.isFile(args[0] as string)
    case 'mt::fs::is-directory':
      return fileUtils.isDirectory(args[0] as string)
    case 'mt::fs::path-exists':
      return store.fileExists(args[0] as string) || (await store.isDirectory(args[0] as string))
    case 'mt::fs::read-file':
      return fileUtils.readFile(args[0] as string)
    case 'mt::fs::write-file':
      return fileUtils.writeFile(args[0] as string, args[1] as string)
    case 'mt::fs::readdir':
      return fileUtils.readdir(args[0] as string)
    case 'mt::fs::stat':
      return fileUtils.stat(args[0] as string)
    case 'mt::fs::unlink':
      return fileUtils.unlink(args[0] as string)
    case 'mt::fs::ensure-dir':
      return fileUtils.ensureDir(args[0] as string)
    case 'mt::fs::output-file':
      return fileUtils.outputFile(args[0] as string, args[1] as string)
    case 'mt::fs::move':
      return fileUtils.move(args[0] as string, args[1] as string)
    case 'mt::fs::copy':
      return fileUtils.copy(args[0] as string, args[1] as string)
    case 'mt::fs::copy-with-content-hash':
      return fileUtils.copyWithContentHash(args[0] as string, args[1] as string)
    case 'mt::fs::empty-dir':
      return fileUtils.emptyDir(args[0] as string)
    case 'mt::fs::is-executable':
      return false
    case 'mt::paths::is-image':
      return fileUtils.isImageFile(args[0] as string)
    case 'mt::fs-trash-item': {
      const pathname = args[0] as string
      await store.removeFile(pathname)
      webStateHost.removeRecentDocument(pathname)
      return true
    }
    case 'mt::project-remove-root':
    case 'mt::project-retry-root':
      return true
    case 'mt::project-move-item': {
      // Move inside the virtual tree; keep the sidebar contract.
      const request = args[0] as { source: string; targetDirectory: string }
      const dest = posixPath.join(request.targetDirectory, posixPath.basename(request.source))
      await store.moveEntry(request.source, dest)
      return { status: 'moved', destination: dest }
    }

    // --- dialogs ---------------------------------------------------------------
    case 'mt::dialog::show-save': {
      const request = args[0] as { defaultPath?: string; filters?: Array<{ extensions: string[] }> }
      const name = posixPath.basename(request.defaultPath || 'untitled.md')
      const picked = await chooseSavePathViaPicker(name)
      if (picked) return picked
      // No picker support: offer a download instead (path returned as-is and
      // the save goes through OPFS + download).
      return request.defaultPath ?? `/${name}`
    }
    case 'mt::ask-for-image-path': {
      const { pickImageFile } = await import('./fileHandling')
      return pickImageFile()
    }

    // --- clipboard ----------------------------------------------------------------
    case 'mt::clipboard::write-text':
      await navigator.clipboard.writeText(String(args[0]))
      return true
    case 'mt::clipboard::read-text':
      return navigator.clipboard.readText()
    case 'mt::clipboard::guess-file-path':
      return null
    case 'mt::clipboard::write-image': {
      try {
        const png = args[0] as Uint8Array
        const blob = new Blob([new Uint8Array(png)], { type: 'image/png' })
        const item = new ClipboardItem({ 'image/png': blob })
        await navigator.clipboard.write([item])
        return true
      } catch {
        return false
      }
    }
    case 'mt::clipboard::begin-image-copy':
      return null
    case 'mt::clipboard::cancel-image-copy':
      return
    case 'mt::clipboard::read-image-source':
      return { ok: false, error: 'Clipboard image reads are unavailable in the browser.' }

    // --- shell ----------------------------------------------------------------------
    case 'mt::shell::open-external':
      window.open(String(args[0]), '_blank', 'noopener')
      return
    case 'mt::shell::open-path':
      window.open(window.location.origin, '_blank')
      return ''
    case 'mt::link::fetch-html':
      try {
        const response = await fetch(String(args[0]))
        return await response.text()
      } catch {
        return ''
      }
    case 'mt::diagram::fetch-plantuml':
      try {
        const response = await fetch(`${args[0]}/plantuml/${args[2]}/${args[1]}`)
        if (!response.ok) return { ok: false, error: `HTTP ${response.status}` }
        const mime = args[2] === 'svg' ? 'image/svg+xml' : 'image/png'
        const buffer = new Uint8Array(await response.arrayBuffer())
        return { ok: true, mime, data: buffer }
      } catch (error) {
        return { ok: false, error: String(error) }
      }

    // --- window controls -------------------------------------------------------------
    case 'mt::win::is-maximized':
      return !!document.fullscreenElement
    case 'mt::win::is-fullscreen':
      return !!document.fullscreenElement

    // --- misc ---------------------------------------------------------------------------
    case 'mt::fonts::list': {
      try {
        const fonts = (await (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts?.()) ?? []
        return [...new Set(fonts.map(font => font.family))]
      } catch {
        return ['Open Sans', 'DejaVu Sans Mono', 'Source Code Pro', 'monospace', 'sans-serif']
      }
    }
    case 'mt::i18n::load':
      return i18nUtils.loadTranslations(String(args[0]))
    case 'mt::i18n::supported':
      return Object.keys(localeModules).map(path => posixPath.basename(path, '.json'))
    case 'mt::i18n::is-supported': {
      const language = String(args[0])
      return Object.keys(localeModules).some(
        path => posixPath.basename(path, '.json') === language
      )
    }
    case 'mt::spellchecker-get-available-dictionaries':
      return []
    case 'mt::spellchecker-set-enabled':
    case 'mt::spellchecker-switch-language':
      return
    case 'mt::pandoc::command':
      return { available: false, version: '', path: '' }
    case 'mt::cmd::exists':
      return false
    case 'mt::rg::start':
      return ripgrep.start(args[0])
    default:
      console.warn(`[web-shim] invoke(${channel}) is not implemented`)
      return undefined
  }
}

// ---------------------------------------------------------------------------
// window.electron
// ---------------------------------------------------------------------------

const electron = {
  ipcRenderer,
  shell: {
    openExternal: async(url: string) => {
      window.open(url, '_blank', 'noopener')
    },
    showItemInFolder: () => {},
    openPath: async() => ''
  },
  clipboard: {
    writeText: async(text: string) => !!(await navigator.clipboard.writeText(text)) || true,
    readText: () => navigator.clipboard.readText(),
    guessFilePath: async() => null,
    writeImage: async(png: Uint8Array) => Boolean(await handleInvoke('mt::clipboard::write-image', [png])),
    beginImageCopy: async() => null,
    cancelImageCopy: async() => {},
    readImageSource: async() => ({ ok: false, error: 'unavailable' })
  },
  fetchLinkHtml: (url: string) => handleInvoke('mt::link::fetch-html', [url]) as Promise<string>,
  webFrame: {
    setZoomFactor: (factor: number) => {
      document.documentElement.style.fontSize = `${Math.round(factor * 100)}%`
    },
    setZoomLevel: () => {}
  },
  webUtils: {
    // Browsers hide real paths; use the file's name as its virtual path key.
    getPathForFile: (file: File) => file.name
  },
  process: {
    platform,
    arch: 'wasm',
    versions: {},
    env: { MARKTEXT_VERSION_STRING: 'web', NODE_ENV: 'production' },
    resourcesPath: '',
    cwd: () => '/'
  },
  paths: { resources: '', userData: '/marktext', cwd: '/', ripgrepBinary: '' },
  isUpdatable: false,
  windowControl: {
    minimize: () => {},
    maximize: () => document.documentElement.requestFullscreen?.(),
    unmaximize: () => document.exitFullscreen?.(),
    toggleMaximize: () =>
      document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(),
    close: () => window.close(),
    setFullScreen: (flag: boolean) =>
      flag ? document.documentElement.requestFullscreen() : document.exitFullscreen(),
    toggleFullScreen: () =>
      document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen(),
    isMaximized: async() => !!document.fullscreenElement,
    isFullScreen: async() => !!document.fullscreenElement,
    popupMenu: (template: unknown, position?: { x: number; y: number }) => {
      void (async() => {
        const { popupWebMenu } = await import('./menu')
        popupWebMenu(
          (template ?? []) as Parameters<typeof popupWebMenu>[0],
          position,
          id => emitToRenderer('mt::menu::click', { id }),
          () => emitToRenderer('mt::menu::closed')
        )
      })()
    },
    popupApplicationMenu: (position?: { x: number; y: number }) => {
      void (async() => {
        // The application menu mirrors common File/Edit/View/Paragraph
        // actions; the command palette covers the same surface on the web.
        const { popupWebMenu } = await import('./menu')
        const { getApplicationMenuTemplate } = await import('./appMenu')
        popupWebMenu(
          getApplicationMenuTemplate(),
          position,
          id => {
            if (id === 'mt::open-settings') {
              dispatchAppCommand('open-settings')
            } else if (id === 'mt::show-command-palette') {
              emitToRenderer('mt::show-command-palette')
            } else {
              emitToRenderer('mt::execute-command-by-id', id)
            }
          },
          () => emitToRenderer('mt::menu::closed')
        )
      })()
    }
  },
  dialog: {
    showSave: (request: unknown) => handleInvoke('mt::dialog::show-save', [request])
  }
}

const uploader = {
  uploadImage: async() => ({ ok: false, error: 'Image uploaders are not available in the browser.' })
}

const fonts = {
  list: () => handleInvoke('mt::fonts::list', []) as Promise<string[]>
}

const diagram = {
  fetchPlantuml: (server: string, encoded: string, format: 'svg' | 'png') =>
    handleInvoke('mt::diagram::fetch-plantuml', [server, encoded, format])
}

const commandExists = {
  exists: async() => false
}

/** Installs every preload global onto window. */
export const installWebBridge = (): void => {
  const target = window as unknown as Record<string, unknown>
  target.electron = electron
  target.path = posixPath
  target.fileUtils = fileUtils
  target.i18nUtils = i18nUtils
  target.ripgrep = ripgrep
  target.uploader = uploader
  target.fonts = fonts
  target.diagram = diagram
  target.commandExists = commandExists
  target.rgPath = ''
  target.process = {
    platform,
    arch: 'wasm',
    versions: {},
    env: electron.process.env,
    resourcesPath: '',
    cwd: () => '/',
    nextTick: (fn: (...fnArgs: unknown[]) => void, ...fnArgs: unknown[]) =>
      Promise.resolve().then(() => fn(...fnArgs))
  }
}

export { posixPath, fileUtils }
export { downloadBlob }
