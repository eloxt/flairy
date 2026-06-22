import { safeStorage } from 'electron'
import type { ConfigSnapshot } from '@flairy/shared'
import { saveConfigBlob, loadConfigBlob, clearConfigBlob } from './db'

/**
 * Encrypted-at-rest cache of the latest server ConfigSnapshot.
 *
 * The server is the source of truth, but it can be unreachable (offline, outage).
 * We persist the last snapshot so the client can keep working — LLM config, MCP,
 * and skills survive a restart with no server. The snapshot carries the LLM
 * credential, so the JSON is encrypted with the OS keychain (safeStorage) before
 * it touches SQLite; plaintext credentials never hit disk. Best-effort: failures
 * are logged and swallowed so caching never breaks the live config path.
 */

export function saveCachedConfig(config: ConfigSnapshot): void {
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn('[config-cache] OS encryption unavailable; skipping config cache')
      return
    }
    const enc = safeStorage.encryptString(JSON.stringify(config))
    saveConfigBlob(enc, config.version)
  } catch (err) {
    console.error('[config-cache] failed to cache config:', err)
  }
}

/** Wipe the cached config (sign-out): no stale config survives a logout. */
export function clearCachedConfig(): void {
  try {
    clearConfigBlob()
  } catch (err) {
    console.error('[config-cache] failed to clear cached config:', err)
  }
}

export function loadCachedConfig(): ConfigSnapshot | null {
  try {
    const blob = loadConfigBlob()
    if (!blob) return null
    const json = safeStorage.decryptString(blob)
    const parsed = JSON.parse(json) as ConfigSnapshot
    // Guard against a pre-upgrade cache: `llm` changed from a single `ActiveLlm`
    // to a per-role map `{ main, tool }`. An old-shape blob would mis-seed the
    // client (redact/Settings read the wrong fields) until a fresh snapshot
    // arrives, so discard it — the next `config:snapshot` repopulates the cache.
    if (!parsed.llm || typeof parsed.llm !== 'object' || !('main' in parsed.llm)) {
      return null
    }
    return parsed
  } catch (err) {
    console.error('[config-cache] failed to load cached config:', err)
    return null
  }
}
