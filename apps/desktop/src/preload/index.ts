import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppLanguage,
  type ChatWidth,
  type ConfigMode,
  type FlairyApi,
  type AgentEventEnvelope,
  type ApprovalRequestPayload,
  type CompressStatusPayload,
  type LauncherShownPayload,
  type QuestionRequestPayload,
  type RedactedConfigSnapshot,
  type SessionMeta,
  type SessionTitleUpdatedPayload,
  type SocketConnectionStatus,
  type TelegramStatus,
  type UpdateState
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
  showLauncher: () => ipcRenderer.invoke(IPC.LauncherShow),
  hideLauncher: () => ipcRenderer.invoke(IPC.LauncherHide),
  resizeLauncher: (height) => ipcRenderer.invoke(IPC.LauncherResize, height),
  openLauncherSessionInMain: (sessionId) =>
    ipcRenderer.invoke(IPC.LauncherOpenInMain, sessionId),
  takePendingLauncherSession: () => ipcRenderer.invoke(IPC.LauncherTakePendingSession),
  getLauncherShortcut: () => ipcRenderer.invoke(IPC.SettingsGetLauncherShortcut),
  setLauncherShortcut: (accelerator) =>
    ipcRenderer.invoke(IPC.SettingsSetLauncherShortcut, accelerator),
  growWindowWidth: (delta) => ipcRenderer.invoke(IPC.WindowGrowWidth, delta),
  openExternal: (url) => ipcRenderer.invoke(IPC.ShellOpenExternal, url),
  openImageViewer: (image) => ipcRenderer.invoke(IPC.ImageViewerOpen, image),
  getViewerImage: (id) => ipcRenderer.invoke(IPC.ImageViewerGet, id),
  getAppVersion: () => ipcRenderer.sendSync(IPC.AppGetVersion) as string,
  getUpdateState: () => ipcRenderer.invoke(IPC.UpdateGetState),
  openReleasePage: () => ipcRenderer.invoke(IPC.UpdateOpenRelease),
  downloadUpdate: () => ipcRenderer.invoke(IPC.UpdateDownload),
  installUpdate: () => ipcRenderer.invoke(IPC.UpdateInstall),
  platform: process.platform,
  getInitialLanguage: () => ipcRenderer.sendSync(IPC.SettingsGetLanguage) as AppLanguage,
  setLanguage: (lng) => ipcRenderer.invoke(IPC.SettingsSetLanguage, lng),
  getCloseToTray: () => ipcRenderer.invoke(IPC.SettingsGetCloseToTray),
  setCloseToTray: (v) => ipcRenderer.invoke(IPC.SettingsSetCloseToTray, v),
  getChatWidth: () => ipcRenderer.invoke(IPC.SettingsGetChatWidth),
  setChatWidth: (w) => ipcRenderer.invoke(IPC.SettingsSetChatWidth, w),
  getPreferredMainModel: () => ipcRenderer.invoke(IPC.SettingsGetPreferredModel),
  setPreferredMainModel: (id) => ipcRenderer.invoke(IPC.SettingsSetPreferredModel, id),
  getAdvancedUnlocked: () => ipcRenderer.invoke(IPC.AdvancedGetUnlocked),
  setAdvancedUnlocked: (v) => ipcRenderer.invoke(IPC.AdvancedSetUnlocked, v),
  getConfigMode: () => ipcRenderer.invoke(IPC.ConfigGetMode),
  setConfigMode: (mode) => ipcRenderer.invoke(IPC.ConfigSetMode, mode),
  getLocalConfig: () => ipcRenderer.invoke(IPC.LocalConfigGet),
  saveLocalConfig: (draft) => ipcRenderer.invoke(IPC.LocalConfigSave, draft),

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
  onPreferredMainModelChanged: (cb) => {
    const listener = (_e: unknown, id: string | null): void => cb(id)
    ipcRenderer.on(IPC.PreferredModelChanged, listener)
    return () => ipcRenderer.removeListener(IPC.PreferredModelChanged, listener)
  },
  onAdvancedUnlockedChanged: (cb) => {
    const listener = (_e: unknown, unlocked: boolean): void => cb(unlocked)
    ipcRenderer.on(IPC.AdvancedUnlockedChanged, listener)
    return () => ipcRenderer.removeListener(IPC.AdvancedUnlockedChanged, listener)
  },
  onConfigModeChanged: (cb) => {
    const listener = (_e: unknown, mode: ConfigMode): void => cb(mode)
    ipcRenderer.on(IPC.ConfigModeChanged, listener)
    return () => ipcRenderer.removeListener(IPC.ConfigModeChanged, listener)
  },
  onUpdateState: (cb) => {
    const listener = (_e: unknown, state: UpdateState): void => cb(state)
    ipcRenderer.on(IPC.UpdateStateChanged, listener)
    return () => ipcRenderer.removeListener(IPC.UpdateStateChanged, listener)
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
  },
  onLauncherShown: (cb) => {
    const listener = (_e: unknown, payload: LauncherShownPayload): void => cb(payload)
    ipcRenderer.on(IPC.LauncherShown, listener)
    return () => ipcRenderer.removeListener(IPC.LauncherShown, listener)
  },
  onLauncherOpenSession: (cb) => {
    const listener = (_e: unknown, meta: SessionMeta): void => cb(meta)
    ipcRenderer.on(IPC.LauncherOpenSession, listener)
    return () => ipcRenderer.removeListener(IPC.LauncherOpenSession, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
