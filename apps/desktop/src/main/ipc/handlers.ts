import { ipcMain, dialog, Menu } from 'electron'
import {
  IPC,
  type PromptArgs,
  type SteerArgs,
  type AbortArgs,
  type ApprovalResponseArgs,
  type QuestionResponseArgs,
  type SetPermissionModeArgs,
  type PermissionMode,
  type CreateSessionArgs,
  type SetCwdArgs,
  type ChooseDirArgs,
  type RenameSessionArgs,
  type DeleteSessionArgs,
  type SetSecretArgs,
  type LoginArgs,
  type RegisterArgs,
  type AuthStatus,
  type AuthUser,
  type SearchMessagesArgs,
  type SessionMenuAction
} from '@shared/ipc'
import { t } from '../locale'
import { AgentService } from '../agent/agent-service'
import type { McpManager } from '../agent/mcp'
import { approvals } from '../agent/approvals'
import { questions } from '../agent/questions'
import {
  setSecret,
  hasSecret,
  setAuthToken,
  getAuthToken,
  hasAuthToken,
  setAuthUser,
  getAuthUser,
  clearAuth
} from '../store/secrets'
import {
  createSession,
  listSessions,
  getSession,
  loadMessages,
  updateSessionCwd,
  updateSessionTitle,
  deleteSession,
  clearAllSessions,
  addRecentDirectory,
  listRecentDirectories,
  upsertRemoteSession,
  searchMessages
} from '../store/db'
import { login, register } from '../auth'
import type { ServerClient } from '../sync/server-client'
import { redactConfig } from '../sync/config-redact'
import { broadcast, getMainWindow, openSettingsWindow } from '../windows'

/** Live agent services keyed by sessionId. */
const services = new Map<string, AgentService>()

/**
 * Per-session tool-approval posture chosen by the user. Kept here (not only on
 * the AgentService) so a mode picked before the service exists — or after it's
 * been discarded — is reapplied when the service is (re)created. In-memory only,
 * so everything resets to `'ask'` on restart.
 */
const permissionModes = new Map<string, PermissionMode>()

/**
 * Persist a freshly issued token + user, open the authenticated socket, and
 * return the renderer-facing status. Shared by login and register.
 */
function establishSession(
  server: ServerClient,
  token: string,
  user: AuthUser
): AuthStatus {
  setAuthToken(token)
  setAuthUser(user)
  server.connect(token)
  // Let every window refresh its auth state (other windows may be open).
  broadcast(IPC.AuthChanged)
  return { authenticated: true, user }
}

/** Show the native folder picker; returns the chosen path or null if cancelled. */
async function pickDirectory(): Promise<string | null> {
  // Parent the dialog to the live main window (resolved now, never captured) so
  // it still anchors correctly after a window close→reopen.
  const win = getMainWindow()
  const res = win
    ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    : await dialog.showOpenDialog({ properties: ['openDirectory'] })
  const dir = res.filePaths[0]
  if (res.canceled || !dir) return null
  return dir
}

function getOrCreateService(
  sessionId: string,
  server: ServerClient,
  mcp: McpManager
): AgentService {
  let svc = services.get(sessionId)
  if (!svc) {
    const meta = getSession(sessionId)
    if (!meta) throw new Error(`Unknown session: ${sessionId}`)
    svc = new AgentService({
      sessionId,
      cwd: meta.cwd,
      server,
      mcp,
      messages: loadMessages(sessionId)
    })
    // Reapply any mode the user chose before this service existed.
    const mode = permissionModes.get(sessionId)
    if (mode) svc.setPermissionMode(mode)
    services.set(sessionId, svc)
  }
  return svc
}

export function registerIpcHandlers(server: ServerClient, mcp: McpManager): void {
  // Sessions changed on another device land in the local db so the UI sees them.
  server.onSessionRemote((payload) => {
    upsertRemoteSession(payload)
    // Reflect a remotely-changed title in the sidebar live (e.g. a title another
    // device auto-generated). Scoped to title; full remote-session live refresh
    // is out of scope.
    broadcast(IPC.SessionTitleUpdated, {
      sessionId: payload.session.id,
      title: payload.session.title
    })
  })

  // A session deleted on another device: tear down any live service, remove the
  // local rows, and tell every window to refresh its sidebar.
  server.onSessionRemoteDelete(({ sessionId }) => {
    services.get(sessionId)?.dispose()
    services.delete(sessionId)
    permissionModes.delete(sessionId)
    approvals.rejectSession(sessionId)
    questions.rejectSession(sessionId)
    deleteSession(sessionId)
    broadcast(IPC.SessionsChanged)
  })

  // Sessions pulled in bulk on (re)connect: persist each one locally, then tell
  // every window its session list changed so the sidebar repopulates. This is
  // what brings a user's history back after a relogin on a fresh/stale device.
  server.onSessionsPulled((sessions) => {
    console.log('[sync] persisting', sessions.length, 'pulled session(s)')
    for (const s of sessions) {
      try {
        upsertRemoteSession(s)
      } catch (err) {
        console.error('[sync] failed to persist session', s.session?.id, err)
      }
    }
    if (sessions.length > 0) broadcast(IPC.SessionsChanged)
  })

  // Push redacted config to the renderer whenever the server delivers a new
  // snapshot/delta, so the debug/settings view stays live. Secrets are stripped
  // by redactConfig before crossing the bridge.
  server.onConfig((config) => {
    broadcast(IPC.ConfigChanged, redactConfig(config))
  })

  // If we already have a stored token from a previous run, connect immediately.
  const existingToken = getAuthToken()
  if (existingToken) server.connect(existingToken)

  ipcMain.handle(IPC.AgentPrompt, async (_e, args: PromptArgs) => {
    try {
      await getOrCreateService(args.sessionId, server, mcp).prompt(args.text, args.attachments)
    } catch (err) {
      // Creating the service can throw (e.g. no LLM config delivered yet). Push
      // it back as a visible error event instead of a swallowed invoke rejection.
      const message = err instanceof Error ? err.message : String(err)
      getMainWindow()?.webContents.send(IPC.AgentEvent, {
        sessionId: args.sessionId,
        event: { type: 'error', message }
      })
    }
  })

  ipcMain.handle(IPC.AgentSteer, (_e, args: SteerArgs) => {
    getOrCreateService(args.sessionId, server, mcp).steer(args.text)
  })

  ipcMain.handle(IPC.AgentAbort, (_e, args: AbortArgs) => {
    services.get(args.sessionId)?.abort()
  })

  ipcMain.handle(IPC.AgentApprovalResponse, (_e, args: ApprovalResponseArgs) => {
    approvals.resolve(args.approvalId, { approved: args.approved, scope: args.scope })
  })

  ipcMain.handle(IPC.AgentQuestionResponse, (_e, args: QuestionResponseArgs) => {
    questions.resolve(args.questionId, args.answers)
  })

  // Set the tool-approval posture for a session. Store it so it survives service
  // (re)creation, and apply it to a live service immediately if one exists. We do
  // NOT call getOrCreateService here — that throws before LLM config has arrived.
  ipcMain.handle(IPC.AgentSetPermissionMode, (_e, args: SetPermissionModeArgs) => {
    permissionModes.set(args.sessionId, args.mode)
    services.get(args.sessionId)?.setPermissionMode(args.mode)
  })

  ipcMain.handle(IPC.SessionList, () => listSessions())

  ipcMain.handle(IPC.SessionLoad, (_e, sessionId: string) => {
    const meta = getSession(sessionId)
    if (!meta) throw new Error(`Unknown session: ${sessionId}`)
    return { meta, messages: loadMessages(sessionId) }
  })

  // Open a session into the renderer with its LIVE state. A session running in
  // the background hasn't persisted its in-flight turn (persist happens on turn
  // boundaries), so prefer the agent's in-memory messages + running flag when a
  // service exists; fall back to the persisted snapshot for a cold session.
  ipcMain.handle(IPC.SessionLoadLive, (_e, sessionId: string) => {
    const meta = getSession(sessionId)
    if (!meta) throw new Error(`Unknown session: ${sessionId}`)
    const svc = services.get(sessionId)
    return {
      meta,
      messages: svc ? svc.getLiveMessages() : loadMessages(sessionId),
      running: svc?.isRunning() ?? false
    }
  })

  ipcMain.handle(IPC.SearchMessages, (_e, args: SearchMessagesArgs) =>
    searchMessages(args.query, args.limit)
  )

  ipcMain.handle(IPC.SessionCreate, (_e, args: CreateSessionArgs) => createSession(args))

  // Pick a directory and set it as the session's cwd: persist it and rebind the
  // live agent's local tools. Returns the updated meta, or null if cancelled.
  ipcMain.handle(IPC.SessionSetCwd, async (_e, args: SetCwdArgs) => {
    const dir = await pickDirectory()
    if (!dir) return null
    addRecentDirectory(dir)
    const meta = updateSessionCwd(args.sessionId, dir)
    services.get(args.sessionId)?.setCwd(dir)
    return meta ?? null
  })

  // Previously-used working directories for the composer's directory menu.
  ipcMain.handle(IPC.SessionListRecentDirs, () => listRecentDirectories())

  // Set an already-known path as the working directory (recents click — no
  // native dialog). Always bump recents; persist + rebind only when there's a
  // session, otherwise return null and let the renderer stash it as pendingCwd.
  ipcMain.handle(IPC.SessionChooseDir, (_e, args: ChooseDirArgs) => {
    addRecentDirectory(args.path)
    if (!args.sessionId) return null
    const meta = updateSessionCwd(args.sessionId, args.path)
    services.get(args.sessionId)?.setCwd(args.path)
    return meta ?? null
  })

  // Rename a session. Title-gen only fires while the title is still the default
  // 'New session' (see AgentService.maybeGenerateTitle), so a manual rename is
  // safe from being overwritten. Broadcast so every window's sidebar updates.
  ipcMain.handle(IPC.SessionRename, (_e, args: RenameSessionArgs) => {
    if (!getSession(args.sessionId)) return null
    const title = args.title.trim()
    if (!title) return getSession(args.sessionId) ?? null
    const meta = updateSessionTitle(args.sessionId, title)
    broadcast(IPC.SessionTitleUpdated, { sessionId: args.sessionId, title })
    // Mirror the new title to the server so a restart/reconnect doesn't pull the
    // old title back over it. Reuse the existing updatedAt (rename intentionally
    // doesn't reorder the sidebar) and let the server's patch apply title only.
    // No-op if offline or if the session was never synced (server patch is
    // UPDATE-only — and an unsynced session can't be resurrected by a pull).
    if (meta) {
      server.sendSessionPatch({
        sessionId: args.sessionId,
        appendMessages: [],
        updatedAt: meta.updatedAt,
        title
      })
    }
    return meta ?? null
  })

  // Delete a session locally. Tear the live service down fully (dispose, not
  // abort) so a late terminal event can't re-persist messages, settle any
  // pending approval for it, drop its permission posture, then remove the rows.
  // Also tell the server to delete it (and propagate to the user's other
  // devices) so a restart/reconnect doesn't pull it back. No-op if offline; an
  // unsynced session never existed server-side, so a pull can't resurrect it.
  ipcMain.handle(IPC.SessionDelete, (_e, args: DeleteSessionArgs) => {
    services.get(args.sessionId)?.dispose()
    services.delete(args.sessionId)
    permissionModes.delete(args.sessionId)
    approvals.rejectSession(args.sessionId)
    questions.rejectSession(args.sessionId)
    server.sendSessionDelete({ sessionId: args.sessionId })
    return deleteSession(args.sessionId)
  })

  // Pop the OS-native right-click menu for a session row and resolve with the
  // chosen action (or null if dismissed). The renderer performs the action so
  // the store remains the single source of truth for UI state.
  ipcMain.handle(IPC.SessionContextMenu, () => {
    return new Promise<SessionMenuAction | null>((resolve) => {
      let action: SessionMenuAction | null = null
      const menu = Menu.buildFromTemplate([
        {
          label: t('menu.renameChat'),
          click: () => {
            action = 'rename'
          }
        },
        {
          label: t('menu.deleteChat'),
          click: () => {
            action = 'delete'
          }
        }
      ])
      // `callback` fires once the menu closes — after any item's click handler —
      // so `action` reflects the selection (or stays null on dismissal). Anchor
      // to the live main window, resolved now rather than captured.
      menu.popup({ window: getMainWindow() ?? undefined, callback: () => resolve(action) })
    })
  })

  // Pick a directory with no session yet (home screen). Returns the path (and
  // records it in recents); the renderer stashes it for the session created on
  // the first message.
  ipcMain.handle(IPC.DialogPickDirectory, async () => {
    const dir = await pickDirectory()
    if (dir) addRecentDirectory(dir)
    return dir
  })

  ipcMain.handle(IPC.SecretsSet, (_e, args: SetSecretArgs) => setSecret(args))

  ipcMain.handle(IPC.SecretsHas, (_e, provider: SetSecretArgs['provider']) => hasSecret(provider))

  // Auth: log in over REST, persist the JWT + user (main-process only), then open
  // the authenticated socket so config + session sync start flowing.
  ipcMain.handle(IPC.AuthLogin, async (_e, args: LoginArgs): Promise<AuthStatus> => {
    const { token, user } = await login(args.email, args.password)
    return establishSession(server, token, user)
  })

  // Registration mirrors login: create the account, persist, connect, return status.
  ipcMain.handle(IPC.AuthRegister, async (_e, args: RegisterArgs): Promise<AuthStatus> => {
    const { token, user } = await register(args.email, args.password, args.displayName)
    return establishSession(server, token, user)
  })

  // Sign out: drop the socket and wipe persisted credentials, then tell every
  // window to re-gate (the main window flips to the auth screen; a settings
  // window closes itself).
  ipcMain.handle(IPC.AuthLogout, () => {
    server.disconnect()
    server.clearConfig()
    // Tear down live agents and wipe locally-cached sessions so the signed-out
    // user's history can't leak to the next account on this machine. The server
    // keeps the history; a relogin repopulates it via session:pull.
    for (const svc of services.values()) svc.dispose()
    services.clear()
    permissionModes.clear()
    clearAllSessions()
    clearAuth()
    broadcast(IPC.AuthChanged)
  })

  ipcMain.handle(IPC.AuthStatus, (): AuthStatus => {
    if (!hasAuthToken()) return { authenticated: false }
    return { authenticated: true, user: getAuthUser() }
  })

  // Debug/settings view: return the current config with secrets masked.
  ipcMain.handle(IPC.ConfigGet, () => redactConfig(server.getConfig()))

  // Open the standalone Settings window (from the sidebar).
  ipcMain.handle(IPC.WindowOpenSettings, () => openSettingsWindow())
}
