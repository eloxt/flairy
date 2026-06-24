import { app, ipcMain, BrowserWindow } from 'electron'
import { IPC, type AppLanguage } from '@shared/ipc'
import { getLanguage, setLanguage } from '../locale'
import { buildAppMenu } from '../menu'

/**
 * Language IPC. Registered BEFORE the first window is created (see index.ts), so
 * the synchronous `SettingsGetLanguage` channel exists when the renderer's i18n
 * fires `sendSync` during module load — otherwise it returns undefined and the
 * UI flashes English on a Chinese system before correcting.
 */
export function registerLocaleHandlers(): void {
  // Synchronous: the renderer reads this before first paint.
  ipcMain.on(IPC.SettingsGetLanguage, (e) => {
    e.returnValue = getLanguage()
  })

  // Synchronous: the About tab reads the app version without an async round-trip.
  ipcMain.on(IPC.AppGetVersion, (e) => {
    e.returnValue = app.getVersion()
  })

  // Async set: persist first, then broadcast to every window and relabel the
  // native menu (which can't react to react-i18next on its own).
  ipcMain.handle(IPC.SettingsSetLanguage, (_e, lng: AppLanguage) => {
    setLanguage(lng)
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(IPC.LanguageChanged, lng)
    }
    buildAppMenu()
  })
}
