import { app } from 'electron'
import { join, dirname } from 'node:path'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import type { SkillConfig, SkillFile, SkillSummary } from '@flairy/shared'

/**
 * Turns server-pushed skill summaries into on-disk Agent Skills.
 *
 * The config snapshot carries only lightweight `SkillSummary` rows (skills can be
 * large). For each ENABLED summary we fetch the full skill over REST, compose its
 * `SKILL.md` (frontmatter + body), and write it plus every supporting file under
 * `userData/skills/<name>/`. The disk is the single source of truth — nothing is
 * stored in SQLite — and a tiny `.manifest.json` alongside the skill dirs records
 * each skill's id/name/updatedAt so we can diff incrementally and so the system
 * prompt can be assembled synchronously from the materialized SKILL.md files.
 *
 * Caching: a skill is re-materialized only when its `updatedAt` changes, so a
 * reconnect that delivers the same catalog is a no-op and the client stays
 * offline-capable. Skills no longer enabled/present are removed from disk.
 *
 * Everything here runs in the MAIN process and uses the user JWT directly — no
 * credential is ever exposed to the renderer.
 */

/** One entry in the on-disk manifest mirroring what's materialized under skills/. */
interface ManifestEntry {
  id: string
  name: string
  enabled: boolean
  updatedAt: string
}

/** Root directory holding every materialized skill, one subdir per skill name. */
function skillsRoot(): string {
  return join(app.getPath('userData'), 'skills')
}

function skillDir(name: string): string {
  return join(skillsRoot(), name)
}

/** Path to the manifest sidecar (hidden, so it never collides with a skill dir). */
function manifestPath(): string {
  return join(skillsRoot(), '.manifest.json')
}

/** Read the manifest; returns [] when missing or unparseable (treated as empty). */
function readManifest(): ManifestEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath(), 'utf8')) as unknown
    return Array.isArray(parsed) ? (parsed as ManifestEntry[]) : []
  } catch {
    return []
  }
}

/** Persist the manifest, creating the skills root if it doesn't exist yet. */
function writeManifest(entries: ManifestEntry[]): void {
  try {
    mkdirSync(skillsRoot(), { recursive: true })
    writeFileSync(manifestPath(), JSON.stringify(entries, null, 2), 'utf8')
  } catch (err) {
    console.error('[skill-materializer] failed to write manifest:', err)
  }
}

/**
 * Materialize the enabled subset of `summaries`. Defensive by design: a single
 * skill's fetch/write failure is logged and skipped so the rest still land.
 * Returns once all enabled skills have been processed.
 */
export async function materializeSkills(
  summaries: SkillSummary[],
  token: string | undefined,
  baseUrl: string
): Promise<void> {
  if (!token) {
    // Without a token we can't fetch details; leave the existing on-disk cache
    // untouched so we stay usable offline.
    return
  }

  const enabled = summaries.filter((s) => s.enabled)
  // The manifest mirrors disk; we mutate this map through the run and persist once.
  const manifest = new Map(readManifest().map((e) => [e.id, e]))

  // Remove skills that are gone or no longer enabled (disk + manifest).
  const keepIds = new Set(enabled.map((s) => s.id))
  for (const entry of [...manifest.values()]) {
    if (!keepIds.has(entry.id)) {
      await rmDir(skillDir(entry.name))
      manifest.delete(entry.id)
    }
  }

  for (const summary of enabled) {
    const prev = manifest.get(summary.id)
    // Skip unchanged skills (same updatedAt) — already materialized on disk.
    if (prev && prev.updatedAt === summary.updatedAt && prev.enabled) continue

    try {
      const skill = await fetchSkill(summary.id, token, baseUrl)
      // If the name changed, drop the stale directory before writing the new one.
      if (prev && prev.name !== skill.name) {
        await rmDir(skillDir(prev.name))
      }
      await writeSkill(skill, token, baseUrl)
      manifest.set(skill.id, {
        id: skill.id,
        name: skill.name,
        enabled: skill.enabled,
        updatedAt: skill.updatedAt
      })
    } catch (err) {
      // Per-item isolation: one failure must not abort the others.
      console.error(`[skill-materializer] failed to materialize "${summary.name}":`, err)
    }
  }

  writeManifest([...manifest.values()])
}

/**
 * Read the materialized skills' SKILL.md bodies straight from disk for system
 * prompt assembly. Synchronous so `buildSystemPrompt` can stay sync; the
 * frontmatter is stripped so only the skill body is returned.
 */
export function readSkillFragments(): Array<{ id: string; enabled: boolean; body: string }> {
  return readManifest().map((entry) => {
    if (!entry.enabled) return { id: entry.id, enabled: false, body: '' }
    let body = ''
    try {
      const md = readFileSync(join(skillDir(entry.name), 'SKILL.md'), 'utf8')
      body = stripFrontmatter(md)
    } catch {
      // Not materialized / unreadable (e.g. fetch failed offline) → skip it.
    }
    return { id: entry.id, enabled: true, body }
  })
}

/** Strip a leading `---`-delimited YAML frontmatter block, returning the body. */
function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()
}

async function rmDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

/** GET /api/skills/:id with the user JWT → full SkillConfig (files included). */
async function fetchSkill(id: string, token: string, baseUrl: string): Promise<SkillConfig> {
  const res = await fetch(`${baseUrl}/api/skills/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!res.ok) {
    throw new Error(`GET /api/skills/${id} -> ${res.status} ${res.statusText}`)
  }
  return (await res.json()) as SkillConfig
}

/** Write SKILL.md + every supporting file under userData/skills/<name>/. */
async function writeSkill(skill: SkillConfig, token: string, baseUrl: string): Promise<void> {
  const dir = skillDir(skill.name)
  // Start clean so removed files don't linger between updates.
  await rmDir(dir)
  await mkdir(dir, { recursive: true })

  const skillMd = `${composeFrontmatter(skill)}\n\n${skill.skillMdBody}`
  await writeFile(join(dir, 'SKILL.md'), skillMd, 'utf8')

  for (const file of skill.files) {
    try {
      const bytes = await resolveFileBytes(skill.id, file, token, baseUrl)
      const dest = join(dir, file.path)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, bytes)
    } catch (err) {
      // A single missing file shouldn't sink the whole skill.
      console.error(
        `[skill-materializer] skill "${skill.name}" file "${file.path}" failed:`,
        err
      )
    }
  }
}

/**
 * Resolve a file's bytes per its source type:
 *  - text    → inline UTF-8 `content`
 *  - dataurl → decode the base64 payload of the data URL
 *  - url/upload → GET /api/skills/:id/files/<path> (user JWT)
 */
async function resolveFileBytes(
  skillId: string,
  file: SkillFile,
  token: string,
  baseUrl: string
): Promise<Buffer> {
  switch (file.sourceType) {
    case 'text':
      return Buffer.from(file.content ?? '', 'utf8')
    case 'dataurl': {
      const base64 = file.dataurl ? file.dataurl.split(',', 2)[1] ?? '' : ''
      return Buffer.from(base64, 'base64')
    }
    case 'url':
    case 'upload':
    default: {
      const path = file.path
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/')
      const res = await fetch(
        `${baseUrl}/api/skills/${encodeURIComponent(skillId)}/files/${path}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!res.ok) {
        throw new Error(`GET file ${file.path} -> ${res.status} ${res.statusText}`)
      }
      return Buffer.from(await res.arrayBuffer())
    }
  }
}

/* ---------- frontmatter composition (ported from Bifrost helpers.ts) ---------- */

function yamlScalar(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(String(value))
}

function yamlMetadataScalar(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return String(value)
}

function yamlBlock(value: unknown, indent = 0): string[] {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`]
    return value.flatMap((item) => {
      if (item !== null && typeof item === 'object') {
        return [`${pad}-`, ...yamlBlock(item, indent + 2)]
      }
      return [`${pad}- ${yamlScalar(item)}`]
    })
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return [`${pad}{}`]
    return entries.flatMap(([key, item]) => {
      if (item !== null && typeof item === 'object') {
        return [`${pad}${key}:`, ...yamlBlock(item, indent + 2)]
      }
      return [`${pad}${key}: ${yamlScalar(item)}`]
    })
  }
  return [`${pad}${yamlScalar(value)}`]
}

function yamlField(key: string, value: unknown): string[] {
  if (value !== null && typeof value === 'object') {
    return [`${key}:`, ...yamlBlock(value, 2)]
  }
  return [`${key}: ${yamlScalar(value)}`]
}

function yamlMetadataBlock(value: unknown, indent = 0): string[] {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`]
    return value.flatMap((item) => {
      if (item !== null && typeof item === 'object') {
        return [`${pad}-`, ...yamlMetadataBlock(item, indent + 2)]
      }
      return [`${pad}- ${yamlMetadataScalar(item)}`]
    })
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return [`${pad}{}`]
    return entries.flatMap(([key, item]) => {
      if (item !== null && typeof item === 'object') {
        return [`${pad}${key}:`, ...yamlMetadataBlock(item, indent + 2)]
      }
      return [`${pad}${key}: ${yamlMetadataScalar(item)}`]
    })
  }
  return [`${pad}${yamlMetadataScalar(value)}`]
}

/**
 * Build the YAML frontmatter block for a SKILL.md. Mirrors Bifrost's
 * `composeFrontmatter`: name/description/license/compatibility/allowed-tools,
 * then extra frontmatter as top-level keys, then metadata nested under `metadata:`.
 */
export function composeFrontmatter(skill: SkillConfig): string {
  const lines: string[] = []
  lines.push(...yamlField('name', skill.name))
  lines.push(...yamlField('description', skill.description))
  if (skill.license) lines.push(...yamlField('license', skill.license))
  if (skill.compatibility) lines.push(...yamlField('compatibility', skill.compatibility))
  if (skill.allowedTools) lines.push(...yamlField('allowed-tools', skill.allowedTools))

  // Extra frontmatter renders as top-level YAML keys.
  for (const [key, value] of Object.entries(skill.extraFrontmatter ?? {})) {
    lines.push(...yamlField(key, value))
  }

  // Metadata is always nested under the `metadata:` key.
  const metadata = skill.metadata ?? {}
  if (Object.keys(metadata).length > 0) {
    lines.push('metadata:', ...yamlMetadataBlock(metadata, 2))
  }

  return `---\n${lines.join('\n')}\n---`
}
