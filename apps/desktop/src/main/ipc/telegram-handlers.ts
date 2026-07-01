import { ipcMain } from 'electron'
import {
  IPC,
  type TelegramConnectArgs,
  type TelegramStatus,
  type TelegramPairing
} from '@shared/ipc'
import type { TelegramManager } from '../telegram/telegram-manager'

/**
 * Register the Telegram IPC command handlers. The renderer only ever sends the
 * token (on connect) and reads booleans/labels back — `getTelegramToken` is
 * main-only and never exposed here.
 */
export function registerTelegramHandlers(tg: TelegramManager): void {
  ipcMain.handle(IPC.TelegramGetStatus, (): TelegramStatus => tg.getStatus())

  ipcMain.handle(
    IPC.TelegramConnect,
    (_e, args: TelegramConnectArgs): Promise<TelegramStatus> => tg.connect(args.token)
  )

  ipcMain.handle(IPC.TelegramDisconnect, (): Promise<TelegramStatus> => tg.disconnect())

  ipcMain.handle(IPC.TelegramStartPairing, (): TelegramPairing => tg.startPairing())

  ipcMain.handle(IPC.TelegramUnpair, (): Promise<TelegramStatus> => tg.unpair())

  ipcMain.handle(IPC.TelegramPause, (): Promise<TelegramStatus> => tg.pause())
}
