import type { FlairyApi } from '@shared/ipc'

declare global {
  interface Window {
    api: FlairyApi
  }
}

export {}
