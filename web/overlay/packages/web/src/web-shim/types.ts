// Type re-exports from the upstream shared types so the web shim speaks the
// same protocol as the Electron main process.

export type {
  DocumentSnapshot,
  DocumentViewState,
  DirtyContentUpdate,
  FileLocation,
  ManagedDocumentPayload,
  PersistResult,
  RegisterUntitledResult,
  RuntimeWindowContext,
  WindowCheckpointRequest,
  WindowInitialization,
  WindowLayoutState,
  WorkspaceDescriptor,
  SaveFormatState,
  DiskBaseline,
  DocumentId,
  Sha256,
  TimestampMs
} from '@shared/types/applicationState'

export type { UserPreferences } from '@shared/types/preferences'
export type { IFileState } from '@shared/types/files'
