// PWA File Handling: lets the installed PWA act as a system handler for
// `.md`/`.markdown` files (manifest `file_handlers`) and wires the browser
// File System Access API into MarkText's document flow.
//
// Capabilities:
//   1. `launchQueue` — files the OS passed to the installed PWA on launch.
//   2. `<input type=file>` / drag&drop import for browsers without handles.
//   3. Live `FileSystemFileHandle` write-through when the browser provides
//      them, so Save writes back to the real file on disk.
//   4. File System Access directory picker feeding the sidebar project tree.

import * as store from './opfs'
import { webStateHost } from './stateHost'
import { emitToRenderer, downloadBlob } from './ipc'
import type { SaveFormatState } from './types'

interface LaunchedFileHandleLike {
  kind: 'file'
  type: string
  getFile: () => Promise<File>
  handle?: FileSystemHandle
}

/** Live handles keyed by document id — write-through save support. */
const handleByDocument = new Map<string, FileSystemFileHandle>()
/** A save-picker handle awaiting its first save result. */
let pendingSaveHandle: FileSystemFileHandle | null = null

export const rememberHandleForNextSave = (handle: FileSystemFileHandle): void => {
  pendingSaveHandle = handle
}

/** Called from stateHost.onSaved: write through to the real file if a handle exists. */
export const writeThroughHandle = async(
  documentId: string,
  markdown: string,
  format: SaveFormatState
): Promise<void> => {
  const handle = pendingSaveHandle ?? handleByDocument.get(documentId)
  pendingSaveHandle = null
  if (!handle) return
  handleByDocument.set(documentId, handle)
  try {
    let content = markdown
    if (format.adjustLineEndingOnSave && format.lineEnding === 'crlf') {
      content = content.replace(/\r?\n/g, '\r\n')
    }
    const writable = await (handle as FileSystemFileHandle & {
      createWritable: () => Promise<FileSystemWritableFileStream>
    }).createWritable()
    await writable.write(new TextEncoder().encode(content))
    await writable.close()
  } catch (error) {
    console.warn('[fileHandling] write-through failed; the OPFS copy remains authoritative', error)
  }
}

const extname = (name: string): string => {
  const idx = name.lastIndexOf('.')
  return idx > 0 ? name.slice(idx) : ''
}

const hasMarkdownExtension = (name: string): boolean =>
  /\.(markdown|mdown|mkdn|md|mkd|mdwn|mdtxt|mdtext|mdx|txt)$/i.test(name)

/** Imports a browser File into the virtual tree and opens it as a document. */
export const importAndOpenFile = async(file: File, handle?: FileSystemFileHandle): Promise<void> => {
  const name = file.name || 'untitled.md'
  const safeName = hasMarkdownExtension(name) ? name : `${name}.md`
  const bytes = new Uint8Array(await file.arrayBuffer())
  await store.writeFile(`/${safeName}`, bytes)
  if (handle) handleByDocument.set(`pending:${safeName}`, handle)
  await webStateHost.openFile(`/${safeName}`, {})
  // Map the handle onto the opened document once it exists.
  if (handle) {
    const { getDocumentByPath } = await import('./stateHostAccess')
    const documentId = await getDocumentByPath(`/${safeName}`)
    if (documentId) {
      handleByDocument.set(documentId, handle)
      handleByDocument.delete(`pending:${safeName}`)
    }
  }
}

/** Shows a markdown file picker and opens whatever the user selects. */
export const openFileDialog = async(): Promise<void> => {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  input.accept = '.markdown,.mdown,.mkdn,.md,.mkd,.mdwn,.mdtxt,.mdtext,.mdx,.txt,text/markdown,text/plain'
  const chosen = await new Promise<File[]>((resolve) => {
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])))
    input.addEventListener('cancel', () => resolve([]))
    input.click()
  })
  for (const file of chosen) await importAndOpenFile(file)
}

/** Image picker used by `mt::ask-for-image-path`. */
export const pickImageFile = async(): Promise<string[]> => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/jpeg,image/png,image/gif,image/svg+xml,image/webp'
  const chosen = await new Promise<File[]>((resolve) => {
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])))
    input.addEventListener('cancel', () => resolve([]))
    input.click()
  })
  const paths: string[] = []
  for (const image of chosen) {
    const path = `/images/${image.name}`
    await store.writeFile(path, new Uint8Array(await image.arrayBuffer()))
    paths.push(path)
  }
  return paths
}

// ---------------------------------------------------------------------------
// Directory support (sidebar project tree roots).
// ---------------------------------------------------------------------------

const virtualRootsKey = 'project-roots'

interface VirtualRoot {
  key: string
  pathname: string
  watchToken: string
  status: 'ready' | 'unavailable' | 'loading'
}

export const getVirtualRoots = (): VirtualRoot[] =>
  store.readJson<VirtualRoot[]>(virtualRootsKey, [])

const setVirtualRoots = (roots: VirtualRoot[]): void => store.writeJson(virtualRootsKey, roots)

/** Opens a directory via the File System Access API and mirrors it into OPFS. */
export const openDirectoryDialog = async(): Promise<void> => {
  const picker = (window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker
  if (!picker) {
    alert(
      'Folder browsing needs the File System Access API (Chrome/Edge). Files can still be opened individually.'
    )
    return
  }
  let dir: FileSystemDirectoryHandle
  try {
    dir = await picker()
  } catch {
    return // user canceled
  }
  const rootPath = `/${dir.name}`
  await mirrorDirectory(dir, rootPath)

  const roots = getVirtualRoots().filter(root => root.pathname !== rootPath)
  roots.push({
    key: rootPath,
    pathname: rootPath,
    watchToken: `watch-${Date.now()}`,
    status: 'ready'
  })
  setVirtualRoots(roots)
  emitToRenderer('mt::project-roots-changed', {
    revision: Date.now(),
    roots,
    reason: 'add',
    targetKey: rootPath
  })
}

const mirrorDirectory = async(handle: FileSystemDirectoryHandle, target: string): Promise<void> => {
  await store.ensureDirectory(target)
  for await (const [name, entry] of handle as unknown as AsyncIterable<[string, FileSystemHandle]>) {
    const dest = `${target}/${name}`
    if (entry.kind === 'directory') {
      await mirrorDirectory(entry as FileSystemDirectoryHandle, dest)
    } else {
      try {
        const file = await (entry as FileSystemFileHandle).getFile()
        await store.writeFile(dest, new Uint8Array(await file.arrayBuffer()))
      } catch {
        // Unreadable entries are skipped.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Launch queue (PWA file handler entry point).
// ---------------------------------------------------------------------------

export const attachLaunchQueue = (): void => {
  const withLauncher = window as unknown as {
    launchQueue?: {
      setConsumer: (consumer: (params: {
        files?: LaunchedFileHandleLike[]
        targetURL?: string
      }) => void) => void
    }
  }
  if (!withLauncher.launchQueue) return
  withLauncher.launchQueue.setConsumer(async(params) => {
    try {
      for (const launched of params.files ?? []) {
        if (launched.kind !== 'file') continue
        const file = await launched.getFile()
        await importAndOpenFile(file, launched.handle as FileSystemFileHandle | undefined)
      }
    } catch (error) {
      console.error('[fileHandling] launchQueue consumer failed', error)
    }
  })
}

// ---------------------------------------------------------------------------
// Export (HTML/PDF) support.
// ---------------------------------------------------------------------------

export const exportDocument = async(payload: {
  type: string
  content?: string
  filename?: string
  title?: string
}): Promise<void> => {
  const name = payload.filename || `${payload.title || 'document'}.${payload.type === 'pdf' ? 'pdf' : 'html'}`
  if (payload.type === 'pdf') {
    // Print-to-PDF via the browser dialog.
    window.print()
    return
  }
  const html = payload.content ?? ''
  downloadBlob(html, name.endsWith('.html') ? name : `${name}.html`)
  emitToRenderer('mt::export-success', { type: payload.type, filePath: name })
}

// Re-emit roots on startup so the sidebar restores its project tree.
export const restoreProjectRoots = (): void => {
  const roots = getVirtualRoots()
  if (roots.length === 0) return
  emitToRenderer('mt::project-roots-changed', {
    revision: Date.now(),
    roots,
    reason: 'restore'
  })
}

/** Drag & drop hook: import dropped markdown files (no Electron path needed). */
export const attachDropImport = (): void => {
  window.addEventListener('dragover', (event) => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
  })
  window.addEventListener('drop', (event) => {
    if (!event.dataTransfer?.files?.length) return
    event.preventDefault()
    const files = Array.from(event.dataTransfer.files)
    void (async() => {
      for (const file of files) {
        if (hasMarkdownExtension(file.name) || /\.(html?|docx|tex|wiki)$/i.test(file.name)) {
          await importAndOpenFile(file)
        }
      }
    })()
  })
}
