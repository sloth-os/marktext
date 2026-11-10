// OPFS-backed storage: the web equivalent of MarkText's userData directory.
// All documents, preferences and session state live under a single OPFS root.

const ROOT_DIR = 'marktext-web'

let rootPromise: Promise<FileSystemDirectoryHandle> | null = null

const getRoot = (): Promise<FileSystemDirectoryHandle> => {
  if (!rootPromise) {
    rootPromise = navigator.storage.getDirectory().then(root => root.getDirectoryHandle(ROOT_DIR, { create: true }))
  }
  return rootPromise
}

/** Resolves the chain of directory handles for `dirPath` (POSIX-ish, `/`-separated). */
const getDirectoryHandle = async(
  dirPath: string,
  create = false
): Promise<FileSystemDirectoryHandle> => {
  let dir = await getRoot()
  const parts = dirPath.split('/').filter(Boolean)
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create })
  }
  return dir
}

const splitPath = (pathname: string): { dir: string; base: string } => {
  const parts = pathname.split('/')
  const base = parts.pop() || ''
  return { dir: parts.join('/'), base }
}

/** Base name (last segment) of a virtual path. */
export const splitBase = (pathname: string): string => splitPath(normalizeVirtualPath(pathname)).base || pathname

/** Normalizes a document path to the virtual root (`/…`). */
export const normalizeVirtualPath = (pathname: string): string => {
  const joined = pathname.replace(/\\/g, '/').replace(/^\/+/, '')
  return `/${joined}`.replace(/\/{2,}/g, '/')
}

export const fileExists = async(pathname: string): Promise<boolean> => {
  try {
    const { dir, base } = splitPath(normalizeVirtualPath(pathname))
    const handle = await getDirectoryHandle(dir)
    await handle.getFileHandle(base)
    return true
  } catch {
    return false
  }
}

export const readFile = async(pathname: string): Promise<Uint8Array> => {
  const { dir, base } = splitPath(normalizeVirtualPath(pathname))
  const handle = await getDirectoryHandle(dir)
  const file = await handle.getFileHandle(base)
  const blob = await file.getFile()
  return new Uint8Array(await blob.arrayBuffer())
}

export const readTextFile = async(pathname: string): Promise<string> => {
  const bytes = await readFile(pathname)
  return new TextDecoder().decode(bytes)
}

export const writeFile = async(pathname: string, data: string | Uint8Array): Promise<void> => {
  const { dir, base } = splitPath(normalizeVirtualPath(pathname))
  const handle = await getDirectoryHandle(dir, true)
  const target = await handle.getFileHandle(base, { create: true })
  const writable = await target.createWritable()
  await writable.write(typeof data === 'string' ? new TextEncoder().encode(data) : data)
  await writable.close()
}

export const removeFile = async(pathname: string): Promise<void> => {
  try {
    const { dir, base } = splitPath(normalizeVirtualPath(pathname))
    const handle = await getDirectoryHandle(dir)
    await handle.removeEntry(base, { recursive: true })
  } catch {
    // Missing entries are treated as removed already.
  }
}

export const ensureDirectory = async(dirPath: string): Promise<void> => {
  await getDirectoryHandle(normalizeVirtualPath(dirPath), true)
}

export const listDirectory = async(dirPath: string): Promise<string[]> => {
  const names: string[] = []
  try {
    const handle = await getDirectoryHandle(normalizeVirtualPath(dirPath))
    for await (const [name] of (handle as unknown as AsyncIterable<[string, unknown]>)) {
      names.push(name)
    }
  } catch {
    // Missing directory → empty listing.
  }
  return names
}

export const isDirectory = async(pathname: string): Promise<boolean> => {
  try {
    const { dir, base } = splitPath(normalizeVirtualPath(pathname))
    const handle = await getDirectoryHandle(dir)
    await handle.getDirectoryHandle(base)
    return true
  } catch {
    return false
  }
}

export const statEntry = async(
  pathname: string
): Promise<{ size: number; mtimeMs: number; isDirectory: boolean } | null> => {
  try {
    const { dir, base } = splitPath(normalizeVirtualPath(pathname))
    const handle = await getDirectoryHandle(dir)
    try {
      const file = await handle.getFileHandle(base)
      const blob = await file.getFile()
      return { size: blob.size, mtimeMs: blob.lastModified, isDirectory: false }
    } catch {
      await handle.getDirectoryHandle(base)
      return { size: 0, mtimeMs: 0, isDirectory: true }
    }
  } catch {
    return null
  }
}

/** SHA-256 hex digest of the given bytes (WebCrypto). */
export const sha256Hex = async(data: string | Uint8Array): Promise<string> => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

// ---------------------------------------------------------------------------
// localStorage-backed JSON storage for small state (preferences, session).
// ---------------------------------------------------------------------------

export const readJson = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(`mtweb:${key}`)
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export const writeJson = (key: string, value: unknown): void => {
  try {
    localStorage.setItem(`mtweb:${key}`, JSON.stringify(value))
  } catch {
    // Storage full or unavailable; document saving still works through OPFS.
  }
}

export const removeJson = (key: string): void => {
  try {
    localStorage.removeItem(`mtweb:${key}`)
  } catch {
    // ignore
  }
}

/** Copies a file within the virtual tree. Returns the destination path. */
export const copyFile = async(src: string, dest: string): Promise<void> => {
  const bytes = await readFile(src)
  await writeFile(dest, bytes)
}

export const moveEntry = async(src: string, dest: string): Promise<void> => {
  const bytes = await readFile(src)
  await writeFile(dest, bytes)
  await removeFile(src)
}
