---
name: verify
description: Launch and drive the Flairy desktop (Electron) app to verify renderer/main changes end-to-end via CDP.
---

# Verifying the Flairy desktop app

## Launch with a CDP handle

A user dev instance is often already running (`pnpm dev`); it holds the single-instance
lock (userData "Flairy Dev") and Electron survives `electron-vite` being killed
(close-to-tray). Kill BOTH before relaunching:

```bash
pkill -f "electron-vite.js dev"; sleep 2
pgrep -fl "Electron ."          # the main Electron process has no user-data-dir in argv
kill <main-electron-pid>; sleep 2
cd apps/desktop && pnpm exec electron-vite dev -- --remote-debugging-port=9223   # run_in_background
```

The first relaunch sometimes exits cleanly (lock race with the dying instance) — just
relaunch. Ready when `curl -s http://127.0.0.1:9223/json` lists a `page` target.
When done: kill it and restore a detached plain `pnpm dev` for the user.

## Drive it

No playwright/puppeteer in the repo. Use the workspace's `ws` package directly:
`/…/node_modules/.pnpm/ws@8.21.0/node_modules/ws/index.js` (adjust version). A ~50-line
CDP driver (Runtime.evaluate with awaitPromise/returnByValue + Page.captureScreenshot)
is all you need; write it to the scratchpad.

Key facts:
- `window.api` (the full typed FlairyApi preload surface) is reachable from
  Runtime.evaluate — you can call IPC directly (createSession, listWorkspaceFiles, …)
  to set up state that native dialogs would otherwise block (directory picker).
- App may be in Chinese (zh-CN). Prefer `aria-label`/`data-slot` selectors over titles;
  the right-panel toggle is `button[aria-label=详情]` / `[aria-label=Details]`.
- The right details panel stays MOUNTED when closed (offcanvas translateX) — DOM queries
  succeed while nothing is visible. Check `aria-pressed` on the toggle / localStorage
  `flairy.rightPanelOpen` before trusting a screenshot.
- The file tree (`file-tree-container`) and diff/file previews render in OPEN shadow
  roots: `el.shadowRoot.querySelectorAll('[role=treeitem]')`; textContent of preview
  code lives in the shadow root, not the light DOM.
- Sessions sync from the server on launch — create a throwaway session for testing and
  `window.api.deleteSession({sessionId})` it afterwards.
- React 19: plain `el.click()` works for all buttons and tree rows.
