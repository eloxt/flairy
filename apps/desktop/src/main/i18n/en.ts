/**
 * Main-process (native) English strings. Only the handful of user-facing strings
 * the main process produces directly — the approval notification, the default
 * title for new sessions, and the native menu labels. The renderer has its own,
 * much larger catalog under `renderer/src/i18n`.
 *
 * Flat dot-keys; resolved by `t()` in `../locale`. `zh-CN.ts` mirrors this shape.
 */
export const en = {
  notificationTitle: 'Flairy needs your confirmation',
  questionNotificationTitle: 'Flairy has a question for you',
  defaultSessionTitle: 'New session',
  scheduleDoneTitle: 'Flairy finished a task for you',
  scheduleFailedBody: 'Something went wrong — open the conversation for details.',
  'schedule.deleteTitle': 'Delete this conversation?',
  'schedule.deleteWithTasks': 'This conversation has {count} recurring task(s) set up. Deleting it also removes them.',
  'schedule.deleteConfirm': 'Delete',
  'schedule.deleteCancel': 'Cancel',
  'menu.file': 'File',
  'menu.edit': 'Edit',
  'menu.view': 'View',
  'menu.window': 'Window',
  'menu.help': 'Help',
  'menu.renameChat': 'Rename',
  'menu.deleteChat': 'Delete',
  'menu.selectChats': 'Select chats',
  'menu.removeRecentDir': 'Remove from recents',
  'tray.open': 'Open Main Window',
  'tray.quickAsk': 'Quick Ask',
  'tray.quit': 'Quit Flairy'
} as const

export type MainCatalog = Record<keyof typeof en, string>
