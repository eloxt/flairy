import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type AppLanguage,
  type FlairyApi,
  type AgentEventEnvelope,
  type ApprovalRequestPayload,
  type RedactedConfigSnapshot,
  type SessionTitleUpdatedPayload
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
  setPermissionMode: (args) => ipcRenderer.invoke(IPC.AgentSetPermissionMode, args),
  listSessions: () => ipcRenderer.invoke(IPC.SessionList),
  loadSession: (sessionId) => ipcRenderer.invoke(IPC.SessionLoad, sessionId),
  searchMessages: (args) => ipcRenderer.invoke(IPC.SearchMessages, args),
  createSession: (args) => ipcRenderer.invoke(IPC.SessionCreate, args),
  setWorkingDirectory: (args) => ipcRenderer.invoke(IPC.SessionSetCwd, args),
  listRecentDirectories: () => ipcRenderer.invoke(IPC.SessionListRecentDirs),
  chooseDirectory: (args) => ipcRenderer.invoke(IPC.SessionChooseDir, args),
  renameSession: (args) => ipcRenderer.invoke(IPC.SessionRename, args),
  deleteSession: (args) => ipcRenderer.invoke(IPC.SessionDelete, args),
  showSessionMenu: () => ipcRenderer.invoke(IPC.SessionContextMenu),
  pickDirectory: () => ipcRenderer.invoke(IPC.DialogPickDirectory),
  setSecret: (args) => ipcRenderer.invoke(IPC.SecretsSet, args),
  hasSecret: (provider) => ipcRenderer.invoke(IPC.SecretsHas, provider),
  login: (args) => ipcRenderer.invoke(IPC.AuthLogin, args),
  register: (args) => ipcRenderer.invoke(IPC.AuthRegister, args),
  logout: () => ipcRenderer.invoke(IPC.AuthLogout),
  authStatus: () => ipcRenderer.invoke(IPC.AuthStatus),
  getConfig: () => ipcRenderer.invoke(IPC.ConfigGet),
  openSettings: () => ipcRenderer.invoke(IPC.WindowOpenSettings),
  getInitialLanguage: () => ipcRenderer.sendSync(IPC.SettingsGetLanguage) as AppLanguage,
  setLanguage: (lng) => ipcRenderer.invoke(IPC.SettingsSetLanguage, lng),

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
  onConfigChanged: (cb) => {
    const listener = (_e: unknown, config: RedactedConfigSnapshot): void => cb(config)
    ipcRenderer.on(IPC.ConfigChanged, listener)
    return () => ipcRenderer.removeListener(IPC.ConfigChanged, listener)
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
  onLanguageChanged: (cb) => {
    const listener = (_e: unknown, lng: AppLanguage): void => cb(lng)
    ipcRenderer.on(IPC.LanguageChanged, listener)
    return () => ipcRenderer.removeListener(IPC.LanguageChanged, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
