import { ipcMain } from 'electron'
import { IPC, type ScheduledTask, type ScheduleUpdateArgs } from '@shared/ipc'
import { getSession, listScheduledTasks } from '../store/db'
import { setTaskStatus } from '../schedule/scheduler'
import { broadcast, showMainWindow } from '../windows'

/**
 * Settings-window IPC for the scheduled-task management list. Mutations go
 * through the scheduler's shared `setTaskStatus` seam (same semantics as the
 * schedule tool: resume recompute, expired-one-shot guard, croner job sync,
 * in-flight abort) and resolve with the fresh list so the caller re-renders
 * without a second round-trip. `setTaskStatus` also broadcasts ScheduleChanged
 * for every other window.
 */
export function registerScheduleHandlers(): void {
  ipcMain.handle(IPC.ScheduleList, (): ScheduledTask[] => listScheduledTasks(true))

  ipcMain.handle(IPC.ScheduleUpdate, (_e, args: ScheduleUpdateArgs): ScheduledTask[] => {
    if (args?.status === 'active' || args?.status === 'paused') {
      try {
        setTaskStatus(args.id, args.status)
      } catch (err) {
        console.warn('[schedule] update failed:', err)
      }
    }
    return listScheduledTasks(true)
  })

  ipcMain.handle(IPC.ScheduleDelete, (_e, id: string): ScheduledTask[] => {
    try {
      setTaskStatus(id, 'deleted')
    } catch (err) {
      console.warn('[schedule] delete failed:', err)
    }
    return listScheduledTasks(true)
  })

  // "Open the task's conversation" from Settings: same handoff as clicking a
  // scheduled-run notification — focus the main window, let it open the session.
  ipcMain.handle(IPC.ScheduleRevealSession, (_e, sessionId: string): void => {
    const meta = typeof sessionId === 'string' ? getSession(sessionId) : undefined
    if (!meta) return
    showMainWindow()
    broadcast(IPC.ScheduleOpenSession, meta)
  })
}
