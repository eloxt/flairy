import { app, BrowserWindow } from "electron";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { initDb } from "./store/db";
import { registerIpcHandlers } from "./ipc/handlers";
import { registerLocaleHandlers } from "./ipc/locale-handlers";
import { ServerClient } from "./sync/server-client";
import { McpManager } from "./agent/mcp";
import { createMainWindow } from "./windows";
import { buildAppMenu } from "./menu";

// Set the app name before `ready` so it propagates to the macOS menu, the
// userData path, and the name shown on desktop notifications (otherwise it
// defaults to "Electron").
app.setName("Flairy");

app.whenReady().then(() => {
  electronApp.setAppUserModelId("com.eloxt.flairy");

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  initDb();
  // buildAppMenu() now resolves labels via the localized t(), which reads the
  // saved language from SQLite — so it must run after initDb(), not before.
  buildAppMenu();
  // Must precede createMainWindow(): the renderer reads the language synchronously
  // before first paint, so the SettingsGetLanguage channel has to exist first.
  registerLocaleHandlers();
  const server = new ServerClient();
  // Process-level singleton: reconcile MCP connections against every pushed
  // config snapshot/delta. onConfig fires immediately if a cached config exists.
  const mcp = new McpManager();
  server.onConfig((config) => mcp.sync(config.mcpServers));
  createMainWindow();
  registerIpcHandlers(server, mcp);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
