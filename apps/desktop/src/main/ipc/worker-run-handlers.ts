import { ipcMain, shell } from 'electron'
import { IPC, type WorkerRun } from '@shared/ipc'
import { abortRun, listRunsWithTail } from '../acp/dispatch'
import { hasTranscript, transcriptPath } from '../acp/transcript'

/** Runs panel IPC: list a session's worker runs (live tail merged) + abort. */
export function registerWorkerRunHandlers(): void {
  ipcMain.handle(
    IPC.WorkerRunList,
    (_e, sessionId: string): WorkerRun[] => listRunsWithTail(sessionId)
  )

  ipcMain.handle(IPC.WorkerRunAbort, (_e, runId: string): void => abortRun(runId))

  // Open the run's full transcript in the system default app. The path is
  // derived main-side from the (sanitized) run id — the renderer never supplies
  // a path, so this can't be pointed outside the transcripts dir.
  ipcMain.handle(IPC.WorkerRunOpenTranscript, async (_e, runId: string): Promise<void> => {
    if (typeof runId !== 'string' || !hasTranscript(runId)) return
    await shell.openPath(transcriptPath(runId))
  })
}
