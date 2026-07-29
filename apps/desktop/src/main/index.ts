import { app } from "electron";
import { electronApp, optimizer } from "@electron-toolkit/utils";
import { initDb } from "./store/db";
import { initProfile } from "./store/profile";
import { getAuthUser, migrateDeviceSecretsToProfile } from "./store/secrets";
import {
  registerImageProtocol,
  registerImageProtocolPrivileges,
} from "./store/image-store";
import { scheduleImageSweep } from "./store/image-gc";
import { registerIpcHandlers } from "./ipc/handlers";
import { registerLocaleHandlers } from "./ipc/locale-handlers";
import { registerTelegramHandlers } from "./ipc/telegram-handlers";
import { registerGithubHandlers } from "./ipc/github-handlers";
import { registerWorkerRunHandlers } from "./ipc/worker-run-handlers";
import { registerAcpHandlers } from "./ipc/acp-handlers";
import { initDispatch, workers } from "./acp/dispatch";
import { initScheduler, stopScheduler } from "./schedule/scheduler";
import { sweepOldTranscripts } from "./acp/transcript";
import { failOrphanWorkerRuns } from "./store/db";
import { registerFsHandlers } from "./ipc/fs-handlers";
import { ServerClient } from "./sync/server-client";
import { buildSessionUpsertPayload } from "./sync/session-payload";
import { McpManager } from "./agent/mcp";
import { AgentManager } from "./agent/agent-manager";
import { TelegramManager } from "./telegram/telegram-manager";
import { UpdateManager } from "./update";
import { createMainWindow, markQuitting, showMainWindow } from "./windows";
import { syncLauncherShortcut, unregisterShortcuts } from "./shortcuts";
import { createTray, destroyTray } from "./tray";
import { buildAppMenu } from "./menu";

// Set the app name before `ready` so it propagates to the macOS menu, the
// userData path, and the name shown on desktop notifications (otherwise it
// defaults to "Electron"). In dev we suffix the name so the userData path
// diverges from the installed build — otherwise both point at the same
// ~/Library/Application Support/Flairy dir and the SQLite db, secrets, and
// config get tangled between dev and production. Separate dirs also give each
// its own single-instance lock, so dev and prod can run side by side.
app.setName(app.isPackaged ? "Flairy" : "Flairy Dev");

// Single-instance lock: now that Flairy can live in the tray with no window, a
// second launch must focus the existing instance instead of spawning a second
// process (which would double the agent loop, MCP connections, and the socket).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());

  // Must run before `ready` (Electron requirement): grants the flairy-img://
  // image scheme fetch/stream semantics; the handler itself registers below.
  registerImageProtocolPrivileges();

  app.whenReady().then(() => {
    electronApp.setAppUserModelId("com.eloxt.flairy");

    app.on("browser-window-created", (_, window) => {
      optimizer.watchWindowShortcuts(window);
    });

    // Resolve the per-account storage profile BEFORE anything touches storage:
    // db, image store, skills, transcripts, and integration secrets all live
    // under profiles/<userId> (or profiles/local when signed out). Auth changes
    // relaunch the process, so this is decided exactly once per run.
    initProfile(getAuthUser()?.id ?? null);
    migrateDeviceSecretsToProfile();
    initDb();
    // Serve stored chat images to the renderers (flairy-img://<hash>.<ext>).
    registerImageProtocol();
    // buildAppMenu() now resolves labels via the localized t(), which reads the
    // saved language from SQLite — so it must run after initDb(), not before.
    buildAppMenu();
    // Must precede createMainWindow(): the renderer reads the language synchronously
    // before first paint, so the SettingsGetLanguage channel has to exist first.
    registerLocaleHandlers();
    const server = new ServerClient();
    // Offline-dirty sessions are re-snapshotted from SQLite when the socket
    // comes back (see ServerClient's outbox) — inject the builder here to keep
    // db access out of the sync layer's constructor.
    server.setSessionPayloadProvider(buildSessionUpsertPayload);
    // Process-level singleton: reconcile MCP connections against every pushed
    // config snapshot/delta. onConfig fires immediately if a cached config exists.
    const mcp = new McpManager();
    server.onConfig((config) => mcp.sync(config.mcpServers));
    // Process-level owner of the per-session agent services, lifted out of the IPC
    // layer so every front-end (desktop now, Telegram later) drives sessions
    // through one seam.
    const agents = new AgentManager(server, mcp);
    // ACP worker dispatch (dispatch_task tool) reports back through the agent
    // manager; runs left 'running' by a previous process are orphans — repair
    // them before any window can list runs.
    initDispatch(agents);
    failOrphanWorkerRuns();
    // Telegram remote-chat front-end onto the same session runtime. Registers its
    // interaction channel + outbound bus subscriber on construction; auto-starts
    // below only if a stored token + enabled binding already exist.
    const telegram = new TelegramManager(server, agents);
    // Scheduled tasks (schedule tool): croner jobs + missed-run catch-up +
    // completion reminders. Needs the DB (task rows) and all three managers.
    initScheduler(agents, server, telegram);
    // Watches for newer releases and badges the header. On packaged Windows it
    // also downloads and installs them in place; elsewhere it just links out.
    const updates = new UpdateManager();
    createMainWindow();
    registerIpcHandlers(server, updates, agents);
    registerTelegramHandlers(telegram);
    registerGithubHandlers();
    registerWorkerRunHandlers();
    registerAcpHandlers();
    registerFsHandlers();
    telegram.maybeAutoStart();
    updates.start();
    createTray();
    // Register the quick-launcher summon chord (reads the saved preference, so
    // it must run after initDb()).
    syncLauncherShortcut();
    // Reclaim image files orphaned since the last run (deleted sessions,
    // remotely rewritten history). Deferred well past startup so it never
    // competes with first paint / session pull.
    scheduleImageSweep(60_000);
    // Same idea for worker transcripts: reclaim logs past the retention window,
    // deferred well past startup.
    setTimeout(() => sweepOldTranscripts(), 90_000).unref();

    app.on("activate", () => showMainWindow());

    // A real quit (tray Quit, app-menu Quit, Cmd+Q) runs the teardown that
    // otherwise never happens: abort + persist in-flight turns, close MCP
    // connections, and drop the server socket. markQuitting() lets the main
    // window actually close instead of hiding to the tray.
    app.on("before-quit", () => {
      markQuitting();
      updates.stop();
      stopScheduler();
      void telegram.stop();
      workers.disposeAll();
      agents.disposeAll();
      mcp.dispose();
      server.disconnect();
      destroyTray();
      unregisterShortcuts();
    });
  });
}

app.on("window-all-closed", () => {
  // With close-to-tray on, the main window only hides, so this never fires from
  // it. With the preference off it closes for real → quit on Windows/Linux
  // (macOS keeps the app alive in the tray, per platform convention).
  if (process.platform !== "darwin") app.quit();
});
