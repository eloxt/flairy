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
    dismissAnnouncement: 'Dismiss',
    imageCount_one: '📎 {{count}} image',
    imageCount_other: '📎 {{count}} images',
    toolRunning: 'Running {{tool}}…',
    toolDone: 'done',
    queued: 'Queued — will steer the running task',
    openImage: 'Open image',
    imagesIgnored: "Not seen — this model can't read images",
    working: 'Working…',
    running: 'Running',
    reasoning: 'Reasoning',
    reasoningLive: 'Reasoning…',
    error: 'Error'
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
    ask_one: 'asked you 1 question',
    ask_other: 'asked you {{count}} questions',
    web_search_one: 'searched the web once',
    web_search_other: 'searched the web {{count}}×',
    other_one: 'used 1 tool',
    other_other: 'used {{count}} tools',
    separator: ', '
  },
  onboarding: {
    cwdTitle: 'Set your working folder',
    cwdBody:
      'Pick the folder Flairy may read and change — use the folder button below.',
    permTitle: 'Choose how Flairy acts',
    permBody:
      'Have Flairy ask before each step, or give it full access — set it with the shield button below.',
    dismiss: 'Got it'
  },
  approval: {
    allowThisAction: 'Allow this action?',
    wantsTo: 'The assistant wants to {{tool}}',
    details: 'Details',
    deny: 'Deny',
    allowOnce: 'Allow once',
    allowSession: 'Allow for this session'
  },
  question: {
    title: 'A quick question',
    other: 'Type your own answer…',
    submit: 'Submit'
  },
  composer: {
    placeholder: 'Ask Flairy to do something…',
    addImage: 'Add image',
    imageUnsupported: "The current model can't read images",
    imagesIgnored:
      "The current model can't read images, so attached pictures will be ignored.",
    removeAttachment: 'Remove attachment',
    workingDirectory: 'Working directory',
    workingDirectoryTitle: 'Working directory: {{path}}',
    home: 'home',
    recent: 'Recent',
    recentDirTitle: '{{path}}\nRight-click to remove from recents',
    addAnotherDirectory: 'Add another directory…',
    toolPermission: 'Tool permission',
    fullAccess: 'Full access',
    askForApproval: 'Ask for approval',
    askDescription:
      'Flairy pauses for your confirmation before running tools that change files or run commands.',
    fullDescription:
      'Flairy runs every tool automatically without asking. Only use this when you trust the task.',
    stop: 'Stop',
    send: 'Send',
    steer: 'Send (steer the running task)'
  },
  settings: {
    title: 'Settings',
    // Tabs
    tabProfile: 'Profile',
    tabInterface: 'Interface',
    tabMemory: 'Memory',
    tabAbout: 'About',
    // Profile tab
    account: 'Account',
    name: 'Name',
    email: 'Email',
    signedIn: 'Signed in',
    signOut: 'Sign out',
    // Interface tab
    language: 'Language',
    languageDescription: 'Choose the display language.',
    // Memory tab
    memory: 'What Flairy remembers',
    memoryDescription:
      'Flairy remembers helpful things about you as you chat, so you don’t have to repeat yourself. You can forget any of them here.',
    memoryEmpty: 'Flairy hasn’t remembered anything about you yet.',
    memoryForget: 'Forget',
    memoryClearAll: 'Forget everything',
    memoryClearConfirm: 'Yes, forget everything',
    cancel: 'Cancel',
    // About tab
    about: 'About',
    appTagline: 'Your AI assistant that just works.',
    version: 'Version',
    troubleshooting: 'Troubleshooting',
    troubleshootingDescription:
      "Technical details for support. You normally don't need to open this.",
    showConfig: 'Configuration details',
    loadingConfig: 'Loading…',
    noConfig: 'No configuration received from the server yet.'
  },
  update: {
    available: 'Update available',
    tooltip: 'Version {{version}} is available — click to download'
  },
  tools: {
    read: 'read a file',
    write: 'write a file',
    edit: 'edit a file',
    bash: 'run a command',
    grep: 'search file contents',
    find: 'find files',
    ls: 'list files',
    ask: 'ask you a question',
    web_search: 'search the web',
    fallback: 'use a tool'
  },
  citations: {
    sources: 'Sources'
  }
}

export default en
