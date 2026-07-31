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
    },
    /// Live tool call from the real agent.
    Tool { label: String, preview: String, output: Option<String>, is_error: bool },
}

/// New markdown entity wired to re-render (and follow) the chat when a
/// background parse lands.
pub fn markdown_view(
    initial: Option<&str>,
    cx: &mut Context<FlairyApp>,
) -> Entity<flairy_markdown::MarkdownState> {
    let entity = cx.new(|_| match initial {
        Some(text) => flairy_markdown::MarkdownState::new_static(text),
        None => flairy_markdown::MarkdownState::new(),
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
    // Cumulative usage for the stats panel (not persisted).
    pub usage_input: u64,
    pub usage_output: u64,
    pub requests: u32,
    /// input_tokens of the latest turn ≈ current context size.
    pub last_input: u32,
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
    pub sync_tx: Option<tokio::sync::mpsc::UnboundedSender<crate::server_client::Outgoing>>,
    /// User-picked model option (model.id); falls back to llm.main.
    pub model_choice: Option<String>,
    pub model_menu_open: bool,
    /// Session being renamed inline, if any.
    pub renaming: Option<usize>,
    pub rename_input: Entity<InputState>,

    pub store: Option<crate::store::Store>,
    pub mcp: std::sync::Arc<crate::mcp::McpManager>,
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
        let email_input = cx.new(|cx| InputState::new(window, cx).placeholder("邮箱"));
        let password_input = cx.new(|cx| InputState::new(window, cx).masked(true).placeholder("密码"));
        let store = crate::store::Store::open();
        let persisted = store.as_ref().map(|s| s.load_all()).unwrap_or_default();
        let sessions = if persisted.is_empty() { vec![empty_session()] } else { persisted };
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
            sync_tx: None,
            model_choice: None,
            model_menu_open: false,
            renaming: None,
            rename_input,
            store,
            mcp: std::sync::Arc::new(crate::mcp::McpManager::new()),
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
        if let Some(creds) = crate::server_client::stored_or_env_credentials() {
            this.signed_in = true;
            this.start_connection(creds, cx);
        }
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
            SE::Config(config) => {
                self.mcp.apply(config.mcp_servers.clone());
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
                        });
                        self.active_session += 1; // keep the user's current view
                        if let Some(store) = &self.store {
                            store.save(&self.sessions[0]);
                        }
                    }
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
        if let Some(tx) = &self.sync_tx {
            let _ = tx.send(crate::server_client::Outgoing::Delete { session_id: session.id });
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
        if let Some(option) = self.effective_model() {
            self.run_agent(self.active_session, text, option.model, option.api_key, cx);
        } else if let Some((model, key)) = crate::agent_runtime::env_model() {
            self.run_agent(self.active_session, text, model, key, cx);
        } else {
            self.stream_reply(self.active_session, text, cx);
        }
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
        cx: &mut Context<Self>,
    ) {
        let session = &mut self.sessions[ix];
        if session.title == "Untitled" {
            session.title = text.chars().take(16).collect();
        }
        session.msgs.push(Msg::User(text.clone()));
        session.running = true;
        let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        self.cancel = Some(cancel.clone());
        self.scroll.scroll_to_bottom();
        cx.notify();

        let history = session.agent_history.clone();
        let system_prompt = self.server_config.as_ref().and_then(|c| c.system_prompt.clone());
        let allowed = self.sessions[ix].allowed_tools.clone();
        let (mut rx, mut approval_rx) = crate::agent_runtime::spawn_agent(
            model, key, history, text, cancel, system_prompt, self.mcp.tools(), allowed,
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
                    Some(Msg::Assistant { md, done, view }) if !*done => {
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
                        });
                    }
                }
            }
            E::ToolCallStart { name, input, .. } => {
                // Close an empty in-progress assistant bubble before the tool row.
                if matches!(session.msgs.last(), Some(Msg::Assistant { md, done, .. }) if md.is_empty() && !done) {
                    session.msgs.pop();
                } else if let Some(Msg::Assistant { done, view, .. }) = session.msgs.last_mut() {
                    *done = true;
                    if let Some(view) = view.clone() {
                        view.update(cx, |state, cx| state.finish(cx));
                    }
                }
                session.msgs.push(Msg::Tool {
                    label: crate::agent_runtime::tool_label(&name),
                    preview: crate::agent_runtime::tool_preview(&input),
                    output: None,
                    is_error: false,
                });
            }
            E::ToolResult { output, is_error, .. } => {
                if let Some(Msg::Tool { output: slot, is_error: err, .. }) =
                    session.msgs.iter_mut().rev().find(|m| matches!(m, Msg::Tool { output: None, .. }))
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
                session.agent_history = messages;
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
                // Steered messages run now, in order.
                if let Some(next) = {
                    let q = &mut self.sessions[ix].queued;
                    if q.is_empty() { None } else { Some(q.remove(0)) }
                } {
                    if let Some(option) = self.effective_model() {
                        self.run_agent(ix, next, option.model, option.api_key, cx);
                    } else if let Some((model, key)) = crate::agent_runtime::env_model() {
                        self.run_agent(ix, next, model, key, cx);
                    }
                }
                self.scroll.scroll_to_bottom();
                cx.notify();
                return;
            }
            E::Error { message } => {
                let md = format!("⚠️ 出错了：{message}");
                let view = markdown_view(Some(&md), cx);
                self.sessions[ix].msgs.push(Msg::Assistant { md, done: true, view: Some(view) });
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
        session.msgs.push(Msg::Assistant { md: md.into(), done: true, view: Some(view) });
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
        self.sessions[self.active_session].queued.clear();
        let ix = self.active_session;
        let session = &mut self.sessions[ix];
        session.running = false;
        if let Some(Msg::Assistant { md, done, view }) = session.msgs.last_mut() {
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
    }
}
