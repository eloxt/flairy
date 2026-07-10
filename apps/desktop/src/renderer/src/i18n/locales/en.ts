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
    newInProject: 'New chat in {{project}}',
    search: 'Search',
    searchPlaceholder: 'Search chats and messages…',
    searchTitle: 'Search',
    searchEmptyHint: 'Search across all your chats and messages.',
    noResults: 'No results found',
    resultCount_one: '{{count}} result',
    resultCount_other: '{{count}} results',
    projects: 'Projects',
    chats: 'Chats',
    chatsWillAppearHere: 'Your chats will appear here',
    untitled: 'Untitled chat',
    fromTelegram: 'From Telegram',
    deleteTitle: 'Delete this chat?',
    deleteDescription:
      'This action cannot be undone. The chat and its messages will be permanently deleted.',
    deleteSelectedTitle: 'Delete selected chats?',
    deleteSelectedDescription:
      'This action cannot be undone. The selected chats and their messages will be permanently deleted.',
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
    planUpdated: 'Updated the task plan — see the Plan tab.',
    queued: 'Queued — will steer the running task',
    openImage: 'Open image',
    imagesIgnored: "Not seen — this model can't read images",
    working: 'Working…',
    processDone: 'Finished working',
    running: 'Running',
    reasoning: 'Thinking...',
    reasoningLive: 'Thinking...',
    compressingContext: 'Summarizing earlier messages...',
    retrying: 'Connection hiccup — retrying ({{attempt}}/{{max}})...',
    error: 'Error',
    copy: 'Copy',
    copied: 'Copied'
  },
  /** Right-side details panel: timeline of the conversation + model info. */
  panel: {
    toggle: 'Details',
    timeline: 'Timeline',
    model: 'Model',
    plan: 'Plan',
    timelineEmpty: 'Nothing has happened yet.',
    modelEmpty: 'No model configured.',
    planEmpty: 'No tasks yet.',
    files: 'Files',
    filesEmpty: 'No files in this workspace yet.',
    filesTruncated: 'Showing the first {{count}} files.',
    filesBack: 'Back to files',
    filesLoading: 'Loading...',
    filesError: 'Could not load the file list.',
    fileBinary: 'This file cannot be previewed.',
    fileTooLarge: 'Too large to preview ({{size}}).',
    fileError: 'Could not read this file.',
    contextUsed: 'Conversation size',
    compressContext: 'Summarize earlier messages',
    compressingContext: 'Summarizing...',
    maxOutput: 'Max output',
    thinking: 'Thinking',
    inputs: 'Inputs',
    pricing: 'Pricing',
    perMillion: 'per 1M tokens',
    noUsage: 'No usage yet.',
    notSet: 'Default',
    totalCost: 'Total cost',
    input: 'Input',
    output: 'Output',
    cache: 'Cache',
    tokensSuffix: 'tokens'
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
    find_one: 'ran 1 file search',
    find_other: 'ran {{count}} file searches',
    ls_one: 'listed 1 folder',
    ls_other: 'listed {{count}} folders',
    ask_one: 'asked you 1 question',
    ask_other: 'asked you {{count}} questions',
    web_search_one: 'ran 1 web search',
    web_search_other: 'ran {{count}} web searches',
    web_fetch_one: 'fetched 1 web page',
    web_fetch_other: 'fetched {{count}} web pages',
    todo_write_one: 'made 1 plan update',
    todo_write_other: 'made {{count}} plan updates',
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
    multi: 'Choose all that apply',
    back: 'Back',
    next: 'Next',
    other: 'Type your own answer…',
    submit: 'Submit'
  },
  composer: {
    placeholder: 'Ask Flairy to do something…',
    telegramReadOnly: 'This chat is controlled from Telegram — read-only here.',
    addImage: 'Add image',
    imageUnsupported: "The current model can't read images",
    imagesIgnored:
      "The current model can't read images, so attached pictures will be ignored.",
    imagesExtracted:
      "The current model can't view images directly — a helper model will describe them for it, so some details may be missed or inaccurate.",
    removeAttachment: 'Remove attachment',
    workingDirectory: 'Working directory',
    workingDirectoryTitle: 'Working directory: {{path}}',
    workspaceLockedTitle: 'Working directory: {{path}}\nFixed for this conversation',
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
    // Sidebar nav
    navGeneral: 'General',
    tabMemory: 'Memory',
    tabTelegram: 'Telegram',
    tabAbout: 'About',
    // Account
    account: 'Account',
    name: 'Name',
    email: 'Email',
    signedIn: 'Signed in',
    signOut: 'Sign out',
    signOutHint:
      'Signing out clears all data on this device. Conversations are restored from your account when you sign back in; projects only live on this device and cannot be restored.',
    // General
    sectionDisplay: 'Display',
    sectionWindow: 'Window',
    language: 'Language',
    chatWidth: 'Conversation width',
    chatWidthDescription: 'How wide the conversation appears in the window.',
    chatWidthStandard: 'Standard',
    chatWidthWide: 'Wide',
    chatWidthFull: 'Full width',
    closeToTrayDescription:
      'Keep Flairy running in the background when you close the window, so it opens again instantly.',
    closeToTrayLabel: 'Keep running in the background',
    // Memory
    memoryDescription:
      "Flairy remembers helpful things about you as you chat, so you don't have to repeat yourself. You can forget any of them here.",
    memoryEmpty: "Flairy hasn't remembered anything about you yet.",
    memoryForget: 'Forget',
    memoryClearAll: 'Forget everything',
    memoryClearConfirm: 'Yes, forget everything',
    cancel: 'Cancel',
    // Telegram tab
    telegramConnection: 'Connection',
    telegramConnectionDescription:
      'Enter your bot token (from @BotFather) to let Flairy receive messages from Telegram.',
    telegramTokenPlaceholder: 'Bot token from @BotFather',
    telegramConnectButton: 'Connect',
    telegramConnecting: 'Connecting…',
    telegramDisconnectButton: 'Disconnect',
    telegramStatusConnected: 'Connected as @{{username}}',
    telegramStatusNotConnected: 'Not connected',
    telegramStatusPaused: 'Paused — not accepting new messages',
    telegramStatusError: 'Error: {{error}}',
    telegramLastActive: 'Last message received: {{time}}',
    telegramLinkGroup: 'Link your chat',
    telegramNotPaired: 'No chat linked yet',
    telegramLinkGroupDescription:
      'Pair your private chat with the bot. Threads in that chat each become a separate conversation in Flairy.',
    telegramPairButton: 'Get pairing code',
    telegramPairingCodeLabel: 'Your pairing code',
    telegramPairingCodeExpiry: 'Expires at {{time}}',
    telegramPairingStepsTitle: 'How to link your chat:',
    telegramPairingStep1: '1. In @BotFather, enable Threaded Mode for your bot.',
    telegramPairingStep2: '2. Open a direct chat with your bot in Telegram.',
    telegramPairingStep3: '3. Send /pair {{code}} in that chat.',
    telegramPaired: 'Linked with {{chat}}',
    telegramUnpairButton: 'Unlink chat',
    telegramReceiveLabel: 'Receive Telegram messages',
    telegramKillSwitchDescription:
      'Stop Flairy from accepting new Telegram messages. Any action already running may not stop immediately.',
    telegramWorkspace: 'Telegram workspace',
    telegramWorkspaceDescription:
      'Telegram-driven tasks run in a dedicated workspace folder, separate from your other workspaces.',
    // About
    appTagline: 'Your AI assistant that just works.',
    version: 'Version',
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
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    bash: 'Shell',
    grep: 'Search contents',
    find: 'Find files',
    ls: 'List files',
    ask: 'Ask you a question',
    web_search: 'Search the web',
    web_fetch: 'Fetch a web page',
    todo_write: 'Update the plan',
    fallback: 'Use a tool'
  },
  citations: {
    sources: 'Sources'
  },
  /** Full-screen fallback shown when a page crashes (route errorElement). */
  error: {
    title: 'Something went wrong',
    body: 'Flairy ran into an unexpected problem. Reloading usually fixes it.',
    reload: 'Reload',
    details: 'Technical details'
  }
}

export default en
