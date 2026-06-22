// Skills Repository types for the admin UI.
//
// The data shapes live in `@flairy/shared` (camelCase, the server's serde
// mirror). Here we re-export those and add admin-only request/response helpers
// (upload response, the client-only `__local` file flag) that the server does
// not model.

export type {
  SkillConfig,
  SkillFile,
  SkillFileEntry as SharedSkillFileEntry,
  SkillFileSourceType,
  SkillInput,
  SkillListItem,
  SkillSummary
} from '@flairy/shared'

import type { SkillFileSourceType, SkillInput } from '@flairy/shared'

/**
 * A file entry as the admin form tracks it. Extends the shared entry with the
 * client-only `__local` flag, set while a row is unsaved so previews use the
 * in-memory content rather than the server file-serve endpoint.
 *
 * NOTE on uploads: unlike Bifrost (which referenced a server-side blob by
 * `upload_id`), Flairy's server resolves `upload`/`text` sources from the bytes
 * sent inline (`content` for text, `dataurl` for binary). The admin therefore
 * reads an uploaded File into a data URL and stores it on the entry.
 */
export interface SkillFileEntry {
  path: string
  sourceType: SkillFileSourceType
  content?: string
  sourceUrl?: string
  dataurl?: string
  mimeType: string
  fileSizeBytes?: number
  /** Client-only: an unsaved row can reopen the full source form / inline preview. */
  __local?: boolean
}

/** List query parameters (mirrors the server's `GET /api/skills` query). */
export interface ListSkillsParams {
  limit?: number
  offset?: number
  search?: string
  sortBy?: 'name' | 'updated_at' | 'created_at'
  order?: 'asc' | 'desc'
}

export interface ListSkillsResponse {
  skills: import('@flairy/shared').SkillListItem[]
  total: number
  limit: number
  offset: number
}

/** Response from `POST /api/skills/files/upload`. */
export interface UploadFileResponse {
  uploadId: string
  blobId: string
  filename: string
  mimeType: string
  fileSizeBytes: number
}

/** Strip the client-only `__local` flag from a form file entry for the API payload. */
export function toFileEntryPayload(file: SkillFileEntry): SkillInput['files'][number] {
  const { __local, ...rest } = file
  void __local
  return rest
}
