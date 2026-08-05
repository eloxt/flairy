use gpui::prelude::FluentBuilder;
use gpui::{
    AppContext, Context, Entity, FontWeight, InteractiveElement, IntoElement, ParentElement,
    Render, ScrollHandle, SharedString, Styled, Window, div, px,
};
use gpui_component::input::{InputEvent, InputState};
use gpui_component::ActiveTheme;

use crate::theme;

/// Tailwind-style font-weight shorthands (gpui only exposes `font_weight`).
pub trait TextWeight: Styled + Sized {
    fn font_medium(self) -> Self {
        self.font_weight(FontWeight::MEDIUM)
    }
    fn font_semibold(self) -> Self {
        self.font_weight(FontWeight::SEMIBOLD)
    }
}
impl<T: Styled> TextWeight for T {}

/// Sidebar session context-menu actions (dispatched by the right-click menu).
#[derive(Clone, PartialEq, gpui::Action)]
#[action(namespace = flairy, no_json)]
pub struct RenameSession(pub usize);

#[derive(Clone, PartialEq, gpui::Action)]
#[action(namespace = flairy, no_json)]
pub struct DeleteSession(pub usize);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum SidebarTab {
    Chats,
    Projects,
}

pub enum Msg {
    User(String),
    Assistant {
        md: String,
        done: bool,
        /// Streaming markdown document; created lazily for hydrated history.
        view: Option<Entity<flairy_markdown::MarkdownState>>,
        /// Model reasoning text (display-only; not persisted to history).
        reasoning: String,
        /// Reasoning disclosure expanded.
        reasoning_open: bool,
    },
    /// Live tool call from the real agent.
    Tool {
        /// tool_use_id, pairs the result to its call (parallel-safe).
        id: String,
        label: String,
        preview: String,
        output: Option<String>,
        is_error: bool,
        /// UI state: result card expanded.
        expanded: bool,
    },
}

/// New markdown entity wired to re-render (and follow) the chat when a
/// background parse lands.
pub fn markdown_view(
    initial: Option<&str>,
    cx: &mut Context<FlairyApp>,
) -> Entity<flairy_markdown::MarkdownState> {
    let entity = cx.new(|cx| match initial {
        Some(text) => flairy_markdown::MarkdownState::new_static(text, cx),
        None => flairy_markdown::MarkdownState::new(cx),
    });
    cx.observe(&entity, |this, _, cx| {
        if this.sessions.get(this.active_session).is_some_and(|s| s.running) {
            this.scroll.scroll_to_bottom();
        }
        cx.notify();
    })
    .detach();
    entity
}

pub struct Session {
    pub id: String,
    pub title: String,
    pub running: bool,
    pub msgs: Vec<Msg>,
    /// Provider-format history for the real agent.
    pub agent_history: Vec<flairy_agent::Message>,
    pub updated_at: i64,
    /// Steered input waiting for the current run to finish.
    pub queued: Vec<String>,
    /// Tools approved for the rest of this session.
    pub allowed_tools: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    // Cumulative usage for the stats panel (persisted with the session).
    pub usage_input: u64,
    pub usage_output: u64,
    pub requests: u32,
    /// input_tokens of the latest turn ≈ current context size.
    pub last_input: u32,
    /// Accumulate-only auto-tool-selection union (never shrinks; cache-safe).
    pub tool_selection: std::collections::HashSet<String>,
    /// Project workspace directory. Some ⇒ project session: device-local,
    /// never synced to the server.
    pub workspace_path: Option<String>,
    /// Context compression (device-local): summary of agent_history[..up_to].
    /// The full transcript stays intact for display and sync; only the
    /// LLM-facing history is compacted.
    pub compression_summary: String,
    pub compression_up_to: usize,
    /// The running turn was started with history[..up_to] replaced by the
    /// summary message — Done must splice the full prefix back in.
    pub run_compacted_up_to: Option<usize>,
    /// A summarize call is in flight (dedupe guard).
    pub compressing: bool,
}

/// A blocked `ask` tool call plus the card's in-progress selection state.
pub struct PendingQuestion {
    pub request: crate::agent_runtime::QuestionRequest,
    /// Per-question picked option indices.
    pub selected: Vec<std::collections::HashSet<usize>>,
    /// Per-question free-text "other" inputs; created lazily in render
    /// (InputState needs a Window).
    pub custom_inputs: Vec<Entity<InputState>>,
}

pub struct FlairyApp {
    pub tab: SidebarTab,
    pub sessions: Vec<Session>,
    pub active_session: usize,
    pub sidebar_open: bool,
    pub right_open: bool,
    pub input: Entity<InputState>,
    pub scroll: ScrollHandle,
    pub cancel: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    /// Live config pushed by the control-plane server, if connected.
    pub server_config: Option<crate::server_client::ServerConfig>,
    /// Tool call awaiting user confirmation (rendered as the approval card).
    pub pending_approval: Option<crate::agent_runtime::ApprovalRequest>,
    /// `ask` tool call awaiting the user's answer (rendered as the question card).
    pub pending_question: Option<PendingQuestion>,
    /// Composer plan card expanded (collapsed shows one summary line).
    pub plan_expanded: bool,
    pub sync_tx: Option<tokio::sync::mpsc::UnboundedSender<crate::server_client::Outgoing>>,
    /// User-picked model option (model.id); falls back to llm.main.
    pub model_choice: Option<String>,
    pub model_menu_open: bool,
    /// Set when the menu is dismissed by an outside mouse-down; the trigger
    /// button's click (same gesture, fires on mouse-up) must not reopen it.
    pub model_menu_dismissed: Option<std::time::Instant>,
    /// Session being renamed inline, if any.
    pub renaming: Option<usize>,
    pub rename_input: Entity<InputState>,
    /// Sidebar session search (filters the chats list live).
    pub search_active: bool,
    pub search_input: Entity<InputState>,
    /// Images staged for the next send: (media_type, base64 data, filename).
    pub pending_attachments: Vec<(String, String, String)>,

    pub store: Option<crate::store::Store>,
    pub mcp: std::sync::Arc<crate::mcp::McpManager>,
    /// Login JWT + server origin for REST calls (skills fetch).
    pub auth: Option<(String, String)>,
    pub signed_in: bool,
    pub auth_error: Option<String>,
    pub email_input: Entity<InputState>,
    pub password_input: Entity<InputState>,
}

impl FlairyApp {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .multi_line(true)
                .auto_grow(1, 8)
                .placeholder("问点什么…")
        });

        cx.subscribe_in(&input, window, |this, _, event: &InputEvent, window, cx| {
            if let InputEvent::PressEnter { secondary: false } = event {
                this.send(window, cx);
            }
        })
        .detach();

        let rename_input = cx.new(|cx| InputState::new(window, cx).placeholder("会话名称"));
        cx.subscribe_in(&rename_input, window, |this, _, event: &InputEvent, _, cx| {
            if let InputEvent::PressEnter { .. } = event {
                this.commit_rename(cx);
            }
        })
        .detach();
        let search_input = cx.new(|cx| InputState::new(window, cx).placeholder("搜索会话…"));
        cx.subscribe(&search_input, |_, _, event: &InputEvent, cx| {
            if let InputEvent::Change { .. } = event {
                cx.notify();
            }
        })
        .detach();
        let email_input = cx.new(|cx| InputState::new(window, cx).placeholder("邮箱"));
        let password_input = cx.new(|cx| InputState::new(window, cx).masked(true).placeholder("密码"));
        let store = crate::store::Store::open();
        let persisted = store.as_ref().map(|s| s.load_all()).unwrap_or_default();
        let sessions = if persisted.is_empty() { vec![empty_session()] } else { persisted };
        let model_choice = store.as_ref().and_then(|s| s.get_setting("model_choice"));
        let this = Self {
            tab: SidebarTab::Chats,
            sessions,
            active_session: 0,
            sidebar_open: true,
            right_open: false,
            input,
            scroll: ScrollHandle::new(),
            cancel: None,
            server_config: None,
            pending_approval: None,
            pending_question: None,
            plan_expanded: true,
            sync_tx: None,
            model_choice,
            model_menu_open: false,
            model_menu_dismissed: None,
            renaming: None,
            rename_input,
            search_active: false,
            search_input,
            pending_attachments: Vec::new(),
            store,
            mcp: std::sync::Arc::new(crate::mcp::McpManager::new()),
            auth: None,
            signed_in: false,
            auth_error: None,
            email_input,
            password_input,
        };
        // Auto sign-in from stored/env credentials; otherwise show the auth screen.
        let mut this = this;
        // Dev fallback: FLAIRY_MCP_CMD="npx -y @modelcontextprotocol/server-everything"
        if let Ok(cmd) = std::env::var("FLAIRY_MCP_CMD") {
            let mut parts = cmd.split_whitespace().map(String::from);
            if let Some(command) = parts.next() {
                let args: Vec<String> = parts.collect();
                this.mcp.apply(vec![serde_json::json!({
                    "name": "dev",
                    "enabled": true,
                    "transport": {"kind": "stdio", "command": command, "args": args},
                })]);
            }
        }
        // Cached config first: models/prompts/MCP work offline and before the
        // socket handshake completes; the live snapshot replaces it on arrival.
        if let Some(raw) = crate::config_cache::load() {
            if let Some(config) = serde_json::from_str::<serde_json::Value>(&raw)
                .ok()
                .as_ref()
                .and_then(crate::server_client::parse_snapshot)
            {
                this.mcp.apply(config.mcp_servers.clone());
                this.server_config = Some(config);
            }
        }
        if let Some(creds) = crate::server_client::stored_or_env_credentials() {
            this.signed_in = true;
            this.start_connection(creds, cx);
        }
        // Scheduler tick: fire due tasks every 60s (device-local; catches up
        // after sleep since due-ness is computed from wall-clock time).
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(std::time::Duration::from_secs(60))
                    .await;
                if this.update(cx, |this, cx| this.check_due_tasks(cx)).is_err() {
                    break; // app dropped
                }
            }
        })
        .detach();
        // Dev harness: auto-play the markdown fixture shortly after launch.
        if std::env::var("FLAIRY_MD_DEMO").is_ok() {
            cx.spawn(async move |this, cx| {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(800))
                    .await;
                this.update(cx, |this, cx| {
                    this.new_chat(cx);
                    this.demo_stream(this.active_session, "demo".into(), cx);
                })
            })
            .detach();
        }
        this
    }

    pub fn start_connection(&mut self, creds: crate::server_client::Credentials, cx: &mut Context<Self>) {
        let (mut rx, out_tx) = crate::server_client::connect(creds);
        self.sync_tx = Some(out_tx);
        cx.spawn(async move |this, cx| {
            while let Some(event) = rx.recv().await {
                this.update(cx, |this, cx| this.apply_server_event(event, cx))?;
            }
            anyhow::Ok(())
        })
        .detach();
    }

    pub fn sign_in(&mut self, cx: &mut Context<Self>) {
        let email = self.email_input.read(cx).value().trim().to_string();
        let password = self.password_input.read(cx).value().to_string();
        if email.is_empty() || password.is_empty() {
            self.auth_error = Some("请输入邮箱和密码".into());
            cx.notify();
            return;
        }
        let server = std::env::var("FLAIRY_SERVER_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:8787".into());
        let creds = crate::server_client::Credentials { email, password, server };
        crate::server_client::save_credentials(&creds);
        self.auth_error = None;
        self.signed_in = true;
        self.start_connection(creds, cx);
        cx.notify();
    }

    pub fn skip_login(&mut self, cx: &mut Context<Self>) {
        self.signed_in = true;
        cx.notify();
    }

    fn apply_server_event(&mut self, event: crate::server_client::ServerEvent, cx: &mut Context<Self>) {
        use crate::server_client::ServerEvent as SE;
        match event {
            SE::AuthFailed(message) => {
                self.signed_in = false;
                self.sync_tx = None;
                self.auth_error = Some(message);
            }
            SE::Authed { token, server } => {
                self.auth = Some((token, server));
            }
            SE::Config(config, raw) => {
                crate::config_cache::save(&raw);
                self.mcp.apply(config.mcp_servers.clone());
                if let Some((token, server)) = &self.auth {
                    crate::skills::materialize(
                        config.skills.clone(),
                        token.clone(),
                        server.clone(),
                    );
                }
                self.server_config = Some(config);
            }
            SE::Remote(remote) => {
                let (msgs, history) = crate::contract::hydrate(&remote.messages);
                match self.sessions.iter_mut().find(|s| s.id == remote.session.id) {
                    Some(local) => {
                        // Newer updatedAt wins; skip stale echoes and never
                        // clobber a session that's mid-run locally.
                        if remote.session.updated_at > local.updated_at && !local.running {
                            local.title = remote.session.title.clone();
                            local.msgs = msgs;
                            local.agent_history = history;
                            local.updated_at = remote.session.updated_at;
                            if let Some(store) = &self.store {
                                store.save(local);
                            }
                        }
                    }
                    None => {
                        self.sessions.insert(0, Session {
                            id: remote.session.id.clone(),
                            title: remote.session.title.clone(),
                            running: false,
                            msgs,
                            agent_history: history,
                            updated_at: remote.session.updated_at,
                            queued: Vec::new(),
                            allowed_tools: Default::default(),
                            usage_input: 0,
                            usage_output: 0,
                            requests: 0,
                            last_input: 0,
                            tool_selection: Default::default(),
                            workspace_path: None,
                            compression_summary: String::new(),
                            compression_up_to: 0,
                            run_compacted_up_to: None,
                            compressing: false,
                        });
                        self.active_session += 1; // keep the user's current view
                        if let Some(store) = &self.store {
                            store.save(&self.sessions[0]);
                        }
                    }
                }
            }
            SE::MemoryRemote(memories) => {
                if let Some(store) = &self.store {
                    store.upsert_memories(&memories);
                }
            }
            SE::RemoteDelete(id) => {
                if let Some(store) = &self.store {
                    store.delete(&id);
                }
                if let Some(pos) = self.sessions.iter().position(|s| s.id == id) {
                    self.sessions.remove(pos);
                    if self.active_session >= self.sessions.len() {
                        self.active_session = self.sessions.len().saturating_sub(1);
                    }
                }
            }
        }
        cx.notify();
    }

    /// Push the session to the server (full upsert — see server contract).
    fn sync_session(&mut self, ix: usize) {
        let Some(tx) = &self.sync_tx else { return };
        let session = &self.sessions[ix];
        if session.agent_history.is_empty() {
            return; // mock/demo transcripts never sync
        }
        if session.workspace_path.is_some() {
            return; // project sessions are device-local by design
        }
        let payload = crate::contract::SessionUpsertPayload {
            session: crate::contract::Session {
                id: session.id.clone(),
                user_id: String::new(),
                title: session.title.clone(),
                created_at: session.updated_at,
                updated_at: session.updated_at,
            },
            messages: crate::contract::to_sync_messages(&session.agent_history),
        };
        let _ = tx.send(crate::server_client::Outgoing::Upsert(payload));
    }

    pub fn active(&self) -> &Session {
        &self.sessions[self.active_session]
    }

    /// The active session's latest plan (most recent todo_write result).
    pub fn current_plan(&self) -> Option<Vec<crate::todo::TodoItem>> {
        self.active().msgs.iter().rev().find_map(|m| match m {
            Msg::Tool { output: Some(output), .. } => crate::todo::parse_todos(output),
            _ => None,
        })
    }

    pub fn start_rename(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let title = self.sessions[ix].title.clone();
        self.rename_input.update(cx, |state, cx| state.set_value(title, window, cx));
        self.renaming = Some(ix);
        cx.notify();
    }

    pub fn commit_rename(&mut self, cx: &mut Context<Self>) {
        let Some(ix) = self.renaming.take() else { return };
        let title = self.rename_input.read(cx).value().trim().to_string();
        if !title.is_empty() && ix < self.sessions.len() {
            let session = &mut self.sessions[ix];
            session.title = title.clone();
            session.updated_at = flairy_ai::types::now_ms() as i64;
            let (id, updated_at) = (session.id.clone(), session.updated_at);
            if let Some(store) = &self.store {
                store.save(&self.sessions[ix]);
            }
            if let Some(tx) = &self.sync_tx {
                let _ = tx.send(crate::server_client::Outgoing::PatchTitle {
                    session_id: id,
                    title,
                    updated_at,
                });
            }
        }
        cx.notify();
    }

    pub fn delete_session(&mut self, ix: usize, cx: &mut Context<Self>) {
        if ix >= self.sessions.len() {
            return;
        }
        let session = self.sessions.remove(ix);
        if let Some(store) = &self.store {
            store.delete(&session.id);
        }
        // Project sessions never existed on the server — nothing to delete there.
        if session.workspace_path.is_none() {
            if let Some(tx) = &self.sync_tx {
                let _ =
                    tx.send(crate::server_client::Outgoing::Delete { session_id: session.id });
            }
        }
        if self.sessions.is_empty() {
            self.sessions.push(empty_session());
        }
        if self.active_session >= self.sessions.len() {
            self.active_session = self.sessions.len() - 1;
        }
        cx.notify();
    }

    pub fn new_chat(&mut self, cx: &mut Context<Self>) {
        self.sessions.insert(
            0,
            empty_session(),
        );
        self.active_session = 0;
        self.tab = SidebarTab::Chats;
        cx.notify();
    }

    /// Pick a folder and create a project session for it (eager creation —
    /// the session exists and persists immediately).
    pub fn new_project(&mut self, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: None,
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(mut paths))) = rx.await {
                if let Some(path) = paths.pop() {
                    this.update(cx, |this, cx| {
                        this.add_project_session(path.to_string_lossy().into_owned(), cx);
                    })?;
                }
            }
            anyhow::Ok(())
        })
        .detach();
    }

    /// New session inside an existing (or new) workspace.
    pub fn add_project_session(&mut self, workspace: String, cx: &mut Context<Self>) {
        let mut session = empty_session();
        session.workspace_path = Some(workspace);
        if let Some(store) = &self.store {
            store.save(&session);
        }
        self.sessions.insert(0, session);
        self.active_session = 0;
        self.tab = SidebarTab::Projects;
        cx.notify();
    }

    pub fn send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.input.read(cx).value().trim().to_string();
        if text.is_empty() {
            return;
        }
        if self.active().running {
            // Steer: queue it; runs when the current turn finishes.
            self.input.update(cx, |state, cx| state.set_value("", window, cx));
            let ix = self.active_session;
            self.sessions[ix].queued.push(text);
            cx.notify();
            return;
        }
        self.input.update(cx, |state, cx| state.set_value("", window, cx));
        if std::env::var("FLAIRY_MD_DEMO").is_ok() {
            self.demo_stream(self.active_session, text, cx);
            return;
        }
        let attachments: Vec<(String, String)> = self
            .pending_attachments
            .drain(..)
            .map(|(media_type, data, _)| (media_type, data))
            .collect();
        if let Some(option) = self.effective_model() {
            self.run_agent(self.active_session, text, option.model, option.api_key, attachments, cx);
        } else if let Some((model, key)) = crate::agent_runtime::env_model() {
            self.run_agent(self.active_session, text, model, key, attachments, cx);
        } else {
            self.stream_reply(self.active_session, text, cx);
        }
    }

    /// Paperclip: pick image files and stage them for the next send.
    pub fn attach_images(&mut self, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(gpui::PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: None,
        });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = rx.await {
                this.update(cx, |this, cx| {
                    use base64::Engine as _;
                    for path in paths {
                        let media_type = match path
                            .extension()
                            .and_then(|e| e.to_str())
                            .map(str::to_lowercase)
                            .as_deref()
                        {
                            Some("jpg") | Some("jpeg") => "image/jpeg",
                            Some("png") => "image/png",
                            Some("gif") => "image/gif",
                            Some("webp") => "image/webp",
                            _ => continue, // images only
                        };
                        let Ok(bytes) = std::fs::read(&path) else { continue };
                        if bytes.len() > 8 * 1024 * 1024 {
                            continue; // provider limits; skip oversized files
                        }
                        let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                        let name = path
                            .file_name()
                            .map(|n| n.to_string_lossy().into_owned())
                            .unwrap_or_else(|| "image".into());
                        this.pending_attachments.push((media_type.to_string(), data, name));
                    }
                    cx.notify();
                })?;
            }
            anyhow::Ok(())
        })
        .detach();
    }

    /// The model the next message will use: picked option > llm.main.
    pub fn effective_model(&self) -> Option<crate::server_client::ModelOption> {
        let config = self.server_config.as_ref()?;
        if let Some(choice) = &self.model_choice {
            if let Some(option) = config.options.iter().find(|o| &o.model.id == choice) {
                return Some(option.clone());
            }
        }
        config.main.clone()
    }

    /// Real agent path (flairy-agent + flairy-ai), used when env credentials exist.
    pub fn run_agent(
        &mut self,
        ix: usize,
        text: String,
        model: flairy_ai::Model,
        key: String,
        attachments: Vec<(String, String)>,
        cx: &mut Context<Self>,
    ) {
        let session = &mut self.sessions[ix];
        let is_first = session.agent_history.is_empty();
        if session.title == "Untitled" {
            session.title = text.chars().take(16).collect();
        }
        if is_first {
            self.maybe_generate_title(ix, text.clone(), cx);
        }
        let session = &mut self.sessions[ix];
        session.msgs.push(Msg::User(text.clone()));
        for _ in &attachments {
            session.msgs.push(Msg::User("🖼 [图片]".into()));
        }
        session.running = true;
        self.scroll.scroll_to_bottom();
        cx.notify();

        // Auto tool selection (strictly server-driven: needs the
        // `tool_selection` prompt). Fail-open: any failure runs all tools.
        let selection = self.server_config.as_ref().and_then(|c| {
            let prompt = c.prompts.get("tool_selection")?.clone();
            let option = c.tool.clone().or_else(|| c.main.clone())?;
            Some((prompt, option))
        });
        let Some((prompt, option)) = selection else {
            self.start_agent_turn(ix, text, model, key, attachments, None, false, cx);
            return;
        };

        let mut catalog: Vec<(String, String)> = [
            ("bash", "Run a shell command and return its output."),
            ("list_dir", "List entries of a local directory."),
            ("write_file", "Write a text file to the local filesystem."),
            ("edit_file", "Make a targeted edit to a text file."),
            ("grep", "Search file contents with a regular expression."),
            ("find", "Find files by name with a glob pattern."),
        ]
        .into_iter()
        .map(|(n, d)| (n.to_string(), d.to_string()))
        .collect();
        if self.server_config.as_ref().is_some_and(|c| c.exa.is_some()) {
            catalog.push(("web_search".into(), "Search the web for any topic.".into()));
            catalog.push(("web_fetch".into(), "Fetch the full text of one web page.".into()));
        }
        for tool in self.mcp.tools() {
            catalog.push((tool.name().to_string(), tool.description().to_string()));
        }

        // Last 6 user/assistant messages, clipped, as selection context.
        let recent: String = self.sessions[ix]
            .agent_history
            .iter()
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|m| {
                let role = match m.role {
                    flairy_ai::Role::User => "user",
                    flairy_ai::Role::Assistant => "assistant",
                };
                let text: String = m
                    .content
                    .iter()
                    .filter_map(|b| match b {
                        flairy_agent::ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join(" ")
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .chars()
                    .take(500)
                    .collect();
                if text.is_empty() { String::new() } else { format!("{role}: {text}") }
            })
            .filter(|l| !l.is_empty())
            .collect::<Vec<_>>()
            .join("\n");

        let rx = crate::agent_runtime::select_tools(
            option.model,
            option.api_key,
            prompt,
            catalog,
            recent,
            text.clone(),
        );
        cx.spawn(async move |this, cx| {
            let picked = rx.await.ok().flatten();
            this.update(cx, |this, cx| {
                // The user may have hit Stop while selection ran.
                if !this.sessions.get(ix).is_some_and(|s| s.running) {
                    return;
                }
                let selected = picked.map(|names| {
                    // Accumulate-only union: the offered set never shrinks
                    // within a session (prompt-cache-safe), floored later.
                    let session = &mut this.sessions[ix];
                    session.tool_selection.extend(names);
                    session.tool_selection.clone()
                });
                this.start_agent_turn(ix, text, model, key, attachments, selected, false, cx);
            })?;
            anyhow::Ok(())
        })
        .detach();
    }

    /// Spawn the agent worker for one turn and wire its event channels.
    fn start_agent_turn(
        &mut self,
        ix: usize,
        text: String,
        model: flairy_ai::Model,
        key: String,
        attachments: Vec<(String, String)>,
        selected_tools: Option<std::collections::HashSet<String>>,
        headless: bool,
        cx: &mut Context<Self>,
    ) {
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        self.cancel = Some(cancel.clone());

        let session = &mut self.sessions[ix];
        // LLM-facing history: compression replaces the summarized prefix with
        // one summary message; the display transcript stays complete.
        let history = if session.compression_up_to > 0 && !session.compression_summary.is_empty()
        {
            let up_to = session.compression_up_to.min(session.agent_history.len());
            session.run_compacted_up_to = Some(up_to);
            let mut compact = vec![flairy_agent::Message::user_text(format!(
                "<conversation_summary>\n{}\n</conversation_summary>\n(The messages above were summarized to save context. Continue the conversation naturally.)",
                session.compression_summary
            ))];
            compact.extend(session.agent_history[up_to..].iter().cloned());
            compact
        } else {
            session.run_compacted_up_to = None;
            session.agent_history.clone()
        };
        let session = &self.sessions[ix];
        let workspace = session.workspace_path.clone();
        let system_prompt = self.assemble_system_prompt(workspace.is_some());
        let allowed = self.sessions[ix].allowed_tools.clone();
        let exa = self.server_config.as_ref().and_then(|c| c.exa.clone());
        let session_id = self.sessions[ix].id.clone();
        let user_message = {
            let mut content = vec![flairy_agent::ContentBlock::Text { text }];
            content.extend(attachments.into_iter().map(|(media_type, data)| {
                flairy_agent::ContentBlock::Image { media_type, data }
            }));
            flairy_agent::Message {
                role: flairy_ai::Role::User,
                content,
                timestamp: flairy_ai::types::now_ms(),
            }
        };
        let (mut rx, mut approval_rx, mut question_rx, mut memory_rx, mut schedule_rx) =
            crate::agent_runtime::spawn_agent(
                model, key, history, user_message, cancel, system_prompt, self.mcp.tools(),
                allowed, exa, session_id, selected_tools, workspace, headless,
            );
        cx.spawn(async move |this, cx| {
            while let Some(event) = rx.recv().await {
                this.update(cx, |this, cx| this.apply_agent_event(ix, event, cx))?;
            }
            anyhow::Ok(())
        })
        .detach();
        cx.spawn(async move |this, cx| {
            while let Some(request) = approval_rx.recv().await {
                this.update(cx, |this, cx| {
                    this.pending_approval = Some(request);
                    cx.notify();
                })?;
            }
            anyhow::Ok(())
        })
        .detach();
        cx.spawn(async move |this, cx| {
            while let Some(request) = question_rx.recv().await {
                this.update(cx, |this, cx| {
                    let count = request.questions.len();
                    this.pending_question = Some(PendingQuestion {
                        request,
                        selected: vec![Default::default(); count],
                        custom_inputs: Vec::new(),
                    });
                    cx.notify();
                })?;
            }
            anyhow::Ok(())
        })
        .detach();
        cx.spawn(async move |this, cx| {
            while let Some(memory) = memory_rx.recv().await {
                this.update(cx, |this, _| {
                    // Local SQLite write + server mirror (multi-device sync).
                    if let Some(store) = &this.store {
                        store.upsert_memories(std::slice::from_ref(&memory));
                    }
                    if let Some(tx) = &this.sync_tx {
                        let _ = tx
                            .send(crate::server_client::Outgoing::MemoryUpsert(vec![memory]));
                    }
                })?;
            }
            anyhow::Ok(())
        })
        .detach();
        cx.spawn(async move |this, cx| {
            while let Some(request) = schedule_rx.recv().await {
                this.update(cx, |this, _| this.handle_schedule_request(request))?;
            }
            anyhow::Ok(())
        })
        .detach();
    }

    /// Apply one schedule-tool request against the store and reply.
    fn handle_schedule_request(&mut self, request: crate::schedule::ScheduleRequest) {
        use crate::schedule::ScheduleAction as A;
        let Some(store) = &self.store else {
            let _ = request.reply.send(Err("本地存储不可用".into()));
            return;
        };
        let result = match request.action {
            A::Create { prompt, cron, delay_minutes } => {
                let now = flairy_ai::types::now_ms() as i64;
                let task = crate::schedule::ScheduledTask {
                    id: uuid::Uuid::new_v4().to_string(),
                    session_id: request.session_id,
                    prompt,
                    run_at: delay_minutes.map(|m| now + (m as i64) * 60_000),
                    cron,
                    active: true,
                    last_run: None,
                    created_at: now,
                };
                store.create_task(&task);
                Ok(format!("Scheduled task created (id: {}).", task.id))
            }
            A::List => Ok(crate::schedule::format_tasks(&store.list_tasks())),
            A::Pause(id) => {
                if store.set_task_active(&id, false) {
                    Ok(format!("Task {id} paused."))
                } else {
                    Err(format!("no task with id {id}"))
                }
            }
            A::Resume(id) => {
                if store.set_task_active(&id, true) {
                    Ok(format!("Task {id} resumed."))
                } else {
                    Err(format!("no task with id {id}"))
                }
            }
            A::Delete(id) => {
                if store.delete_task(&id) {
                    Ok(format!("Task {id} deleted."))
                } else {
                    Err(format!("no task with id {id}"))
                }
            }
        };
        let _ = request.reply.send(result);
    }

    /// 60-second scheduler tick: fire due tasks into their sessions as
    /// headless turns (approvals auto-deny). Busy sessions are skipped and
    /// retried on the next tick.
    fn check_due_tasks(&mut self, cx: &mut Context<Self>) {
        let now = flairy_ai::types::now_ms() as i64;
        let due: Vec<crate::schedule::ScheduledTask> = {
            let Some(store) = &self.store else { return };
            store
                .list_tasks()
                .into_iter()
                .filter(|t| crate::schedule::is_due(t, now))
                .collect()
        };
        for task in due {
            let Some(ix) = self.sessions.iter().position(|s| s.id == task.session_id) else {
                // Bound session was deleted — the task can never run again.
                if let Some(store) = &self.store {
                    store.delete_task(&task.id);
                }
                continue;
            };
            if self.sessions[ix].running {
                continue; // busy — retried next tick
            }
            let Some((model, key)) = self
                .effective_model()
                .map(|o| (o.model, o.api_key))
                .or_else(crate::agent_runtime::env_model)
            else {
                continue; // no model configured — retried when config arrives
            };
            if let Some(store) = &self.store {
                store.mark_task_run(&task.id, now, task.run_at.is_some());
            }
            let session = &mut self.sessions[ix];
            session.msgs.push(Msg::User(format!("⏰ 计划任务：{}", task.prompt)));
            session.running = true;
            cx.notify();
            self.start_agent_turn(ix, task.prompt, model, key, Vec::new(), None, true, cx);
        }
    }

    /// Assemble the system prompt from the server-pushed body: `{{memory}}`
    /// becomes the user-memory block, `{{skills}}` the skills instructions
    /// (project sessions only, like Electron's lean chat kind), any other
    /// placeholder becomes "".
    fn assemble_system_prompt(&self, is_project: bool) -> Option<String> {
        let config = self.server_config.as_ref()?;
        let body = if is_project {
            config.prompts.get("main").or_else(|| config.prompts.get("chat"))?
        } else {
            config.prompts.get("chat").or_else(|| config.prompts.get("main"))?
        };
        let memory_block = self
            .store
            .as_ref()
            .map(|s| build_memory_block(&s.active_memories()))
            .unwrap_or_default();
        let skills_block = if is_project {
            crate::skills::skills_instructions(&config.skills)
        } else {
            String::new()
        };
        let substituted = body
            .replace("{{memory}}", &memory_block)
            .replace("{{skills}}", &skills_block)
            .replace("{{cards}}", &crate::cards::cards_prompt(!is_project));
        let out = crate::server_client::strip_placeholders(&substituted);
        (!out.is_empty()).then_some(out)
    }

    /// A suggestion chip was clicked: send its text as the user's message
    /// (steer-queues while a turn is running, like typing would).
    pub fn send_suggestion(&mut self, text: String, cx: &mut Context<Self>) {
        let text = text.trim().to_string();
        if text.is_empty() {
            return;
        }
        if self.active().running {
            let ix = self.active_session;
            self.sessions[ix].queued.push(text);
            cx.notify();
            return;
        }
        if let Some(option) = self.effective_model() {
            self.run_agent(self.active_session, text, option.model, option.api_key, Vec::new(), cx);
        } else if let Some((model, key)) = crate::agent_runtime::env_model() {
            self.run_agent(self.active_session, text, model, key, Vec::new(), cx);
        } else {
            self.stream_reply(self.active_session, text, cx);
        }
    }

    /// Toggle one option of one pending question (single-select replaces).
    pub fn toggle_question_option(&mut self, qix: usize, oix: usize, cx: &mut Context<Self>) {
        let Some(pending) = &mut self.pending_question else { return };
        let Some(spec) = pending.request.questions.get(qix) else { return };
        let Some(set) = pending.selected.get_mut(qix) else { return };
        if set.contains(&oix) {
            set.remove(&oix);
        } else {
            if !spec.multi_select {
                set.clear();
            }
            set.insert(oix);
        }
        cx.notify();
    }

    /// Submit (or cancel) the pending question card.
    pub fn resolve_question(&mut self, submit: bool, cx: &mut Context<Self>) {
        let Some(pending) = self.pending_question.take() else { return };
        if !submit {
            let _ = pending.request.reply.send(None);
            cx.notify();
            return;
        }
        let answers: Vec<crate::agent_runtime::AskAnswer> = pending
            .request
            .questions
            .iter()
            .enumerate()
            .map(|(qix, spec)| {
                let mut selected: Vec<String> = spec
                    .options
                    .iter()
                    .enumerate()
                    .filter(|(oix, _)| {
                        pending.selected.get(qix).is_some_and(|s| s.contains(oix))
                    })
                    .map(|(_, o)| o.label.clone())
                    .collect();
                selected.sort();
                let custom = pending
                    .custom_inputs
                    .get(qix)
                    .map(|input| input.read(cx).value().trim().to_string())
                    .filter(|s| !s.is_empty());
                crate::agent_runtime::AskAnswer { selected, custom }
            })
            .collect();
        let _ = pending.request.reply.send(Some(answers));
        cx.notify();
    }

    /// Compress the older conversation prefix once the context passes 70% of
    /// the model's window (strictly server-driven: needs the `compression`
    /// prompt). Keeps the last 12 messages, never splitting a tool call from
    /// its result. The transcript is untouched — only the LLM-facing history
    /// shrinks. Mirrors the Electron client's context compression.
    fn maybe_compress(&mut self, ix: usize, cx: &mut Context<Self>) {
        const KEEP: usize = 12;
        let Some(config) = self.server_config.as_ref() else { return };
        let Some(prompt) = config.prompts.get("compression").cloned() else { return };
        let Some(option) = config.tool.clone().or_else(|| config.main.clone()) else { return };
        let Some(context_window) = self.effective_model().and_then(|o| o.context_window) else {
            return;
        };
        let session = &self.sessions[ix];
        if session.compressing {
            return;
        }
        if (session.last_input as f64) < 0.7 * context_window as f64 {
            return;
        }
        let len = session.agent_history.len();
        if len <= KEEP {
            return;
        }
        let mut keep_from = len - KEEP;
        // Never let the kept suffix open with an orphaned tool result.
        while keep_from > 0
            && session.agent_history[keep_from]
                .content
                .iter()
                .any(|b| matches!(b, flairy_agent::ContentBlock::ToolResult { .. }))
        {
            keep_from -= 1;
        }
        if keep_from <= session.compression_up_to {
            return;
        }

        let mut transcript = String::new();
        if !session.compression_summary.is_empty() {
            transcript.push_str(&format!(
                "<previous_summary>\n{}\n</previous_summary>\n\n",
                session.compression_summary
            ));
        }
        for message in &session.agent_history[session.compression_up_to..keep_from] {
            let role = match message.role {
                flairy_ai::Role::User => "user",
                flairy_ai::Role::Assistant => "assistant",
            };
            for block in &message.content {
                match block {
                    flairy_agent::ContentBlock::Text { text } => {
                        transcript.push_str(&format!("{role}: {text}\n"));
                    }
                    flairy_agent::ContentBlock::ToolUse { name, input, .. } => {
                        let preview = crate::agent_runtime::tool_preview(input);
                        transcript.push_str(&format!("{role}: [tool {name}: {preview}]\n"));
                    }
                    flairy_agent::ContentBlock::ToolResult { content, .. } => {
                        let clipped: String = content.chars().take(200).collect();
                        transcript.push_str(&format!("{role}: [result: {clipped}]\n"));
                    }
                    flairy_agent::ContentBlock::Image { .. } => {
                        transcript.push_str(&format!("{role}: [image]\n"));
                    }
                }
            }
        }

        self.sessions[ix].compressing = true;
        let session_id = self.sessions[ix].id.clone();
        let rx = crate::agent_runtime::summarize_history(
            option.model,
            option.api_key,
            prompt,
            transcript,
        );
        cx.spawn(async move |this, cx| {
            let summary = rx.await.ok().flatten();
            this.update(cx, |this, _| {
                let Some(pos) = this.sessions.iter().position(|s| s.id == session_id) else {
                    return;
                };
                let session = &mut this.sessions[pos];
                session.compressing = false;
                let Some(summary) = summary else { return };
                if keep_from > session.agent_history.len() {
                    return; // history changed shape underneath us — drop
                }
                session.compression_summary = summary;
                session.compression_up_to = keep_from;
                if let Some(store) = &this.store {
                    store.save(&this.sessions[pos]);
                }
            })?;
            anyhow::Ok(())
        })
        .detach();
    }

    /// Fire-and-forget title generation for a session's first message.
    /// Strictly server-driven: no `title_generation` prompt → no title.
    fn maybe_generate_title(&mut self, ix: usize, first_message: String, cx: &mut Context<Self>) {
        let Some(config) = self.server_config.as_ref() else { return };
        let Some(prompt) = config.prompts.get("title_generation").cloned() else { return };
        let Some(option) = config.tool.clone().or_else(|| config.main.clone()) else { return };
        let session_id = self.sessions[ix].id.clone();
        let placeholder = {
            // The fallback title run_agent is about to set (or already set).
            let text: String = first_message.chars().take(16).collect();
            text
        };
        let rx = crate::agent_runtime::generate_title(
            option.model,
            option.api_key,
            prompt,
            first_message,
        );
        cx.spawn(async move |this, cx| {
            let Ok(Some(title)) = rx.await else { return anyhow::Ok(()) };
            this.update(cx, |this, cx| {
                let Some(pos) = this.sessions.iter().position(|s| s.id == session_id) else {
                    return;
                };
                let session = &mut this.sessions[pos];
                // Don't clobber a rename the user made in the meantime.
                if session.title != placeholder && session.title != "Untitled" {
                    return;
                }
                session.title = title.clone();
                session.updated_at = flairy_ai::types::now_ms() as i64;
                let (running, updated_at) = (session.running, session.updated_at);
                if let Some(store) = &this.store {
                    store.save(&this.sessions[pos]);
                }
                // Mid-run, the turn-end upsert carries the title; after the
                // turn, the server row exists and a patch applies cleanly.
                if !running {
                    if let Some(tx) = &this.sync_tx {
                        let _ = tx.send(crate::server_client::Outgoing::PatchTitle {
                            session_id,
                            title,
                            updated_at,
                        });
                    }
                }
                cx.notify();
            })?;
            anyhow::Ok(())
        })
        .detach();
    }

    pub fn resolve_approval(&mut self, reply: crate::agent_runtime::ApprovalReply, cx: &mut Context<Self>) {
        if let Some(request) = self.pending_approval.take() {
            let _ = request.reply.send(reply);
        }
        cx.notify();
    }

    fn apply_agent_event(
        &mut self,
        ix: usize,
        event: flairy_agent::AgentEvent,
        cx: &mut Context<Self>,
    ) {
        use flairy_agent::AgentEvent as E;
        let session = &mut self.sessions[ix];
        match event {
            E::TurnStart => {}
            E::TextDelta { text } => {
                match session.msgs.last_mut() {
                    Some(Msg::Assistant { md, done, view, .. }) if !*done => {
                        md.push_str(&text);
                        if let Some(view) = view.clone() {
                            view.update(cx, |state, cx| state.append(&text, cx));
                        }
                    }
                    _ => {
                        let view = markdown_view(None, cx);
                        view.update(cx, |state, cx| state.append(&text, cx));
                        self.sessions[ix].msgs.push(Msg::Assistant {
                            md: text,
                            done: false,
                            view: Some(view),
                            reasoning: String::new(),
                            reasoning_open: false,
                        });
                    }
                }
            }
            E::ThinkingDelta { text } => {
                match session.msgs.last_mut() {
                    Some(Msg::Assistant { done, reasoning, .. }) if !*done => {
                        reasoning.push_str(&text);
                    }
                    _ => {
                        self.sessions[ix].msgs.push(Msg::Assistant {
                            md: String::new(),
                            done: false,
                            view: Some(markdown_view(None, cx)),
                            reasoning: text,
                            reasoning_open: false,
                        });
                    }
                }
            }
            E::ToolCallStart { id, name, input } => {
                // Close an empty in-progress assistant bubble before the tool
                // row (keep it if it carries reasoning worth showing).
                if matches!(session.msgs.last(), Some(Msg::Assistant { md, done, reasoning, .. }) if md.is_empty() && !done && reasoning.is_empty())
                {
                    session.msgs.pop();
                } else if let Some(Msg::Assistant { done, view, .. }) = session.msgs.last_mut() {
                    *done = true;
                    if let Some(view) = view.clone() {
                        view.update(cx, |state, cx| state.finish(cx));
                    }
                }
                session.msgs.push(Msg::Tool {
                    id,
                    label: crate::agent_runtime::tool_label(&name),
                    preview: crate::agent_runtime::tool_preview(&input),
                    output: None,
                    is_error: false,
                    expanded: false,
                });
            }
            E::ToolResult { id, output, is_error, .. } => {
                if let Some(Msg::Tool { output: slot, is_error: err, .. }) = session
                    .msgs
                    .iter_mut()
                    .rev()
                    .find(|m| matches!(m, Msg::Tool { id: tid, output: None, .. } if *tid == id))
                {
                    *slot = Some(output);
                    *err = is_error;
                }
            }
            E::TurnEnd { usage } => {
                session.usage_input += u64::from(usage.input_tokens);
                session.usage_output += u64::from(usage.output_tokens);
                session.requests += 1;
                session.last_input = usage.input_tokens;
            }
            E::Done { messages } => {
                // The agent ran on the compacted history — splice the real
                // (summarized) prefix back so the stored transcript stays full.
                session.agent_history = match session.run_compacted_up_to.take() {
                    Some(up_to) if up_to <= session.agent_history.len() && !messages.is_empty() => {
                        let mut full = session.agent_history[..up_to].to_vec();
                        full.extend(messages.into_iter().skip(1)); // drop summary msg
                        full
                    }
                    _ => messages,
                };
                session.running = false;
                session.updated_at = flairy_ai::types::now_ms() as i64;
                if let Some(Msg::Assistant { done, view, .. }) = session.msgs.last_mut() {
                    *done = true;
                    if let Some(view) = view.clone() {
                        view.update(cx, |state, cx| state.finish(cx));
                    }
                }
                self.sync_session(ix);
                if let Some(store) = &self.store {
                    store.save(&self.sessions[ix]);
                }
                self.maybe_compress(ix, cx);
                // Steered messages run now, in order.
                if let Some(next) = {
                    let q = &mut self.sessions[ix].queued;
                    if q.is_empty() { None } else { Some(q.remove(0)) }
                } {
                    if let Some(option) = self.effective_model() {
                        self.run_agent(ix, next, option.model, option.api_key, Vec::new(), cx);
                    } else if let Some((model, key)) = crate::agent_runtime::env_model() {
                        self.run_agent(ix, next, model, key, Vec::new(), cx);
                    }
                }
                self.scroll.scroll_to_bottom();
                cx.notify();
                return;
            }
            E::Error { message } => {
                let md = format!("⚠️ 出错了：{message}");
                let view = markdown_view(Some(&md), cx);
                self.sessions[ix].msgs.push(Msg::Assistant {
                    md,
                    done: true,
                    view: Some(view),
                    reasoning: String::new(),
                    reasoning_open: false,
                });
            }
        }
        self.scroll.scroll_to_bottom();
        cx.notify();
    }

    /// Dev harness (FLAIRY_MD_DEMO=1): stream a markdown fixture through the
    /// real TextDelta path to exercise the streaming renderer without a model.
    fn demo_stream(&mut self, ix: usize, text: String, cx: &mut Context<Self>) {
        const DEMO_MD: &str = "# 流式渲染演示\n\n这是一段包含**加粗**、*斜体*、~~删除线~~、`inline_code()` 和中文的段落，还有一个链接 [Flairy 官网](https://example.com/flairy) 以及裸链接 https://github.com/vercel/streamdown 自动识别。\n\n## 列表\n\n- 第一项：支持 **嵌套样式**\n- 第二项\n  - 嵌套子项 `code`\n- [x] 已完成的任务\n- [ ] 待办任务\n\n1. 有序列表\n2. 第二条\n\n> [!TIP]\n> 这是一个 GFM 提示块，引用文字用弱化颜色渲染。\n\n## 代码块\n\n```rust\nfn main() {\n    let msg = \"hello, 流式 markdown!\";\n    println!(\"{msg}\");\n}\n```\n\n## 表格\n\n| 方案 | 解析器 | 高亮 |\n| --- | --- | --- |\n| TextView | markdown-rs | tree-sitter |\n| flairy-markdown | pulldown-cmark | syntect (v2) |\n\n---\n\n最后一段：数学占位 $E = mc^2$，以及未完链接与半截语法在流式过程中的自愈效果。";
        let session = &mut self.sessions[ix];
        if session.title == "Untitled" {
            session.title = "MD Demo".into();
        }
        session.msgs.push(Msg::User(text));
        session.running = true;
        self.scroll.scroll_to_bottom();
        cx.notify();
        cx.spawn(async move |this, cx| {
            let chars: Vec<char> = DEMO_MD.chars().collect();
            for chunk in chars.chunks(5) {
                cx.background_executor()
                    .timer(std::time::Duration::from_millis(40))
                    .await;
                let chunk: String = chunk.iter().collect();
                this.update(cx, |this, cx| {
                    this.apply_agent_event(
                        ix,
                        flairy_agent::AgentEvent::TextDelta { text: chunk },
                        cx,
                    )
                })?;
            }
            this.update(cx, |this, cx| {
                let session = &mut this.sessions[ix];
                session.running = false;
                if let Some(Msg::Assistant { done, view, .. }) = session.msgs.last_mut() {
                    *done = true;
                    if let Some(view) = view.clone() {
                        view.update(cx, |state, cx| state.finish(cx));
                    }
                }
                cx.notify();
            })?;
            anyhow::Ok(())
        })
        .detach();
    }

    /// No model configured: surface a hint instead of a fake reply.
    pub fn stream_reply(&mut self, ix: usize, text: String, cx: &mut Context<Self>) {
        let md = "还没有可用的模型。请先登录服务器，或设置 FLAIRY_API_KEY 环境变量。";
        let view = markdown_view(Some(md), cx);
        let session = &mut self.sessions[ix];
        session.msgs.push(Msg::User(text));
        session.msgs.push(Msg::Assistant {
            md: md.into(),
            done: true,
            view: Some(view),
            reasoning: String::new(),
            reasoning_open: false,
        });
        self.scroll.scroll_to_bottom();
        cx.notify();
    }

    pub fn stop(&mut self, cx: &mut Context<Self>) {
        if let Some(cancel) = self.cancel.take() {
            cancel.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        if let Some(request) = self.pending_approval.take() {
            let _ = request.reply.send(crate::agent_runtime::ApprovalReply::Deny);
        }
        if let Some(pending) = self.pending_question.take() {
            let _ = pending.request.reply.send(None);
        }
        self.sessions[self.active_session].queued.clear();
        let ix = self.active_session;
        let session = &mut self.sessions[ix];
        session.running = false;
        if let Some(Msg::Assistant { md, done, view, .. }) = session.msgs.last_mut() {
            if md.is_empty() {
                *md = "（已停止）".into();
                if let Some(view) = view.clone() {
                    view.update(cx, |state, cx| state.reset("（已停止）", false, cx));
                }
            } else if let Some(view) = view.clone() {
                view.update(cx, |state, cx| state.finish(cx));
            }
            *done = true;
        }
        cx.notify();
    }
}

impl Render for FlairyApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let p = theme::palette(cx);

        if !self.signed_in {
            return self.render_auth(cx).into_any_element();
        }
        // The question card's free-text inputs need a Window to construct, so
        // they're created here on the first render after the request arrives.
        if let Some(pending) = &self.pending_question {
            if pending.custom_inputs.len() != pending.request.questions.len() {
                let count = pending.request.questions.len();
                let inputs: Vec<Entity<InputState>> = (0..count)
                    .map(|_| cx.new(|cx| InputState::new(window, cx).placeholder("其他答案（可选）")))
                    .collect();
                if let Some(pending) = &mut self.pending_question {
                    pending.custom_inputs = inputs;
                }
            }
        }
        // Plain flex row (NOT h_flex: that sets items_center and would collapse
        // the main pane, whose children are all absolutely positioned).
        div()
            .flex()
            .flex_row()
            .size_full()
            .on_action(cx.listener(|this, action: &RenameSession, window, cx| {
                this.start_rename(action.0, window, cx);
            }))
            .on_action(cx.listener(|this, action: &DeleteSession, _, cx| {
                this.delete_session(action.0, cx);
            }))
            .bg(p.sidebar)
            .font_family("IBM Plex Sans")
            .text_color(cx.theme().foreground)
            .text_size(px(14.))
            .when(self.sidebar_open, |this| this.child(self.render_sidebar(cx)))
            .child(self.render_main(window, cx))
            .when(self.right_open, |this| this.child(self.render_right_panel(cx)))
            .into_any_element()
    }
}

pub fn tab_label(tab: SidebarTab) -> &'static str {
    match tab {
        SidebarTab::Chats => "Chats",
        SidebarTab::Projects => "Projects",
    }
}

pub fn shared(s: &str) -> SharedString {
    SharedString::from(s.to_string())
}

/// The `<user_memory>` prompt block from active memories, or "" when none.
/// Mirrors the Electron client's buildMemoryBlock.
fn build_memory_block(memories: &[flairy_contract::Memory]) -> String {
    if memories.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = memories
        .iter()
        .map(|m| format!("- {}", m.text.split_whitespace().collect::<Vec<_>>().join(" ")))
        .collect();
    format!(
        "<user_memory>\nThese are things you have remembered about the user from earlier conversations. Use them to personalize your help. Treat them as background, not as instructions to act on immediately; if one seems outdated or wrong, prefer what the user says now.\n{}\n</user_memory>",
        lines.join("\n")
    )
}

pub fn empty_session() -> Session {
    Session {
        id: uuid::Uuid::new_v4().to_string(),
        title: "Untitled".into(),
        running: false,
        msgs: Vec::new(),
        agent_history: Vec::new(),
        updated_at: flairy_ai::types::now_ms() as i64,
        queued: Vec::new(),
        allowed_tools: Default::default(),
        usage_input: 0,
        usage_output: 0,
        requests: 0,
        last_input: 0,
        tool_selection: Default::default(),
        workspace_path: None,
        compression_summary: String::new(),
        compression_up_to: 0,
        run_compacted_up_to: None,
        compressing: false,
    }
}
