/**
 * Simplified Chinese catalog. Must satisfy the exact shape of `en` (the shape
 * authority) — `typeof En` enforces that every key exists with the same type.
 * Strings already authored in Chinese in the codebase are reused verbatim;
 * the originally-English ones are translated.
 */
import type En from './en'

const zhCN: typeof En = {
  common: {
    settings: '设置'
  },
  auth: {
    signInToContinue: '登录以继续',
    createYourAccount: '创建你的账户',
    signIn: '登录',
    register: '注册',
    name: '姓名',
    namePlaceholder: '你的姓名',
    email: '邮箱',
    emailPlaceholder: 'you@example.com',
    password: '密码',
    passwordPlaceholder: '••••••••',
    pleaseWait: '请稍候…',
    createAccount: '创建账户'
  },
  chat: {
    newChat: '新对话',
    search: '搜索',
    searchPlaceholder: '搜索对话和消息…',
    searchTitle: '搜索',
    searchEmptyHint: '在所有对话和消息中搜索。',
    noResults: '没有找到结果',
    resultCount_one: '{{count}} 条结果',
    resultCount_other: '{{count}} 条结果',
    history: '历史',
    chatsWillAppearHere: '你的对话会显示在这里',
    untitled: '未命名对话',
    deleteTitle: '删除这个对话？',
    deleteDescription: '此操作无法撤销，对话及其消息会被永久删除。',
    cancel: '取消',
    delete: '删除',
    rename: '重命名对话',
    emptyTitle: '有什么可以帮你的？',
    emptySubtitle: '用平常的话说就行，剩下的交给 Flairy。',
    dismissAnnouncement: '关闭',
    imageCount_one: '📎 {{count}} 张图片',
    imageCount_other: '📎 {{count}} 张图片',
    toolRunning: '正在{{tool}}…',
    toolDone: '完成',
    queued: '已加入队列 — 将引导正在进行的任务',
    openImage: '打开图片',
    imagesIgnored: '未被读取 — 当前模型无法识别图片',
    working: '处理中…',
    running: '运行中',
    reasoning: '思考过程',
    reasoningLive: '正在思考…',
    error: '出错了'
  },
  /** 右侧详情面板：对话时间线 + 花费汇总。 */
  panel: {
    toggle: '详情',
    timeline: '时间线',
    cost: '花费',
    timelineEmpty: '还没有任何活动。',
    costEmpty: '暂无用量数据。',
    totalCost: '总花费',
    totalTokens: '总 token',
    input: '输入',
    output: '输出',
    cache: '缓存',
    tokensSuffix: 'token'
  },
  activity: {
    read_one: '读取了 {{count}} 个文件',
    read_other: '读取了 {{count}} 个文件',
    write_one: '写入了 {{count}} 个文件',
    write_other: '写入了 {{count}} 个文件',
    edit_one: '修改了 {{count}} 处',
    edit_other: '修改了 {{count}} 处',
    bash_one: '执行了 {{count}} 个命令',
    bash_other: '执行了 {{count}} 个命令',
    grep_one: '搜索了 {{count}} 次',
    grep_other: '搜索了 {{count}} 次',
    find_one: '查找了 {{count}} 次文件',
    find_other: '查找了 {{count}} 次文件',
    ls_one: '列出了 {{count}} 个目录',
    ls_other: '列出了 {{count}} 个目录',
    ask_one: '问了你 {{count}} 个问题',
    ask_other: '问了你 {{count}} 个问题',
    web_search_one: '搜索了网络',
    web_search_other: '搜索了网络 {{count}} 次',
    other_one: '使用了 {{count}} 个工具',
    other_other: '使用了 {{count}} 个工具',
    separator: '、'
  },
  onboarding: {
    cwdTitle: '设置工作文件夹',
    cwdBody: '选择 Flairy 可以读取和修改的文件夹 — 点击下方的文件夹按钮。',
    permTitle: '选择 Flairy 的行事方式',
    permBody: '让 Flairy 每一步都先询问，或给予完全访问 — 点击下方的盾牌按钮设置。',
    dismiss: '知道了'
  },
  approval: {
    allowThisAction: '允许执行此操作？',
    wantsTo: '助手想要{{tool}}',
    details: '详情',
    deny: '拒绝',
    allowOnce: '允许一次',
    allowSession: '本次会话允许'
  },
  question: {
    title: '想问你一下',
    other: '输入你自己的答案…',
    submit: '提交'
  },
  composer: {
    placeholder: '让 Flairy 帮你做点什么…',
    addImage: '添加图片',
    imageUnsupported: '当前模型无法识别图片',
    imagesIgnored: '当前模型无法识别图片，发送时附带的图片会被忽略。',
    removeAttachment: '移除附件',
    workingDirectory: '工作目录',
    workingDirectoryTitle: '工作目录：{{path}}',
    home: '主目录',
    recent: '最近',
    recentDirTitle: '{{path}}\n右键从最近列表中移除',
    addAnotherDirectory: '添加其他目录…',
    toolPermission: '工具权限',
    fullAccess: '完全访问',
    askForApproval: '请求确认',
    askDescription: 'Flairy 在运行会修改文件或执行命令的工具前，会暂停等待你的确认。',
    fullDescription: 'Flairy 会自动运行每个工具而不询问。只在你信任该任务时使用。',
    stop: '停止',
    send: '发送',
    steer: '发送（引导正在进行的任务）'
  },
  settings: {
    title: '设置',
    // 标签页
    tabProfile: '个人信息',
    tabInterface: '界面',
    tabMemory: '记忆',
    tabAbout: '关于',
    // 个人信息
    account: '账户',
    name: '姓名',
    email: '邮箱',
    signedIn: '已登录',
    signOut: '退出登录',
    // 界面
    language: '语言',
    languageDescription: '选择显示语言。',
    // 记忆
    memory: 'Flairy 记住的内容',
    memoryDescription: 'Flairy 会在对话中记住关于你的有用信息，这样你不必重复说明。你可以在这里删除其中任意一条。',
    memoryEmpty: 'Flairy 还没有记住关于你的任何内容。',
    memoryForget: '删除',
    memoryClearAll: '清空全部',
    memoryClearConfirm: '确认清空全部',
    cancel: '取消',
    // 关于
    about: '关于',
    appTagline: '开箱即用的 AI 助手。',
    version: '版本',
    troubleshooting: '故障排查',
    troubleshootingDescription: '供技术支持使用的详细信息，通常你无需打开。',
    showConfig: '配置详情',
    loadingConfig: '加载中…',
    noConfig: '尚未从服务器收到任何配置。'
  },
  update: {
    available: '有可用更新',
    tooltip: '新版本 {{version}} 已发布 — 点击下载'
  },
  tools: {
    read: '读取文件',
    write: '写入文件',
    edit: '编辑文件',
    bash: '执行命令',
    grep: '搜索文件内容',
    find: '查找文件',
    ls: '列出文件',
    ask: '问你一个问题',
    web_search: '搜索网络',
    fallback: '工具'
  },
  citations: {
    sources: '来源'
  }
}

export default zhCN
