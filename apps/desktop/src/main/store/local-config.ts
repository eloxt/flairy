import { safeStorage } from 'electron'
import type { ConfigSnapshot, SkillConfig } from '@flairy/shared'
import { saveLocalConfigBlob, loadLocalConfigBlob, clearLocalConfigBlob } from './db'

/**
 * Encrypted-at-rest store for the user-authored LOCAL config ("detached" mode).
 *
 * When the user detaches from the server (Advanced settings), the client stops
 * receiving pushed config and runs off this instead. The bundle holds a full
 * {@link ConfigSnapshot} (its `skills` are lightweight summaries, like the
 * server's) PLUS the full {@link SkillConfig} rows, since there is no server to
 * fetch skill bodies/files from — they must be materialized straight from here.
 *
 * The config carries LLM/MCP/service secrets, so the JSON is encrypted with the
 * OS keychain (safeStorage) before it touches SQLite; plaintext never hits disk.
 * Best-effort: failures are logged and swallowed so the live path never breaks.
 */
export interface LocalConfigBundle {
  /** The effective config consumers read (skills are summaries). */
  config: ConfigSnapshot
  /** Full skills (bodies + inline files) for local materialization. */
  skills: SkillConfig[]
}

export function saveLocalConfig(bundle: LocalConfigBundle): void {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[local-config] OS encryption unavailable; cannot save local config')
      return
    }
    const enc = safeStorage.encryptString(JSON.stringify(bundle))
    saveLocalConfigBlob(enc)
  } catch (err) {
    console.error('[local-config] failed to save local config:', err)
  }
}

/** Wipe the saved local config (sign-out): no secrets survive a logout. */
export function clearLocalConfig(): void {
  try {
    clearLocalConfigBlob()
  } catch (err) {
    console.error('[local-config] failed to clear local config:', err)
  }
}

export function loadLocalConfig(): LocalConfigBundle | null {
  try {
    const blob = loadLocalConfigBlob()
    if (!blob) return null
    const json = safeStorage.decryptString(blob)
    const parsed = JSON.parse(json) as LocalConfigBundle
    if (!parsed.config || typeof parsed.config !== 'object' || !('llm' in parsed.config)) {
      return null
    }
    if (!Array.isArray(parsed.skills)) parsed.skills = []
    return parsed
  } catch (err) {
    console.error('[local-config] failed to load local config:', err)
    return null
  }
}
