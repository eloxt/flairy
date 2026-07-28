import { ipcMain } from 'electron'
import { IPC, type WorkerRun } from '@shared/ipc'
import { abortRun, listRunsWithTail } from '../acp/dispatch'

/** Runs panel IPC: list a session's worker runs (live tail merged) + abort. */
export function registerWorkerRunHandlers(): void {
  ipcMain.handle(
    IPC.WorkerRunList,
    (_e, sessionId: string): WorkerRun[] => listRunsWithTail(sessionId)
  )

  ipcMain.handle(IPC.WorkerRunAbort, (_e, runId: string): void => abortRun(runId))
}
