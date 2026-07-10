import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppLanguage,
  type ChatWidth,
  type FlairyApi,
  type AgentEventEnvelope,
  type ApprovalRequestPayload,
  type CompressStatusPayload,
  type QuestionRequestPayload,
  type RedactedConfigSnapshot,
  type SessionTitleUpdatedPayload,
  type SocketConnectionStatus,
  type TelegramStatus,
  type UpdateInfo
} from '@shared/ipc'

/**
 * The ONLY bridge between renderer and main. We expose a typed, whitelisted API
 * — never the raw ipcRenderer — so the renderer can't reach arbitrary channels.
 */
const api: FlairyApi = {
  prompt: (args) => ipcRenderer.invoke(IPC.AgentPrompt, args),
  steer: (args) => ipcRenderer.invoke(IPC.AgentSteer, args),
  abort: (args) => ipcRenderer.invoke(IPC.AgentAbort, args),
  respondApproval: (args) => ipcRenderer.invoke(IPC.AgentApprovalResponse, args),
  respondQuestion: (args) => ipcRenderer.invoke(IPC.AgentQuestionResponse, args),
  setPermissionMode: (mode) => ipcRenderer.invoke(IPC.AgentSetPermissionMode, mode),
  compressContext: (args) => ipcRenderer.invoke(IPC.AgentCompressContext, args),
  listSessions: () => ipcRenderer.invoke(IPC.SessionList),
  loadSession: (sessionId) => ipcRenderer.invoke(IPC.SessionLoad, sessionId),
  loadSessionLive: (sessionId) => ipcRenderer.invoke(IPC.SessionLoadLive, sessionId),
  searchMessages: (args) => ipcRenderer.invoke(IPC.SearchMessages, args),
  createSession: (args) => ipcRenderer.invoke(IPC.SessionCreate, args),
  setWorkingDirectory: (args) => ipcRenderer.invoke(IPC.SessionSetCwd, args),
  listRecentDirectories: () => ipcRenderer.invoke(IPC.SessionListRecentDirs),
  removeRecentDirectory: (path) => ipcRenderer.invoke(IPC.SessionRemoveRecentDir, path),
  showRecentDirMenu: () => ipcRenderer.invoke(IPC.RecentDirContextMenu),
  chooseDirectory: (args) => ipcRenderer.invoke(IPC.SessionChooseDir, args),
  renameSession: (args) => ipcRenderer.invoke(IPC.SessionRename, args),
  deleteSession: (args) => ipcRenderer.invoke(IPC.SessionDelete, args),
  listMemories: () => ipcRenderer.invoke(IPC.MemoryList),
  deleteMemory: (id) => ipcRenderer.invoke(IPC.MemoryDelete, id),
  clearMemories: () => ipcRenderer.invoke(IPC.MemoryClear),
  showSessionMenu: () => ipcRenderer.invoke(IPC.SessionContextMenu),
  pickDirectory: () => ipcRenderer.invoke(IPC.DialogPickDirectory),
  listWorkspaceFiles: (args) => ipcRenderer.invoke(IPC.FsListFiles, args),
  readWorkspaceFile: (args) => ipcRenderer.invoke(IPC.FsReadFile, args),
  setSecret: (args) => ipcRenderer.invoke(IPC.SecretsSet, args),
  hasSecret: (provider) => ipcRenderer.invoke(IPC.SecretsHas, provider),
  getTelegramStatus: () => ipcRenderer.invoke(IPC.TelegramGetStatus),
  connectTelegram: (args) => ipcRenderer.invoke(IPC.TelegramConnect, args),
  disconnectTelegram: () => ipcRenderer.invoke(IPC.TelegramDisconnect),
  startTelegramPairing: () => ipcRenderer.invoke(IPC.TelegramStartPairing),
  unpairTelegram: () => ipcRenderer.invoke(IPC.TelegramUnpair),
  pauseTelegram: () => ipcRenderer.invoke(IPC.TelegramPause),
  resumeTelegram: () => ipcRenderer.invoke(IPC.TelegramResume),
  login: (args) => ipcRenderer.invoke(IPC.AuthLogin, args),
  register: (args) => ipcRenderer.invoke(IPC.AuthRegister, args),
  logout: () => ipcRenderer.invoke(IPC.AuthLogout),
  authStatus: () => ipcRenderer.invoke(IPC.AuthStatus),
  getConfig: () => ipcRenderer.invoke(IPC.ConfigGet),
  getSocketStatus: () => ipcRenderer.invoke(IPC.SocketStatusGet),
  openSettings: () => ipcRenderer.invoke(IPC.WindowOpenSettings),
  growWindowWidth: (delta) => ipcRenderer.invoke(IPC.WindowGrowWidth, delta),
  openExternal: (url) => ipcRenderer.invoke(IPC.ShellOpenExternal, url),
  openImageViewer: (image) => ipcRenderer.invoke(IPC.ImageViewerOpen, image),
  getViewerImage: (id) => ipcRenderer.invoke(IPC.ImageViewerGet, id),
  getAppVersion: () => ipcRenderer.sendSync(IPC.AppGetVersion) as string,
  getUpdateStatus: () => ipcRenderer.invoke(IPC.UpdateGetStatus),
  openReleasePage: () => ipcRenderer.invoke(IPC.UpdateOpenRelease),
  platform: process.platform,
  getInitialLanguage: () => ipcRenderer.sendSync(IPC.SettingsGetLanguage) as AppLanguage,
  setLanguage: (lng) => ipcRenderer.invoke(IPC.SettingsSetLanguage, lng),
  getCloseToTray: () => ipcRenderer.invoke(IPC.SettingsGetCloseToTray),
  setCloseToTray: (v) => ipcRenderer.invoke(IPC.SettingsSetCloseToTray, v),
  getChatWidth: () => ipcRenderer.invoke(IPC.SettingsGetChatWidth),
  setChatWidth: (w) => ipcRenderer.invoke(IPC.SettingsSetChatWidth, w),

  onAgentEvent: (cb) => {
    const listener = (_e: unknown, env: AgentEventEnvelope): void => cb(env)
    ipcRenderer.on(IPC.AgentEvent, listener)
    return () => ipcRenderer.removeListener(IPC.AgentEvent, listener)
  },
  onApprovalRequest: (cb) => {
    const listener = (_e: unknown, req: ApprovalRequestPayload): void => cb(req)
    ipcRenderer.on(IPC.ApprovalRequest, listener)
    return () => ipcRenderer.removeListener(IPC.ApprovalRequest, listener)
  },
  onQuestionRequest: (cb) => {
    const listener = (_e: unknown, req: QuestionRequestPayload): void => cb(req)
    ipcRenderer.on(IPC.QuestionRequest, listener)
    return () => ipcRenderer.removeListener(IPC.QuestionRequest, listener)
  },
  onConfigChanged: (cb) => {
    const listener = (_e: unknown, config: RedactedConfigSnapshot): void => cb(config)
    ipcRenderer.on(IPC.ConfigChanged, listener)
    return () => ipcRenderer.removeListener(IPC.ConfigChanged, listener)
  },
  onSocketStatusChanged: (cb) => {
    const listener = (_e: unknown, status: SocketConnectionStatus): void => cb(status)
    ipcRenderer.on(IPC.SocketStatusChanged, listener)
    return () => ipcRenderer.removeListener(IPC.SocketStatusChanged, listener)
  },
  onSessionTitleUpdated: (cb) => {
    const listener = (_e: unknown, payload: SessionTitleUpdatedPayload): void => cb(payload)
    ipcRenderer.on(IPC.SessionTitleUpdated, listener)
    return () => ipcRenderer.removeListener(IPC.SessionTitleUpdated, listener)
  },
  onAuthChanged: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.AuthChanged, listener)
    return () => ipcRenderer.removeListener(IPC.AuthChanged, listener)
  },
  onSessionsChanged: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.SessionsChanged, listener)
    return () => ipcRenderer.removeListener(IPC.SessionsChanged, listener)
  },
  onMemoriesChanged: (cb) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.MemoriesChanged, listener)
    return () => ipcRenderer.removeListener(IPC.MemoriesChanged, listener)
  },
  onLanguageChanged: (cb) => {
    const listener = (_e: unknown, lng: AppLanguage): void => cb(lng)
    ipcRenderer.on(IPC.LanguageChanged, listener)
    return () => ipcRenderer.removeListener(IPC.LanguageChanged, listener)
  },
  onChatWidthChanged: (cb) => {
    const listener = (_e: unknown, w: ChatWidth): void => cb(w)
    ipcRenderer.on(IPC.ChatWidthChanged, listener)
    return () => ipcRenderer.removeListener(IPC.ChatWidthChanged, listener)
  },
  onUpdateAvailable: (cb) => {
    const listener = (_e: unknown, info: UpdateInfo): void => cb(info)
    ipcRenderer.on(IPC.UpdateAvailable, listener)
    return () => ipcRenderer.removeListener(IPC.UpdateAvailable, listener)
  },
  onTelegramStatusChanged: (cb) => {
    const listener = (_e: unknown, s: TelegramStatus): void => cb(s)
    ipcRenderer.on(IPC.TelegramStatusChanged, listener)
    return () => ipcRenderer.removeListener(IPC.TelegramStatusChanged, listener)
  },
  onCompressStatus: (cb) => {
    const listener = (_e: unknown, payload: CompressStatusPayload): void => cb(payload)
    ipcRenderer.on(IPC.AgentCompressStatus, listener)
    return () => ipcRenderer.removeListener(IPC.AgentCompressStatus, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
