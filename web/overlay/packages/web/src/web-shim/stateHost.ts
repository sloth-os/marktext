// Web replacement for the Electron main process's document/session host
// (`src/main/applicationState/sessionHost.ts`). It speaks the same
// `mt::state::*` IPC protocol the renderer already uses, backed by OPFS and
// localStorage instead of disk and electron-store.

import type {
  DocumentSnapshot,
  ManagedDocumentPayload,
  RegisterUntitledResult,
  PersistResult,
  SaveFormatState,
  WindowInitialization,
  WindowCheckpointRequest,
  DocumentId,
  WorkspaceDescriptor
} from './types'
import * as store from './opfs'

// Re-exported so the IPC layer can route to these implementations.
export { store }

/** Serializable persistence blob kept in localStorage. */
interface WebSessionState {
  contextToken: string
  untitledCounter: number
  documents: Array<{
    document: DocumentSnapshot
    markdown: string
    contentRevision: number
  }>
  activeDocumentId: DocumentId | null
  // Layout/project view are accepted from checkpoints; kept for restore.
  layout: WindowCheckpointRequest['layout'] | null
  projectView: WindowCheckpointRequest['projectView'] | null
  recentDocuments: Array<{ pathname: string; isDirectory: boolean }>
  /** Names of one-time state migrations already applied to this blob. */
  migrations: string[]
}

const STATE_KEY = 'session-state'
const PREFERENCE_KEY = 'user-preferences'
const USER_DATA_KEY = 'user-data'

/**
 * One-time migration marker. The tab bar used to default to hidden — copied
 * from upstream's `createDefaultLayout` (tabs are optional on desktop, where
 * View > Toggle Tab Bar reveals them). On the web the tab strip is the only
 * way to switch documents, so the default flipped to visible, and persisted
 * layouts written by the old build are migrated once so returning sessions
 * regain a usable tab bar. Toggles made after this migration are genuine user
 * choices and are never touched again.
 */
const TABBAR_MIGRATION = 'tabbar-visible-default'

const uuid = (): string =>
  typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(36).slice(2)}`

const emptyState = (): WebSessionState => ({
  contextToken: uuid(),
  untitledCounter: 0,
  documents: [],
  activeDocumentId: null,
  layout: null,
  projectView: null,
  recentDocuments: [],
  // Stamp the marker at creation: a session created by this build must never
  // be mistaken for a pre-fix blob, or a deliberate first-session tab-bar
  // hide would be clobbered by the migration on the next load.
  migrations: [TABBAR_MIGRATION]
})

let cachedState: WebSessionState | null = null

const loadState = (): WebSessionState => {
  if (cachedState) return cachedState
  const loaded = store.readJson<WebSessionState | null>(STATE_KEY, null)
  // Persist a fresh state immediately so every later loadState() call —
  // checkpoint, register-untitled, save — sees the SAME context token that
  // getWindowInitialization handed to the renderer.
 cachedState = loaded ?? emptyState()
  if (!loaded) {
    saveState(cachedState)
  } else if (!(cachedState.migrations ?? []).includes(TABBAR_MIGRATION)) {
    // Session persisted by a build that defaulted the tab bar to hidden (the
    // renderer's initial checkpoint baked that value in). Run once, then never
    // again: later `tabBar.visible` values are the user's own View > Toggle
    // Tab Bar choices and must survive reloads untouched.
    cachedState.migrations = [...(cachedState.migrations ?? []), TABBAR_MIGRATION]
    if (cachedState.layout?.tabBar) cachedState.layout.tabBar.visible = true
    saveState(cachedState)
  }
  return cachedState
}
const saveState = (state: WebSessionState): void => {
  cachedState = state
  store.writeJson(STATE_KEY, state)
}

// ---------------------------------------------------------------------------
// Preferences (replaces Preference + DataCenter stores).
// ---------------------------------------------------------------------------

const defaultPreferences = {
  autoSave: false,
  autoSaveDelay: 5000,
  titleBarStyle: 'custom',
  openFilesInNewWindow: false,
  openFolderInNewWindow: false,
  zoom: 1.0,
  hideScrollbar: false,
  wordWrapInToc: false,
  tocPosition: 'left',
  fileSortBy: 'created',
  fileSortOrder: 'asc',
  defaultOpenMode: 'edit',
  startUpAction: 'restoreAll',
  restoreLayoutState: true,
  restoreEditors: true,
  restoreViewState: true,
  defaultDirectoryToOpen: '',
  treePathExcludePatterns: [],
  language: 'en',
  editorFontFamily: 'Open Sans',
  fontSize: 16,
  lineHeight: 1.6,
  codeFontSize: 14,
  codeFontFamily: 'DejaVu Sans Mono',
  codeBlockLineNumbers: false,
  sourceCodeLineNumbers: true,
  trimUnnecessaryCodeBlockEmptyLines: true,
  wrapCodeBlocks: false,
  editorLineWidth: '',
  autoPairBracket: true,
  autoPairMarkdownSyntax: true,
  autoPairQuote: true,
  endOfLine: 'default',
  defaultEncoding: 'utf8',
  autoGuessEncoding: true,
  autoNormalizeLineEndings: true,
  trimTrailingNewline: 2,
  textDirection: 'ltr',
  hideQuickInsertHint: false,
  imageInsertAction: 'folder',
  imagePreferRelativeDirectory: true,
  imageRelativeDirectoryBase: 'file',
  imageRelativeDirectoryName: 'assets',
  hideLinkPopup: false,
  autoCheck: false,
  preferLooseListItem: true,
  bulletListMarker: '-',
  orderListDelimiter: '.',
  preferHeadingStyle: 'atx',
  tabSize: 4,
  listIndentation: 1,
  frontmatterType: '-',
  cjkEmphasis: true,
  superSubScript: false,
  footnote: false,
  texMathGfm: false,
  texMathDollars: false,
  texMathSingleBackslash: false,
  texMathDoubleBackslash: false,
  fancyLists: false,
  highlightSyntax: false,
  inlineDiff: false,
  multilineBlockquote: false,
  githubAlerts: false,
  isHtmlEnabled: false,
  softNewlineAsSpace: false,
  sequenceTheme: 'hand',
  mermaidLightTheme: 'default',
  mermaidDarkTheme: 'dark',
  theme: 'light',
  spellcheckerEnabled: false,
  spellcheckerNoUnderline: false,
  spellcheckerLanguage: 'en_US',
  // Web-only default: keep the custom title bar (it carries the menus) but
  // window controls are hidden on platforms with native browser chrome.
  followSystemTheme: false
} satisfies Record<string, unknown>

const readPreferences = (): Record<string, unknown> => {
  const saved = store.readJson<Record<string, unknown>>(PREFERENCE_KEY, {})
  return { ...defaultPreferences, ...saved }
}

const updatePreferences = (patch: Record<string, unknown>): void => {
  const next = { ...readPreferences(), ...patch }
  store.writeJson(PREFERENCE_KEY, next)
}

const readUserData = (): Record<string, unknown> =>
  store.readJson<Record<string, unknown>>(USER_DATA_KEY, {})
const updateUserData = (patch: Record<string, unknown>): void =>
  store.writeJson(USER_DATA_KEY, { ...readUserData(), ...patch })

const getPreferredEol = (): 'lf' | 'crlf' => {
  const prefs = readPreferences()
  return prefs.endOfLine === 'crlf' ? 'crlf' : 'lf'
}

const defaultFormat = (): SaveFormatState => {
  const prefs = readPreferences()
  return {
    encoding: { encoding: String(prefs.defaultEncoding || 'utf8'), isBom: false },
    lineEnding: getPreferredEol(),
    adjustLineEndingOnSave: false,
    trimTrailingNewline: (Number(prefs.trimTrailingNewline) || 3) as 0 | 1 | 2 | 3
  }
}

// ---------------------------------------------------------------------------
// Document loading/saving — mirrors `loadMarkdownFile`/`writeMarkdownFile`
// from `src/main/filesystem/markdown.ts`, simplified for UTF-8 web storage.
// ---------------------------------------------------------------------------

const detectLineEnding = (text: string): { lineEnding: 'lf' | 'crlf'; markdown: string; adjust: boolean } => {
  const hasLf = /\n/.test(text)
  const hasCrlf = /\r\n/.test(text)
  if (hasLf && hasCrlf) return { lineEnding: 'lf', markdown: text.replace(/\r\n?/g, '\n'), adjust: false }
  if (hasCrlf) return { lineEnding: 'crlf', markdown: text.replace(/\r\n/g, '\n'), adjust: true }
  return { lineEnding: 'lf', markdown: text, adjust: false }
}

export const virtualPathToFileLocation = (pathname: string) => {
  const normalized = store.normalizeVirtualPath(pathname)
  // Canonical key: SHA-256 of the normalized path (main uses the real path).
  const keyPromise = store.sha256Hex(normalized)
  return keyPromise.then(key => ({
    path: normalized,
    canonicalPath: normalized,
    key
  }))
}

const readDocumentFromStore = async(
  pathname: string,
  readOnly = false
): Promise<{ document: DocumentSnapshot; markdown: string } | null> => {
  const bytes = await store.readFile(pathname)
  const rawText = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const { lineEnding, markdown, adjust } = detectLineEnding(rawText)
  const location = await virtualPathToFileLocation(pathname)
  const baseline = {
    exists: true as const,
    sizeBytes: bytes.byteLength,
    mtimeMs: Date.now(),
    rawSha256: await store.sha256Hex(bytes)
  }
  const document: DocumentSnapshot = {
    id: uuid(),
    title: store.splitBase(pathname),
    resource: { kind: 'file', location, pendingCreation: false },
    content: { kind: 'disk', baseline },
    readOnly,
    saveFormat: {
      encoding: { encoding: 'utf8', isBom: false },
      lineEnding,
      adjustLineEndingOnSave: adjust,
      trimTrailingNewline: 2 as const
    },
    view: null
  }
  return { document, markdown }
}

const writeDocumentToStore = async(
  pathname: string,
  markdown: string,
  format: SaveFormatState
): Promise<{ baseline: { exists: true; sizeBytes: number; mtimeMs: number; rawSha256: string }; bytes: Uint8Array }> => {
  let content = markdown
  if (format.adjustLineEndingOnSave && format.lineEnding === 'crlf') {
    content = content.replace(/\r?\n/g, '\r\n')
  }
  const bytes = new TextEncoder().encode(content)
  await store.writeFile(pathname, bytes)
  return {
    baseline: {
      exists: true,
      sizeBytes: bytes.byteLength,
      mtimeMs: Date.now(),
      rawSha256: await store.sha256Hex(bytes)
    },
    bytes
  }
}

// ---------------------------------------------------------------------------
// Session host API (invoked by the IPC shim).
// ---------------------------------------------------------------------------

interface OpenCallbacks {
  /** Delivers `mt::state::document-opened` to the renderer. */
  documentOpened: (payload: ManagedDocumentPayload) => void
  /** Delivers `mt::switch-tab-by-file_path` when the document is already open. */
  switchTab: (pathname: string, options: unknown) => void
  /** Delivers `mt::state::documents-ended`. */
  documentsEnded: (ids: string[]) => void
  /** Delivers `mt::state::document-saved`. */
  documentSaved: (result: unknown) => void
  /** Delivers `mt::tab-save-failure`. */
  saveFailure: (id: string, message: string) => void
  /** Requests a save location from the user (Save As path). */
  chooseSavePath: (suggestedName: string) => Promise<string | null>
  /** Notifies the file-handler layer to persist a handle if one exists. */
  onSaved: (documentId: string, pathname: string, markdown: string, format: SaveFormatState) => void
  /** Delivers `mt::state::context-changed` after a re-init. */
  contextChanged: (initialization: WindowInitialization) => void
  /** Delivers `mt::user-preference` to the renderer. */
  userPreference: (preferences: Record<string, unknown>) => void
}

let callbacks: OpenCallbacks | null = null
export const setCallbacks = (value: OpenCallbacks): void => {
  callbacks = value
}

const blankDocument = (markdown: string, title: string): DocumentSnapshot => ({
  id: uuid(),
  title,
  resource: { kind: 'untitled' },
  content: markdown ? { kind: 'recovery', contentRevision: 1 } : { kind: 'empty' },
  readOnly: false,
  saveFormat: defaultFormat(),
  view: null
})

/** Builds the `WindowInitialization` payload from persisted state. */
export const getWindowInitialization = async(): Promise<WindowInitialization> => {
  const state = loadState()
  const preferences = readPreferences()
  const layout =
    state.layout ?? {
      sidebar: { visible: false, activeView: 'files' as const, preferredWidthPx: 280, openedFiles: { expanded: true, preferredHeightPx: 112 } },
      outline: { visible: true, position: 'left' as const, preferredWidthPx: 220 },
      // Web default differs from upstream: the tab strip is the only way to
      // switch documents in a browser, so it must be visible on fresh
      // sessions (desktop hides it because tabs are optional there).
      tabBar: { visible: true },
      modes: { sourceCode: false, focus: false, typewriter: false }
    }
  return {
    context: { contextToken: state.contextToken },
    preferences: preferences as WindowInitialization['preferences'],
    snapshot: {
      id: 'web-window',
      updatedAtMs: Date.now(),
      lastActivatedAtMs: Date.now(),
      workspace: null,
      geometry: { normalBounds: { x: 0, y: 0, width: 1200, height: 800 }, maximized: false, displayId: null },
      layout,
      projectView: state.projectView ?? { roots: [] },
      documents: state.documents.map(entry => entry.document),
      activeDocumentId: state.activeDocumentId
    },
    documentContents: state.documents.map(entry => ({
      documentId: entry.document.id,
      contentRevision: entry.contentRevision,
      markdown: entry.markdown
    })),
    projectRoots: undefined,
    persistenceAvailable: true
  }
}

/** `mt::state::register-untitled` */
export const registerUntitled = async(
  contextToken: string,
  title: string,
  markdown: string,
  selected: boolean
): Promise<RegisterUntitledResult> => {
  const state = loadState()
  if (state.contextToken !== contextToken) return { status: 'failed', reason: 'stale-context' }
  const counter = state.untitledCounter + 1
  state.untitledCounter = counter
  const document = blankDocument(markdown, title || `Untitled-${counter}`)
  const entry = { document, markdown, contentRevision: document.content.kind === 'recovery' ? document.content.contentRevision : 0 }
  state.documents.push(entry)
  if (selected) state.activeDocumentId = document.id
  saveState(state)
  callbacks?.documentOpened({
    document,
    markdown,
    contentRevision: entry.contentRevision,
    selected
  })
  return { status: 'registered', document }
}

/** `mt::state::checkpoint` — persist dirty contents and membership. */
export const checkpoint = async(request: WindowCheckpointRequest): Promise<PersistResult> => {
  const state = loadState()
  if (state.contextToken !== request.contextToken) return { status: 'failed', reason: 'stale-context' }

  // Membership and metadata follow the request; markdown only for dirty docs.
  const dirty = new Map((request.dirtyContents ?? []).map(entry => [entry.documentId, entry]))
  const previous = new Map(state.documents.map(entry => [entry.document.id, entry]))

  state.documents = request.documents.map(document => {
    const prior = previous.get(document.id)
    const dirtyEntry = dirty.get(document.id)
    const contentRevision = dirtyEntry?.contentRevision ?? prior?.contentRevision ?? 0
    const markdown = dirtyEntry?.markdown ?? prior?.markdown ?? ''
    // The renderer's checkpoint entries (RendererDocumentCheckpoint) omit
    // main-owned metadata (title, resource); merge onto the prior snapshot
    // so restored sessions keep their file identity.
    const mergedDocument = prior
      ? { ...prior.document, ...document, resource: document.resource ?? prior.document.resource }
      : document
    return { document: mergedDocument, markdown, contentRevision }
  })
  state.activeDocumentId = request.activeDocumentId
  state.layout = request.layout
  state.projectView = request.projectView
  saveState(state)
  return {
    status: 'persisted',
    receipt: { metadataRevision: Date.now() }
  }
}

/** `mt::state::close-documents` */
export const closeDocuments = async(
  contextToken: string,
  ids: string[]
): Promise<{ status: 'closed' | 'canceled' | 'failed' }> => {
  const state = loadState()
  if (state.contextToken !== contextToken) return { status: 'failed' }
  state.documents = state.documents.filter(entry => !ids.includes(entry.document.id))
  if (state.activeDocumentId && ids.includes(state.activeDocumentId)) {
    state.activeDocumentId = state.documents[0]?.document.id ?? null
  }
  saveState(state)
  callbacks?.documentsEnded(ids)
  return { status: 'closed' }
}

/** `mt::state::save-document` */
export const saveDocument = async(
  contextToken: string,
  documentId: string,
  saveAs: boolean
): Promise<unknown> => {
  const state = loadState()
  if (state.contextToken !== contextToken) return { status: 'failed' }
  const entry = state.documents.find(item => item.document.id === documentId)
  if (!entry) return { status: 'failed' }

  const resource = entry.document.resource
  let pathname = resource.kind === 'file' ? resource.location.path : ''
  if (saveAs || !pathname) {
    const suggested = entry.document.title.endsWith('.md')
      ? entry.document.title
      : `${entry.document.title}.md`
    const chosen = await callbacks?.chooseSavePath(suggested)
    if (!chosen) return { status: 'canceled' }
    pathname = store.normalizeVirtualPath(chosen)
  }

  try {
    const { baseline } = await writeDocumentToStore(pathname, entry.markdown, entry.document.saveFormat)
    const location = await virtualPathToFileLocation(pathname)
    const saved: DocumentSnapshot = {
      ...entry.document,
      title: store.splitBase(pathname),
      resource: { kind: 'file', location, pendingCreation: false },
      content: { kind: 'disk', baseline }
    }
    entry.document = saved
    entry.contentRevision += 1
    saveState(state)
    addRecentDocument(pathname, false)

    const result = {
      status: 'saved' as const,
      document: saved,
      savedMarkdown: entry.markdown,
      savedFormat: saved.saveFormat,
      metadataRevision: Date.now()
    }
    callbacks?.documentSaved(result)
    callbacks?.onSaved(documentId, pathname, entry.markdown, saved.saveFormat)
    return result
  } catch (error) {
    callbacks?.saveFailure(documentId, error instanceof Error ? error.message : String(error))
    return { status: 'failed' }
  }
}

/** Opens a virtual-path markdown document (used by the file handler + tree). */
export const openFile = async(
  pathname: string,
  options: { preview?: boolean; requestId?: number; readOnly?: boolean } = {},
  selected = true
): Promise<void> => {
  const state = loadState()
  const normalized = store.normalizeVirtualPath(pathname)

  // Already open? Switch to the existing tab like main does.
  const location = await virtualPathToFileLocation(normalized)
  const existing = state.documents.find(
    entry =>
      entry.document.resource.kind === 'file' &&
      entry.document.resource.location.key === location.key
  )
  if (existing && existing.document.resource.kind === 'file') {
    callbacks?.switchTab(existing.document.resource.location.path, options)
    return
  }

  const loaded = await readDocumentFromStore(normalized, options.readOnly ?? false)
  if (!loaded) return

  // Retire an empty untitled active document when opening selected (main does the same).
  if (selected && state.documents.length > 0) {
    const activeId = state.activeDocumentId
    const retire = state.documents.filter(
      entry =>
        entry.document.id === activeId &&
        entry.document.resource.kind === 'untitled' &&
        entry.document.content.kind === 'empty' &&
        entry.markdown === ''
    )
    if (retire.length > 0) {
      state.documents = state.documents.filter(entry => !retire.includes(entry))
      callbacks?.documentsEnded(retire.map(entry => entry.document.id))
    }
  }

  state.documents.push({ document: loaded.document, markdown: loaded.markdown, contentRevision: 0 })
  if (selected) state.activeDocumentId = loaded.document.id
  saveState(state)
  addRecentDocument(normalized, false)

  callbacks?.documentOpened({
    document: loaded.document,
    markdown: loaded.markdown,
    contentRevision: 0,
    selected,
    options
  })
}

/** Opens an untitled document with the given markdown content. */
export const openMarkdownContent = async(markdown: string, title = ''): Promise<void> => {
  await registerUntitled(loadState().contextToken, title, markdown, true)
}

// ---------------------------------------------------------------------------
// Recent documents.
// ---------------------------------------------------------------------------

const addRecentDocument = (pathname: string, isDirectory: boolean): void => {
  const state = loadState()
  state.recentDocuments = [
    { pathname, isDirectory },
    ...state.recentDocuments.filter(item => item.pathname !== pathname)
  ].slice(0, 30)
  saveState(state)
}

const removeRecentDocument = (pathname: string): void => {
  const state = loadState()
  state.recentDocuments = state.recentDocuments.filter(item => item.pathname !== pathname)
  saveState(state)
}

const getRecentDocuments = (): Array<{ pathname: string; isDirectory: boolean }> =>
  loadState().recentDocuments

// ---------------------------------------------------------------------------
// Exported storage-backed API for the IPC layer.
// ---------------------------------------------------------------------------

export const webStateHost = {
  readPreferences,
  updatePreferences,
  readUserData,
  updateUserData,
  getWindowInitialization,
  registerUntitled,
  checkpoint,
  closeDocuments,
  saveDocument,
  openFile,
  openMarkdownContent,
  getRecentDocuments,
  removeRecentDocument,
  addRecentDocument
}
