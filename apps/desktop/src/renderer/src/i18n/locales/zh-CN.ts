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
    imageCount_one: '📎 {{count}} 张图片',
    imageCount_other: '📎 {{count}} 张图片',
    toolRunning: '正在{{tool}}…',
    toolDone: '完成',
    working: '处理中…',
    reasoning: '思考过程',
    reasoningLive: '正在思考…'
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
    other_one: '使用了 {{count}} 个工具',
    other_other: '使用了 {{count}} 个工具',
    separator: '、'
  },
  approval: {
    allowThisAction: '允许执行此操作？',
    wantsTo: '助手想要{{tool}}',
    details: '详情',
    deny: '拒绝',
    allowOnce: '允许一次',
    allowSession: '本次会话允许'
  },
  composer: {
    placeholder: '让 Flairy 帮你做点什么…',
    addImage: '添加图片',
    removeAttachment: '移除附件',
    workingDirectory: '工作目录',
    workingDirectoryTitle: '工作目录：{{path}}',
    home: '主目录',
    recent: '最近',
    addAnotherDirectory: '添加其他目录…',
    toolPermission: '工具权限',
    fullAccess: '完全访问',
    askForApproval: '请求确认',
    askDescription: 'Flairy 在运行会修改文件或执行命令的工具前，会暂停等待你的确认。',
    fullDescription: 'Flairy 会自动运行每个工具而不询问。只在你信任该任务时使用。',
    stop: '停止',
    send: '发送'
  },
  settings: {
    title: '设置',
    debug: '调试',
    serverConfiguration: '服务器配置',
    serverConfigurationDescription: '只读查看服务器下发到此设备的内容。密钥已被遮蔽。',
    loading: '加载中…',
    noConfig: '尚未从服务器收到任何配置。',
    overview: '概览',
    configVersion: '配置版本',
    mcpServers: 'MCP 服务器',
    skills: '技能',
    languageModels: '语言模型',
    mainModel: '主模型',
    toolModel: '工具模型',
    notSet: '未设置',
    provider: '提供方',
    vendor: '厂商',
    baseUrl: 'Base URL',
    credential: '凭证',
    none: '无。',
    enabled: '已启用',
    disabled: '已禁用',
    rawPayload: '原始负载',
    showJson: '显示 JSON',
    account: '账户',
    signedIn: '已登录',
    signOut: '退出登录',
    fileCount_one: '{{count}} 个文件',
    fileCount_other: '{{count}} 个文件',
    language: '语言',
    languageDescription: '选择显示语言。'
  },
  tools: {
    read: '读取文件',
    write: '写入文件',
    edit: '编辑文件',
    bash: '执行命令',
    grep: '搜索文件内容',
    find: '查找文件',
    ls: '列出文件',
    fallback: '工具'
  }
}

export default zhCN
