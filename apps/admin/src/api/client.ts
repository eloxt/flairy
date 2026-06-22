import type {
  AdminConfigSnapshot,
  LlmModelConfig,
  LlmModelInput,
  LlmProviderConfig,
  LlmProviderInput,
  LlmRole,
  LoginRequest,
  LoginResponse,
  McpServerConfig,
  McpServerInput,
  SkillConfig,
  SkillInput,
  SystemPromptConfig,
  SystemPromptInput
} from '@flairy/shared'
import type {
  ListSkillsParams,
  ListSkillsResponse,
  UploadFileResponse
} from '@/lib/types/skills'

export const BASE_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8787'
const TOKEN_KEY = 'flairy.admin.token'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

interface RequestOptions {
  method?: string
  body?: unknown
  /** Set false for endpoints that must not send the bearer token (e.g. login). */
  auth?: boolean
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true } = options
  const headers: Record<string, string> = {}

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  if (auth) {
    const token = getToken()
    if (token) headers['Authorization'] = `Bearer ${token}`
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  })

  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const data = await res.json()
      if (data && typeof data === 'object' && 'message' in data) {
        message = String((data as { message: unknown }).message)
      } else if (data && typeof data === 'object' && 'error' in data) {
        message = String((data as { error: unknown }).error)
      }
    } catch {
      // Non-JSON error body; keep the default message.
    }
    throw new ApiError(res.status, message)
  }

  // 204 / empty body.
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export function login(credentials: LoginRequest): Promise<LoginResponse> {
  return request<LoginResponse>('/api/auth/login', {
    method: 'POST',
    body: credentials,
    auth: false
  })
}

/** Full admin read model (LLM catalog + mcp/skill lists + version). */
export function getConfig(): Promise<AdminConfigSnapshot> {
  return request<AdminConfigSnapshot>('/api/config')
}

/* ---------- LLM providers ---------- */

export function createLlmProvider(body: LlmProviderInput): Promise<LlmProviderConfig> {
  return request<LlmProviderConfig>('/api/llm-providers', { method: 'POST', body })
}

export function updateLlmProvider(id: string, body: LlmProviderInput): Promise<LlmProviderConfig> {
  return request<LlmProviderConfig>(`/api/llm-providers/${id}`, { method: 'PUT', body })
}

export function deleteLlmProvider(id: string): Promise<void> {
  return request<void>(`/api/llm-providers/${id}`, { method: 'DELETE' })
}

/* ---------- LLM models ---------- */

export function createLlmModel(body: LlmModelInput): Promise<LlmModelConfig> {
  return request<LlmModelConfig>('/api/llm-models', { method: 'POST', body })
}

export function updateLlmModel(id: string, body: LlmModelInput): Promise<LlmModelConfig> {
  return request<LlmModelConfig>(`/api/llm-models/${id}`, { method: 'PUT', body })
}

export function deleteLlmModel(id: string): Promise<void> {
  return request<void>(`/api/llm-models/${id}`, { method: 'DELETE' })
}

/* ---------- LLM role assignments ---------- */

/** Bind a model to a role (`main` / `tool`). Replaces any existing binding. */
export function assignLlmRole(role: LlmRole, modelId: string): Promise<void> {
  return request<void>(`/api/llm-roles/${role}`, { method: 'PUT', body: { modelId } })
}

/** Clear a role binding. The server rejects clearing `main` (400). */
export function clearLlmRole(role: LlmRole): Promise<void> {
  return request<void>(`/api/llm-roles/${role}`, { method: 'DELETE' })
}

/* ---------- MCP servers ---------- */

export function createMcpServer(body: McpServerInput): Promise<McpServerConfig> {
  return request<McpServerConfig>('/api/mcp-servers', { method: 'POST', body })
}

export function updateMcpServer(id: string, body: McpServerInput): Promise<McpServerConfig> {
  return request<McpServerConfig>(`/api/mcp-servers/${id}`, { method: 'PUT', body })
}

export function deleteMcpServer(id: string): Promise<void> {
  return request<void>(`/api/mcp-servers/${id}`, { method: 'DELETE' })
}

/* ---------- System prompts ---------- */

export function createSystemPrompt(body: SystemPromptInput): Promise<SystemPromptConfig> {
  return request<SystemPromptConfig>('/api/system-prompts', { method: 'POST', body })
}

export function updateSystemPrompt(
  id: string,
  body: SystemPromptInput
): Promise<SystemPromptConfig> {
  return request<SystemPromptConfig>(`/api/system-prompts/${id}`, { method: 'PUT', body })
}

export function deleteSystemPrompt(id: string): Promise<void> {
  return request<void>(`/api/system-prompts/${id}`, { method: 'DELETE' })
}

/* ---------- Skills ---------- */

/** Paginated, searchable, sortable skill list. */
export function listSkills(params?: ListSkillsParams): Promise<ListSkillsResponse> {
  const qs = new URLSearchParams()
  if (params?.limit != null) qs.set('limit', String(params.limit))
  if (params?.offset != null) qs.set('offset', String(params.offset))
  if (params?.search) qs.set('search', params.search)
  if (params?.sortBy) qs.set('sort_by', params.sortBy)
  if (params?.order) qs.set('order', params.order)
  const suffix = qs.toString()
  return request<ListSkillsResponse>(`/api/skills${suffix ? `?${suffix}` : ''}`)
}

/** Full skill incl. files (text hydrated). */
export function getSkill(id: string): Promise<SkillConfig> {
  return request<SkillConfig>(`/api/skills/${id}`)
}

export function createSkill(body: SkillInput): Promise<SkillConfig> {
  return request<SkillConfig>('/api/skills', { method: 'POST', body })
}

export function updateSkill(id: string, body: SkillInput): Promise<SkillConfig> {
  return request<SkillConfig>(`/api/skills/${id}`, { method: 'PUT', body })
}

export function deleteSkill(id: string): Promise<void> {
  return request<void>(`/api/skills/${id}`, { method: 'DELETE' })
}

/**
 * Upload a file's bytes. Returns the deduped blob id. Note: the server resolves
 * an `upload` source from the bytes sent inline at save time, so this endpoint
 * is used for size/MIME validation; callers still embed the bytes in the file
 * entry (see `lib/types/skills.ts`).
 */
export function uploadSkillFile(file: File): Promise<UploadFileResponse> {
  const form = new FormData()
  form.append('file', file)
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  return fetch(`${BASE_URL}/api/skills/files/upload`, {
    method: 'POST',
    headers, // no Content-Type — the browser sets the multipart boundary
    body: form
  }).then(async (res) => {
    if (!res.ok) {
      let message = `Upload failed (${res.status})`
      try {
        const data = await res.json()
        if (data && typeof data === 'object' && 'message' in data) {
          message = String((data as { message: unknown }).message)
        }
      } catch {
        // keep default
      }
      throw new ApiError(res.status, message)
    }
    return (await res.json()) as UploadFileResponse
  })
}

/** Build the (authenticated) URL for a stored skill file's raw bytes. */
export function skillFileServeUrl(id: string, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${BASE_URL}/api/skills/${id}/files/${encoded}`
}

/**
 * Fetch a stored skill file's bytes with the bearer token and return an object
 * URL (the file-serve endpoint requires auth, so `<img src>` / `<a href>` can't
 * hit it directly). Callers must revoke the URL when done.
 */
export async function fetchSkillFileObjectUrl(id: string, path: string): Promise<string> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(skillFileServeUrl(id, path), { headers })
  if (!res.ok) throw new ApiError(res.status, `Failed to load file (${res.status})`)
  const blob = await res.blob()
  return URL.createObjectURL(blob)
}

/** Fetch a stored skill file's text content with the bearer token. */
export async function fetchSkillFileText(id: string, path: string): Promise<string> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(skillFileServeUrl(id, path), { headers })
  if (!res.ok) throw new ApiError(res.status, `Failed to load file (${res.status})`)
  return res.text()
}
