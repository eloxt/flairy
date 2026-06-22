import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { t } from "./locale";

/**
 * Application menu. Electron's default menu ships a populated Help submenu
 * (a search field + "<App> Help" pointing at electronjs.org). We rebuild the
 * standard macOS menu from role-based items so every submenu keeps its native
 * behavior, but leave the Help submenu empty.
 *
 * The Help submenu deliberately omits `role: "help"` — that role makes AppKit
 * inject the macOS Help search field, which would re-populate the menu.
 */
export function buildAppMenu(): void {
  const isMac = process.platform === "darwin";

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    {
      label: t("menu.file"),
      submenu: [isMac ? { role: "close" } : { role: "quit" }],
    },
    {
      label: t("menu.edit"),
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? ([
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
              { role: "selectAll" },
            ] as MenuItemConstructorOptions[])
          : ([
              { role: "delete" },
              { type: "separator" },
              { role: "selectAll" },
            ] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: t("menu.view"),
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: t("menu.window"),
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? ([
              { type: "separator" },
              { role: "front" },
              { type: "separator" },
              { role: "window" },
            ] as MenuItemConstructorOptions[])
          : ([{ role: "close" }] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: t("menu.help"),
      submenu: [],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
