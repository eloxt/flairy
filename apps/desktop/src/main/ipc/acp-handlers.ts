import { ipcMain } from 'electron'
import { IPC, type AcpBackendUpdateArgs, type AcpBackendView } from '@shared/ipc'
import { listBackendViews, updateBackend } from '../acp/backends'
import { probeBackend } from '../acp/probe'

/** ACP settings page IPC: list/patch worker backends + probe their options. */
export function registerAcpHandlers(): void {
  ipcMain.handle(IPC.AcpBackendList, (): AcpBackendView[] => listBackendViews())

  ipcMain.handle(
    IPC.AcpBackendUpdate,
    (_e, args: AcpBackendUpdateArgs): AcpBackendView[] => updateBackend(args)
  )

  // Serialized: concurrent probes of the same backend would race npx's
  // self-install; probing different backends concurrently is harmless but
  // rare enough that a single chain keeps it simple.
  let probeChain: Promise<unknown> = Promise.resolve()
  ipcMain.handle(IPC.AcpBackendProbe, (_e, id: string): Promise<AcpBackendView[]> => {
    const next = probeChain.then(() => probeBackend(id))
    probeChain = next.catch(() => undefined)
    return next
  })
}
