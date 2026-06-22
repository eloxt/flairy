// Frontend quick-check validators for the Skills Repository.
// These run before any network request to give instant feedback.
// Ported from Bifrost; all version/semver logic is removed (Flairy has no
// skill versioning).

export const MAX_SKILL_FILE_SIZE_BYTES = 50 * 1024 * 1024
export const MAX_SKILL_FILE_SIZE_LABEL = '50 MB'

/** Reserved frontmatter keys that cannot be used in extraFrontmatter. */
const RESERVED_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
  'allowed-tools'
])

/** Skill name: lowercase alphanumeric + hyphens, 1-64 chars. */
const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface ValidationError {
  field: string
  message: string
}

/** Validate skill name against the Agent Skills spec. */
export function validateSkillName(name: string): string | null {
  if (!name) return 'Name is required'
  if (name.length > 64) return 'Name must be 64 characters or fewer'
  if (!SKILL_NAME_REGEX.test(name)) {
    return 'Name must be lowercase alphanumeric with hyphens only (no leading/trailing/consecutive hyphens)'
  }
  const reservedNames = ['all-skills', 'all', 'codex', 'claude-code']
  if (reservedNames.includes(name)) {
    return `"${name}" is a reserved name used by the skills serving layer`
  }
  return null
}

/** Validate description (hard limit 1024 chars). */
export function validateDescription(description: string): string | null {
  if (!description || !description.trim()) return 'Description is required'
  if (description.length > 1024)
    return `Description exceeds 1024 character limit (${description.length}/1024)`
  return null
}

/** Validate extraFrontmatter keys don't conflict with reserved names. */
export function validateExtraFrontmatter(json: string): string | null {
  if (!json || !json.trim()) return null
  try {
    const parsed = JSON.parse(json)
    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
      return 'Extra frontmatter must be a JSON object'
    }
    const conflicts = Object.keys(parsed).filter((k) => RESERVED_FRONTMATTER_KEYS.has(k))
    if (conflicts.length > 0) {
      return `Reserved keys cannot be used: ${conflicts.join(', ')}`
    }
    return null
  } catch {
    return 'Invalid JSON'
  }
}

/** Validate metadata is a flat key-value object with string values. */
export function validateMetadata(json: string): string | null {
  if (!json || !json.trim()) return null
  try {
    const parsed = JSON.parse(json)
    if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
      return 'Metadata must be a JSON object'
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof key !== 'string') return 'Metadata keys must be strings'
      if (typeof value !== 'string') return `Metadata value for "${key}" must be a string`
    }
    return null
  } catch {
    return 'Invalid JSON'
  }
}

/** Validate skillMdBody (non-empty required, soft size warning). */
export function validateSkillMdBody(body: string): {
  error: string | null
  warning: string | null
} {
  if (!body || !body.trim()) {
    return { error: 'SKILL.md body is required', warning: null }
  }
  const warning =
    body.length > 50000
      ? 'This SKILL.md body is above the recommended size. Consider moving detailed material into files under references/ and linking to them from the skill body.'
      : null
  return { error: null, warning }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function dataURLDecodedLength(value: string): number | null {
  const marker = ';base64,'
  const index = value.indexOf(marker)
  if (index < 0) return null
  const payload = value.slice(index + marker.length).replace(/\s/g, '')
  if (!payload) return 0
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.floor((payload.length * 3) / 4) - padding
}

export function validateSkillFileSize(sizeBytes: number): string | null {
  if (sizeBytes > MAX_SKILL_FILE_SIZE_BYTES) {
    return `File exceeds ${MAX_SKILL_FILE_SIZE_LABEL} limit`
  }
  return null
}

/** Validate source type-specific fields. */
export function validateSourceType(
  sourceType: string,
  values: {
    url?: string
    filepath?: string
    dataurl?: string
    content?: string
    uploadId?: string
  }
): string | null {
  switch (sourceType) {
    case 'url':
      if (!values.url) return 'URL is required'
      if (!values.url.startsWith('http://') && !values.url.startsWith('https://')) {
        return 'URL must start with http:// or https://'
      }
      return null
    case 'dataurl':
      if (!values.dataurl) return 'Data URL is required'
      if (!values.dataurl.startsWith('data:') || !values.dataurl.includes(';base64,')) {
        return 'Data URL must start with data: and contain ;base64,'
      }
      {
        const decodedLength = dataURLDecodedLength(values.dataurl)
        if (decodedLength != null) {
          const sizeErr = validateSkillFileSize(decodedLength)
          if (sizeErr) return sizeErr
        }
      }
      return null
    case 'text':
      if (!values.content || !values.content.trim()) return 'Text content is required'
      return validateSkillFileSize(utf8ByteLength(values.content))
    case 'upload':
      return null // Upload validation happens during the upload process.
    default:
      return `Unknown source type: ${sourceType}`
  }
}

/** Validate file basename (no separators, traversal, or reserved SKILL.md). */
export function validateFilename(filename: string): string | null {
  const value = filename.trim()
  if (!value) return 'Filename is required'
  if (value === '.' || value === '..') return 'Filename cannot be . or ..'
  if (value.includes('/') || value.includes('\\')) return 'Filename must not include folders'
  if (value.toLowerCase() === 'skill.md') return 'SKILL.md is managed by the skill body'
  return null
}

/** Validate relative file path (no traversal, absolute paths, or reserved SKILL.md). */
export function validateFilePath(path: string | undefined): string | null {
  if (!path || !path.trim()) return 'File path is required'
  const value = path.trim()
  if (value.startsWith('/')) return 'Path must be relative (no leading /)'
  if (value.endsWith('/')) return 'Path must point to a file, not a folder'
  if (value.includes('\\')) return 'Path must use forward slashes only'
  const segments = value.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'Path must not contain empty, current, or parent directory segments'
  }
  if (segments.length === 1 && segments[0]?.toLowerCase() === 'skill.md') {
    return 'SKILL.md is managed by the skill body'
  }
  return null
}

/** Run all validations and return errors (no version field). */
export function validateSkillForm(data: {
  name: string
  description: string
  skill_md_body: string
  extra_frontmatter_json?: string
  metadata_json?: string
}): ValidationError[] {
  const errors: ValidationError[] = []

  const nameErr = validateSkillName(data.name)
  if (nameErr) errors.push({ field: 'name', message: nameErr })

  const descErr = validateDescription(data.description)
  if (descErr) errors.push({ field: 'description', message: descErr })

  const bodyResult = validateSkillMdBody(data.skill_md_body)
  if (bodyResult.error) errors.push({ field: 'skill_md_body', message: bodyResult.error })

  if (data.extra_frontmatter_json) {
    const efErr = validateExtraFrontmatter(data.extra_frontmatter_json)
    if (efErr) errors.push({ field: 'extra_frontmatter', message: efErr })
  }

  if (data.metadata_json) {
    const mdErr = validateMetadata(data.metadata_json)
    if (mdErr) errors.push({ field: 'metadata', message: mdErr })
  }

  return errors
}
