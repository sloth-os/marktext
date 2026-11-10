// Small access layer for cross-module lookups into the persisted session
// state without exporting private internals from stateHost.

import { store } from './stateHost'

/** Finds the persisted document id for a virtual path, if one is open. */
export const getDocumentByPath = async(pathname: string): Promise<string | null> => {
  const state = store.readJson<{
    documents: Array<{ document: { id: string; resource: { kind: string; location?: { path: string } } } }>
  }>('session-state', { documents: [] })
  const normalized = store.normalizeVirtualPath(pathname)
  for (const entry of state.documents) {
    if (entry.document.resource.kind === 'file' && entry.document.resource.location?.path === normalized) {
      return entry.document.id
    }
  }
  return null
}
