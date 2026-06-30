import { app } from "electron";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { initDb } from "./store/db";
import { registerIpcHandlers, disposeAllAgentServices } from "./ipc/handlers";
import { registerLocaleHandlers } from "./ipc/locale-handlers";
import { ServerClient } from "./sync/server-client";
import { McpManager } from "./agent/mcp";
import { UpdateManager } from "./update/update-checker";
import { createMainWindow, markQuitting, showMainWindow } from "./windows";
import { createTray, destroyTray } from "./tray";
import { buildAppMenu } from "./menu";

// Set the app name before `ready` so it propagates to the macOS menu, the
// userData path, and the name shown on desktop notifications (otherwise it
// defaults to "Electron").
app.setName("Flairy");

// Single-instance lock: now that Flairy can live in the tray with no window, a
// second launch must focus the existing instance instead of spawning a second
// process (which would double the agent loop, MCP connections, and the socket).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());

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
    // Polls GitHub for a newer release and badges the header when one exists.
    const updates = new UpdateManager();
    createMainWindow();
    registerIpcHandlers(server, mcp, updates);
    updates.start();
    createTray();

    app.on("activate", () => showMainWindow());

    // A real quit (tray Quit, app-menu Quit, Cmd+Q) runs the teardown that
    // otherwise never happens: abort + persist in-flight turns, close MCP
    // connections, and drop the server socket. markQuitting() lets the main
    // window actually close instead of hiding to the tray.
    app.on("before-quit", () => {
      markQuitting();
      disposeAllAgentServices();
      mcp.dispose();
      server.disconnect();
      destroyTray();
    });
  });
}

app.on("window-all-closed", () => {
  // With close-to-tray on, the main window only hides, so this never fires from
  // it. With the preference off it closes for real → quit on Windows/Linux
  // (macOS keeps the app alive in the tray, per platform convention).
  if (process.platform !== "darwin") app.quit();
});
