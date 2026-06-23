/**
 * English catalog — the SHAPE AUTHORITY for the renderer i18n.
 *
 * `en` defines the catalog type via `typeof en`; `zh-CN` must satisfy it, so
 * every key here must have a zh-CN counterpart (and vice versa). Namespaces are
 * the top-level keys (`common`, `auth`, `chat`, `approval`, `composer`,
 * `settings`, `tools`). Keep tool labels as bare verb phrases so the
 * `approval.wantsTo` / `chat.toolRunning` sentence templates read grammatically.
 */
const en = {
  common: {
    settings: 'Settings'
  },
  auth: {
    signInToContinue: 'Sign in to continue',
    createYourAccount: 'Create your account',
    signIn: 'Sign in',
    register: 'Register',
    name: 'Name',
    namePlaceholder: 'Your name',
    email: 'Email',
    emailPlaceholder: 'you@example.com',
    password: 'Password',
    passwordPlaceholder: '••••••••',
    pleaseWait: 'Please wait…',
    createAccount: 'Create account'
  },
  chat: {
    newChat: 'New chat',
    search: 'Search',
    searchPlaceholder: 'Search chats and messages…',
    searchTitle: 'Search',
    searchEmptyHint: 'Search across all your chats and messages.',
    noResults: 'No results found',
    resultCount_one: '{{count}} result',
    resultCount_other: '{{count}} results',
    history: 'History',
    chatsWillAppearHere: 'Your chats will appear here',
    untitled: 'Untitled chat',
    deleteTitle: 'Delete this chat?',
    deleteDescription:
      'This action cannot be undone. The chat and its messages will be permanently deleted.',
    cancel: 'Cancel',
    delete: 'Delete',
    rename: 'Rename chat',
    emptyTitle: 'What can I help you with?',
    emptySubtitle: 'Ask in plain words. Flairy handles the rest.',
    imageCount_one: '📎 {{count}} image',
    imageCount_other: '📎 {{count}} images',
    toolRunning: 'Running {{tool}}…',
    toolDone: 'done',
    working: 'Working…',
    reasoning: 'Reasoning',
    reasoningLive: 'Reasoning…'
  },
  /**
   * Aggregated, jargon-free summary clauses for a grouped run of tool calls
   * (e.g. "Read 3 files, ran 2 commands"). One stem per `toolBucket`; i18next
   * selects `_one` / `_other` by count. Clauses are lowercase verb phrases so
   * they join cleanly; the renderer capitalizes the first letter of the join.
   */
  activity: {
    read_one: 'read 1 file',
    read_other: 'read {{count}} files',
    write_one: 'wrote 1 file',
    write_other: 'wrote {{count}} files',
    edit_one: 'made 1 edit',
    edit_other: 'made {{count}} edits',
    bash_one: 'ran 1 command',
    bash_other: 'ran {{count}} commands',
    grep_one: 'ran 1 search',
    grep_other: 'ran {{count}} searches',
    find_one: 'searched files once',
    find_other: 'searched files {{count}}×',
    ls_one: 'listed 1 folder',
    ls_other: 'listed {{count}} folders',
    other_one: 'used 1 tool',
    other_other: 'used {{count}} tools',
    separator: ', '
  },
  approval: {
    allowThisAction: 'Allow this action?',
    wantsTo: 'The assistant wants to {{tool}}',
    details: 'Details',
    deny: 'Deny',
    allowOnce: 'Allow once',
    allowSession: 'Allow for this session'
  },
  composer: {
    placeholder: 'Ask Flairy to do something…',
    addImage: 'Add image',
    removeAttachment: 'Remove attachment',
    workingDirectory: 'Working directory',
    workingDirectoryTitle: 'Working directory: {{path}}',
    home: 'home',
    recent: 'Recent',
    addAnotherDirectory: 'Add another directory…',
    toolPermission: 'Tool permission',
    fullAccess: 'Full access',
    askForApproval: 'Ask for approval',
    askDescription:
      'Flairy pauses for your confirmation before running tools that change files or run commands.',
    fullDescription:
      'Flairy runs every tool automatically without asking. Only use this when you trust the task.',
    stop: 'Stop',
    send: 'Send'
  },
  settings: {
    title: 'Settings',
    debug: 'Debug',
    serverConfiguration: 'Server configuration',
    serverConfigurationDescription:
      'Read-only view of what the server delivered to this device. Secrets are masked.',
    loading: 'Loading…',
    noConfig: 'No configuration received from the server yet.',
    overview: 'Overview',
    configVersion: 'Config version',
    mcpServers: 'MCP servers',
    skills: 'Skills',
    languageModels: 'Language models',
    mainModel: 'Main model',
    toolModel: 'Tool model',
    notSet: 'Not set',
    provider: 'Provider',
    vendor: 'Vendor',
    baseUrl: 'Base URL',
    credential: 'Credential',
    none: 'None.',
    enabled: 'Enabled',
    disabled: 'Disabled',
    rawPayload: 'Raw payload',
    showJson: 'Show JSON',
    account: 'Account',
    signedIn: 'Signed in',
    signOut: 'Sign out',
    fileCount_one: '{{count}} file',
    fileCount_other: '{{count}} files',
    language: 'Language',
    languageDescription: 'Choose the display language.'
  },
  tools: {
    read: 'read a file',
    write: 'write a file',
    edit: 'edit a file',
    bash: 'run a command',
    grep: 'search file contents',
    find: 'find files',
    ls: 'list files',
    fallback: 'use a tool'
  }
}

export default en
