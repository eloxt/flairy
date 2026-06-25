import { ipcMain, dialog, Menu, shell } from 'electron'
import {
  IPC,
  type PromptArgs,
  type SteerArgs,
  type AbortArgs,
  type ApprovalResponseArgs,
  type QuestionResponseArgs,
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
  type SessionMenuAction,
  type RecentDirMenuAction,
  type ViewerImage
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
  ensureRecentDirectory,
  removeRecentDirectory,
  listRecentDirectories,
  upsertRemoteSession,
  searchMessages,
  listMemories,
  softDeleteMemory,
  upsertRemoteMemories,
  clearAllMemories
} from '../store/db'
import { login, register } from '../auth'
import type { ServerClient } from '../sync/server-client'
import type { UpdateManager } from '../update/update-checker'
import { redactConfig } from '../sync/config-redact'
import { broadcast, getMainWindow, openImageViewerWindow, openSettingsWindow } from '../windows'
import { randomUUID } from 'node:crypto'

/** Live agent services keyed by sessionId. */
const services = new Map<string, AgentService>()

/**
 * Images awaiting pickup by a just-opened image-viewer window, keyed by the id in
 * the window's query string. Filled by ImageViewerOpen, drained (once) by
 * ImageViewerGet. Transient — never persisted.
 */
const pendingViewerImages = new Map<string, ViewerImage>()

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

/**
 * The global tool-approval posture. One value for every session (not per-session);
 * the renderer's toggle drives it and `getOrCreateService` applies it to each new
 * AgentService. In-memory: resets to the safe `'ask'` on restart.
 */
let permissionMode: PermissionMode = 'ask'

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
    // Apply the global approval posture to the fresh service.
    svc.setPermissionMode(permissionMode)
    services.set(sessionId, svc)
  }
  return svc
}

export function registerIpcHandlers(
  server: ServerClient,
  mcp: McpManager,
  updates: UpdateManager
): void {
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

  // Memories changed on another device land in the local store; tell every
  // window so an open Settings "memories" view refreshes. Carries tombstones, so
  // a remote deletion soft-deletes locally too.
  server.onMemoryRemote((memories) => {
    upsertRemoteMemories(memories)
    broadcast(IPC.MemoriesChanged)
  })

  // Memories pulled in bulk on (re)connect: persist locally (incl. tombstones)
  // and refresh any open view. This brings a user's memories back on a fresh
  // device and converges deletions made while offline.
  server.onMemoriesPulled((memories) => {
    if (memories.length === 0) return
    upsertRemoteMemories(memories)
    broadcast(IPC.MemoriesChanged)
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
      await getOrCreateService(args.sessionId, server, mcp).submit(args.text, args.attachments)
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
  // Global posture: remember it for sessions created later, and push it to every
  // session that's already live so the change takes effect immediately.
  ipcMain.handle(IPC.AgentSetPermissionMode, (_e, mode: PermissionMode) => {
    permissionMode = mode
    for (const svc of services.values()) svc.setPermissionMode(mode)
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
    // Surface this session's working directory in the composer's recents if it
    // isn't there already (e.g. a session synced from another device). Add-only:
    // never reorder an entry the user already has.
    ensureRecentDirectory(meta.cwd)
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

  // Forget a recent directory (composer menu right-click). Recents are a local
  // convenience list only — no session/server impact. Return the updated list.
  ipcMain.handle(IPC.SessionRemoveRecentDir, (_e, path: string) => {
    removeRecentDirectory(path)
    return listRecentDirectories()
  })

  // Pop the OS-native right-click menu for a recent-directory entry and resolve
  // with the chosen action (or null if dismissed). Mirrors SessionContextMenu:
  // the renderer performs the action so the store stays the source of truth.
  ipcMain.handle(IPC.RecentDirContextMenu, () => {
    return new Promise<RecentDirMenuAction | null>((resolve) => {
      let action: RecentDirMenuAction | null = null
      const menu = Menu.buildFromTemplate([
        {
          label: t('menu.removeRecentDir'),
          click: () => {
            action = 'remove'
          }
        }
      ])
      menu.popup({ window: getMainWindow() ?? undefined, callback: () => resolve(action) })
    })
  })

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
  // pending approval for it, then remove the rows. Also tell the server to
  // delete it (and propagate to the user's other devices) so a restart/reconnect
  // doesn't pull it back. No-op if offline; an unsynced session never existed
  // server-side, so a pull can't resurrect it.
  ipcMain.handle(IPC.SessionDelete, (_e, args: DeleteSessionArgs) => {
    services.get(args.sessionId)?.dispose()
    services.delete(args.sessionId)
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

  // The user's remembered facts/preferences (active, newest first).
  ipcMain.handle(IPC.MemoryList, () => listMemories())

  // Forget one memory: soft-delete locally, mirror the tombstone to the server
  // (so it propagates to other devices and a pull can't resurrect it), tell every
  // window, and return the updated list. No-op for an unknown/already-gone id.
  ipcMain.handle(IPC.MemoryDelete, (_e, id: string) => {
    const tombstone = softDeleteMemory(id)
    if (tombstone) {
      server.sendMemoryUpsert({ memories: [tombstone] })
      broadcast(IPC.MemoriesChanged)
    }
    return listMemories()
  })

  // Forget everything: soft-delete every active memory, mirror the tombstones in
  // one batch, refresh, and return the now-empty list.
  ipcMain.handle(IPC.MemoryClear, () => {
    const tombstones = listMemories()
      .map((m) => softDeleteMemory(m.id))
      .filter((m): m is NonNullable<typeof m> => Boolean(m))
    if (tombstones.length > 0) {
      server.sendMemoryUpsert({ memories: tombstones })
      broadcast(IPC.MemoriesChanged)
    }
    return listMemories()
  })

  // Pick a directory with no session yet (home screen). Returns the path (and
  // records it in recents); the renderer stashes it for the session created on
  // the first message.
  ipcMain.handle(IPC.DialogPickDirectory, async () => {
    const dir = await pickDirectory()
    if (dir) addRecentDirectory(dir)
    return dir
  })

  // Open a full-size image-viewer window. The base64 image can be large, so it's
  // stashed in main keyed by a random id and handed to the new window via a query
  // param; the window fetches (and consumes) it once on load — never round-tripped
  // through a URL. The id is deleted on first read so the buffer doesn't linger.
  ipcMain.handle(IPC.ImageViewerOpen, (_e, image: ViewerImage) => {
    const id = randomUUID()
    pendingViewerImages.set(id, image)
    const win = openImageViewerWindow(id)
    // Free the buffer when the window closes. Reads are non-consuming (the viewer
    // may fetch twice under React StrictMode), so close is the only drain point.
    win.on('closed', () => pendingViewerImages.delete(id))
  })

  ipcMain.handle(IPC.ImageViewerGet, (_e, id: string): ViewerImage | null => {
    return pendingViewerImages.get(id) ?? null
  })

  // Open an external URL (e.g. a citation source) in the default browser. Guard
  // the scheme so the renderer can't coax the OS into launching arbitrary URIs
  // (file:, javascript:, custom app schemes) — only real web links are allowed.
  ipcMain.handle(IPC.ShellOpenExternal, (_e, url: string) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        void shell.openExternal(url)
      }
    } catch {
      // Ignore malformed URLs — nothing to open.
    }
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
    clearAllSessions()
    // Wipe locally-cached memories too so one account's memories can't leak to
    // the next account signed in on this machine; a relogin repopulates them via
    // memory:pull (the server keeps them).
    clearAllMemories()
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

  // A window that mounts after the update check ran reads the current status so
  // its header badge reflects an already-known update (the broadcast it missed).
  ipcMain.handle(IPC.UpdateGetStatus, () => updates.getStatus())

  // User clicked the update badge: open the release page in the OS browser.
  ipcMain.handle(IPC.UpdateOpenRelease, () => updates.openReleasePage())
}
