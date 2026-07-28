import { ipcMain } from 'electron'
import { IPC, type GithubDeviceCode, type GithubStatus } from '@shared/ipc'
import {
  cancelGithubAuth,
  disconnectGithub,
  getGithubStatus,
  setGithubClientId,
  startGithubAuth
} from '../github/auth'

/**
 * GitHub connection IPC. The renderer only ever sees GithubStatus (booleans +
 * login + pending device code) — the OAuth token itself is main-only.
 */
export function registerGithubHandlers(): void {
  ipcMain.handle(IPC.GithubGetStatus, (): GithubStatus => getGithubStatus())

  ipcMain.handle(IPC.GithubAuthStart, (): Promise<GithubDeviceCode> => startGithubAuth())

  ipcMain.handle(IPC.GithubAuthCancel, (): GithubStatus => cancelGithubAuth())

  ipcMain.handle(IPC.GithubDisconnect, (): GithubStatus => disconnectGithub())

  ipcMain.handle(
    IPC.GithubSetClientId,
    (_e, clientId: string): GithubStatus => setGithubClientId(clientId)
  )
}
