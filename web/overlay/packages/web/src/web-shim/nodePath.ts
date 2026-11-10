// `path`/`pathe` replacement for shared `common/*` modules in the web build.
// The web build's virtual filesystem is always `/`-rooted, so a POSIX-style
// implementation with node-compatible semantics is all that's needed.

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

const basename = (pathname: string, ext?: string): string => {
  const base = normalizePosix(pathname).split('/').pop() || ''
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base
}

const dirname = (pathname: string): string => {
  const normalized = normalizePosix(pathname)
  const idx = normalized.lastIndexOf('/')
  if (idx <= 0) return idx === 0 ? '/' : '.'
  return normalized.slice(0, idx)
}

const extname = (pathname: string): string => {
  const base = basename(pathname)
  const idx = base.lastIndexOf('.')
  return idx > 0 ? base.slice(idx) : ''
}

const join = (...parts: string[]): string => normalizePosix(parts.join('/'))

const resolve = (...parts: string[]): string => {
  const joined = parts.reduce(
    (acc, part) => (part.startsWith('/') ? part : `${acc}/${part}`),
    ''
  )
  return normalizePosix(joined || '/')
}

const relative = (from: string, to: string): string => {
  const a = normalizePosix(from).split('/').filter(Boolean)
  const b = normalizePosix(to).split('/').filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const up = a.slice(i).map(() => '..')
  return [...up, ...b.slice(i)].join('/') || ''
}

const isAbsolute = (pathname: string): boolean => pathname.startsWith('/')

const parse = (pathname: string) => {
  const normalized = normalizePosix(pathname)
  const dir = dirname(normalized)
  const base = basename(normalized)
  const ext = extname(base)
  return { root: '/', dir, base, ext, name: base.slice(0, base.length - ext.length) }
}

const format = (
  pathObject: { root?: string; dir?: string; base?: string; ext?: string; name?: string }
): string => {
  const dir = pathObject.dir || ''
  const base = pathObject.base || `${pathObject.name || ''}${pathObject.ext || ''}`
  return normalizePosix(dir ? `${dir}/${base}` : base)
}

const posixPath = {
  basename,
  dirname,
  extname,
  join,
  resolve,
  relative,
  isAbsolute,
  normalize: normalizePosix,
  parse,
  format,
  sep: '/',
  delimiter: ':',
  posix: null as unknown as never, // filled below for pathe compatibility
  win32: null as unknown as never
} as const

const api = { ...posixPath, posix: null, win32: null }
api.posix = api
api.win32 = api

const nodePathDefault = api as unknown as typeof api & { default?: typeof api }
nodePathDefault.default = api

export default api
export const {
  sep,
  delimiter
} = api
export { api as path, api as pathe, api as posix, api as win32 }
