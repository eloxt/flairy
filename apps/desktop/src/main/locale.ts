import { app } from 'electron'
import type { AppLanguage } from '@shared/ipc'
import { getSetting, setSetting } from './store/db'
import { en } from './i18n/en'
import { zhCN } from './i18n/zh-CN'

/**
 * Main-side language authority. The main process owns the locale (it has SQLite
 * + `app.getLocale()`) and exposes it to the renderer via IPC. This module keeps
 * a tiny parallel translator for the few native strings main produces directly
 * (notification, default session title, menu) — it can't use react-i18next.
 */

export type { AppLanguage }

const catalogs: Record<AppLanguage, Record<string, string>> = {
  en,
  'zh-CN': zhCN
}

/**
 * Resolve the language to start with: a previously-saved choice wins; otherwise
 * follow the system locale (`zh-*` → `zh-CN`, anything else → `en`).
 */
export function resolveInitialLanguage(): AppLanguage {
  const saved = getSetting('language')
  if (saved === 'en' || saved === 'zh-CN') return saved
  return app.getLocale().toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

// In-memory current language, lazily seeded on first read.
let current: AppLanguage | undefined

export function getLanguage(): AppLanguage {
  return (current ??= resolveInitialLanguage())
}

/** Persist the choice first (so a restart honors it), then update memory. */
export function setLanguage(lng: AppLanguage): void {
  setSetting('language', lng)
  current = lng
}

/** Translate a key in the current language; falls back to the key itself. */
export function t(key: string): string {
  return catalogs[getLanguage()][key] ?? key
}
