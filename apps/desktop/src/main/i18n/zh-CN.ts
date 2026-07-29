import type { MainCatalog } from './en'

/** Main-process (native) Simplified Chinese strings — mirrors `./en`'s shape. */
export const zhCN: MainCatalog = {
  notificationTitle: 'Flairy 需要你的确认',
  questionNotificationTitle: 'Flairy 有个问题想问你',
  defaultSessionTitle: '新对话',
  scheduleDoneTitle: 'Flairy 帮你完成了一项任务',
  scheduleFailedBody: '出了点问题——打开对话查看详情。',
  'schedule.deleteTitle': '删除这个对话？',
  'schedule.deleteWithTasks': '这个对话设置了 {count} 个定时任务，删除对话会一并移除它们。',
  'schedule.deleteConfirm': '删除',
  'schedule.deleteCancel': '取消',
  'menu.file': '文件',
  'menu.edit': '编辑',
  'menu.view': '视图',
  'menu.window': '窗口',
  'menu.help': '帮助',
  'menu.renameChat': '重命名',
  'menu.deleteChat': '删除',
  'menu.selectChats': '选择多个对话',
  'menu.removeRecentDir': '从最近列表中移除',
  'tray.open': '打开主窗口',
  'tray.quickAsk': '快速提问',
  'tray.quit': '退出 Flairy'
}
