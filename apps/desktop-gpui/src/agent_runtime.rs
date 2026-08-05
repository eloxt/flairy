//! Bridges flairy-agent (tokio, worker thread) into the GPUI app.
//! Real agent runs when FLAIRY_API_KEY / ANTHROPIC_API_KEY is set; the UI
//! falls back to the typewriter mock otherwise.

use flairy_agent::{Agent, AgentEvent, ApprovalDecision, ApprovalGate, Message, Tool, ToolOutput};
use flairy_ai::Model;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

/// User's decision for a pending tool call.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ApprovalReply {
    Deny,
    /// Allow this call only.
    Once,
    /// Allow this tool for the rest of the session.
    Always,
}

/// A tool call waiting for user confirmation; reply over the sync channel.
pub struct ApprovalRequest {
    #[allow(dead_code)] // kept for tool-level policies/UI
    pub tool_name: String,
    pub label: String,
    pub detail: String,
    pub reply: std::sync::mpsc::Sender<ApprovalReply>,
}

/// Gates dangerous tools (bash) behind the UI approval card; read-only tools
/// pass through. check() blocks the agent worker until the user decides.
struct UiGate {
    tx: UnboundedSender<ApprovalRequest>,
    /// Session-scoped "always allow" memory, shared with the app.
    allowed: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    /// Headless (scheduled) turn: gated tools are denied, never prompted.
    auto_deny: bool,
}

impl ApprovalGate for UiGate {
    fn check(&self, tool_name: &str, input: &serde_json::Value) -> ApprovalDecision {
        // Read-only builtins pass; bash, file mutations, and all MCP tools ask
        // (allowlist inversion — unknown tools are gated by default).
        if matches!(
            tool_name,
            "read_file" | "list_dir" | "grep" | "find" | "web_search" | "web_fetch" | "ask"
                | "todo_write" | "remember" | "schedule"
        ) {
            return ApprovalDecision::Allow;
        }
        if std::env::var("FLAIRY_YOLO").is_ok() {
            return ApprovalDecision::Allow;
        }
        if self.allowed.lock().unwrap().contains(tool_name) {
            return ApprovalDecision::Allow;
        }
        if self.auto_deny {
            return ApprovalDecision::Deny; // no one is at the keyboard
        }
        let detail = input["command"]
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| serde_json::to_string_pretty(input).unwrap_or_default());
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        let request = ApprovalRequest {
            tool_name: tool_name.to_string(),
            label: tool_label(tool_name),
            detail,
            reply: reply_tx,
        };
        if self.tx.send(request).is_err() {
            return ApprovalDecision::Deny;
        }
        match reply_rx.recv() {
            Ok(ApprovalReply::Once) => ApprovalDecision::Allow,
            Ok(ApprovalReply::Always) => {
                self.allowed.lock().unwrap().insert(tool_name.to_string());
                ApprovalDecision::Allow
            }
            _ => ApprovalDecision::Deny,
        }
    }
}

#[derive(Clone)]
pub struct AskOption {
    pub label: String,
    pub description: Option<String>,
}

#[derive(Clone)]
pub struct AskQuestionSpec {
    pub question: String,
    pub header: Option<String>,
    pub options: Vec<AskOption>,
    pub multi_select: bool,
}

/// One question's answer: picked option labels + optional free text.
#[derive(Clone, serde::Serialize)]
pub struct AskAnswer {
    pub selected: Vec<String>,
    pub custom: Option<String>,
}

/// A blocked `ask` tool call waiting for the user; reply None on cancel.
pub struct QuestionRequest {
    pub questions: Vec<AskQuestionSpec>,
    pub reply: std::sync::mpsc::Sender<Option<Vec<AskAnswer>>>,
}

/// ask — pause the turn and ask the user multiple-choice questions (mirrors
/// the Electron client's ask tool). Blocks the tool thread until answered;
/// exempt from the approval gate (asking is inherently safe).
struct AskTool {
    tx: UnboundedSender<QuestionRequest>,
}

impl Tool for AskTool {
    fn name(&self) -> &str {
        "ask"
    }
    fn label(&self) -> &str {
        "询问"
    }
    fn description(&self) -> &str {
        "Ask the user one or more multiple-choice questions and wait for their answer. Use this only for genuine decisions where you need the user to choose a direction — not for things you can figure out yourself. Each question shows the options you provide; the user may also type their own answer instead of picking one. This blocks until the user responds, then returns what they chose."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "description": "One or more questions to ask the user.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": {"type": "string", "description": "The question to ask the user, in plain language."},
                            "header": {"type": "string", "description": "A short label/category for the question (optional)."},
                            "options": {
                                "type": "array",
                                "description": "The choices to offer.",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": {"type": "string", "description": "The option text shown to the user."},
                                        "description": {"type": "string", "description": "A short clarification shown under the option (optional)."}
                                    },
                                    "required": ["label"]
                                }
                            },
                            "multiSelect": {"type": "boolean", "description": "Set true to let the user pick more than one option."}
                        },
                        "required": ["question", "options"]
                    }
                }
            },
            "required": ["questions"]
        })
    }
    fn execute(&self, input: serde_json::Value) -> anyhow::Result<ToolOutput> {
        let raw = input
            .get("questions")
            .and_then(|q| q.as_array())
            .cloned()
            .unwrap_or_default();
        if raw.is_empty() {
            anyhow::bail!("ask requires at least one question");
        }
        let mut questions = Vec::with_capacity(raw.len());
        for (i, q) in raw.iter().enumerate() {
            let question = q
                .get("question")
                .and_then(|s| s.as_str())
                .map(str::to_string)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| anyhow::anyhow!("Question {} is missing its \"question\" text", i + 1))?;
            let options: Vec<AskOption> = q
                .get("options")
                .and_then(|o| o.as_array())
                .map(|list| {
                    list.iter()
                        .filter_map(|o| {
                            let label = o.get("label")?.as_str()?.to_string();
                            (!label.is_empty()).then(|| AskOption {
                                label,
                                description: o
                                    .get("description")
                                    .and_then(|d| d.as_str())
                                    .map(str::to_string),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            if options.is_empty() {
                anyhow::bail!("Question \"{question}\" must have at least one option");
            }
            questions.push(AskQuestionSpec {
                question,
                header: q.get("header").and_then(|h| h.as_str()).map(str::to_string),
                options,
                multi_select: q.get("multiSelect").and_then(|m| m.as_bool()).unwrap_or(false),
            });
        }

        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        let request = QuestionRequest { questions: questions.clone(), reply: reply_tx };
        if self.tx.send(request).is_err() {
            anyhow::bail!("User cancelled the question");
        }
        let Ok(Some(answers)) = reply_rx.recv() else {
            anyhow::bail!("User cancelled the question");
        };
        let lines: Vec<String> = questions
            .iter()
            .zip(answers.iter())
            .map(|(q, a)| {
                let mut parts: Vec<String> = Vec::new();
                if !a.selected.is_empty() {
                    parts.push(a.selected.join(", "));
                }
                if let Some(custom) = a.custom.as_ref().filter(|c| !c.is_empty()) {
                    parts.push(format!("(other: {custom})"));
                }
                let answer = if parts.is_empty() { "(no answer)".to_string() } else { parts.join(" ") };
                format!("Q: {}\nA: {answer}", q.question)
            })
            .collect();
        Ok(ToolOutput {
            content: lines.join("\n\n"),
            details: serde_json::json!({"answers": answers}),
        })
    }
}

/// todo_write — record/replace the agent's structured plan. State-free: the
/// plan rides in the returned JSON sentinel (crate::todo), so it persists and
/// syncs with the message history. Approval-exempt (records a plan only).
struct TodoWriteTool;

impl Tool for TodoWriteTool {
    fn name(&self) -> &str {
        "todo_write"
    }
    fn label(&self) -> &str {
        "计划"
    }
    fn description(&self) -> &str {
        "Create and manage a structured task list for the current work, so the user can see your plan and progress. Call it at the START of a non-trivial, multi-step task to lay out the steps, then call it AGAIN to update statuses as you go. Always pass the COMPLETE list every time — it REPLACES the previous list, it does not append. Each item has `content` (a short imperative step) and `status` (\"pending\", \"in_progress\", or \"completed\"). Keep EXACTLY ONE item \"in_progress\" at a time, and flip an item to \"completed\" the moment it is done — before starting the next. Skip this tool for trivial single-step requests, greetings, or pure questions."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "description": "The full, ordered task list. Pass every task every time — this replaces the previous list.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "content": {"type": "string", "minLength": 1, "description": "A short imperative description of the task."},
                            "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]},
                            "activeForm": {"type": "string", "description": "Optional present-tense label shown while this task is in progress."}
                        },
                        "required": ["content", "status"]
                    }
                }
            },
            "required": ["todos"],
            "additionalProperties": false
        })
    }
    fn execute(&self, input: serde_json::Value) -> anyhow::Result<ToolOutput> {
        let list: Vec<crate::todo::TodoItem> = input
            .get("todos")
            .and_then(|t| t.as_array())
            .map(|todos| {
                todos
                    .iter()
                    .filter_map(|t| {
                        let content =
                            t.get("content").and_then(|c| c.as_str())?.trim().to_string();
                        if content.is_empty() {
                            return None;
                        }
                        let status = match t.get("status").and_then(|s| s.as_str()) {
                            Some("in_progress") => crate::todo::TodoStatus::InProgress,
                            Some("completed") => crate::todo::TodoStatus::Completed,
                            _ => crate::todo::TodoStatus::Pending,
                        };
                        Some(crate::todo::TodoItem {
                            content,
                            status,
                            active_form: t
                                .get("activeForm")
                                .and_then(|a| a.as_str())
                                .map(str::trim)
                                .filter(|a| !a.is_empty())
                                .map(str::to_string),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        if list.is_empty() {
            anyhow::bail!("todo_write requires a non-empty \"todos\" array of tasks.");
        }
        Ok(ToolOutput {
            content: crate::todo::encode_todos(&list),
            details: serde_json::json!({"count": list.len()}),
        })
    }
}

/// remember — durably record a fact/preference about the user (mirrors the
/// Electron client's memory tool). Write-only: persisting + syncing happens
/// app-side via the channel. Approval-exempt (writes only to the user's own
/// memory store).
struct RememberTool {
    session_id: String,
    tx: UnboundedSender<flairy_contract::Memory>,
}

impl Tool for RememberTool {
    fn name(&self) -> &str {
        "remember"
    }
    fn label(&self) -> &str {
        "记住"
    }
    fn description(&self) -> &str {
        "Save a fact or preference about the user that should be remembered in future conversations. Use this proactively when you learn something durable and reusable — how they like answers (tone, length, language), stable facts about them or their work, or recurring preferences. Do NOT record one-off task details, secrets/passwords, or things that are only relevant right now. Keep each memory a single short, self-contained statement. Avoid duplicating something you already remember."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "text": {"type": "string", "description": "The single fact or preference to remember, as a short self-contained statement."},
                "type": {
                    "type": "string",
                    "enum": ["preference", "fact", "profile"],
                    "description": "Category: 'preference' (how they like things done), 'fact' (a stable fact about them/their work), or 'profile' (identity/role). Defaults to 'fact'."
                }
            },
            "required": ["text"]
        })
    }
    fn execute(&self, input: serde_json::Value) -> anyhow::Result<ToolOutput> {
        let statement = input
            .get("text")
            .and_then(|t| t.as_str())
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if statement.is_empty() {
            anyhow::bail!("remember requires a non-empty \"text\" statement");
        }
        let kind = match input.get("type").and_then(|t| t.as_str()) {
            Some(k @ ("preference" | "fact" | "profile")) => k.to_string(),
            _ => "fact".to_string(),
        };
        let now = flairy_ai::types::now_ms() as i64;
        let memory = flairy_contract::Memory {
            id: uuid::Uuid::new_v4().to_string(),
            kind,
            text: statement.clone(),
            source: Some(self.session_id.clone()),
            created_at: now,
            updated_at: now,
            deleted_at: None,
        };
        let details = serde_json::json!({"memory": &memory});
        let _ = self.tx.send(memory);
        Ok(ToolOutput {
            content: format!("Got it — I'll remember that: \"{statement}\""),
            details,
        })
    }
}

struct BashTool {
    /// Project workspace; commands run with this as their working directory.
    cwd: Option<String>,
}
impl Tool for BashTool {
    fn name(&self) -> &str {
        "bash"
    }
    fn label(&self) -> &str {
        "运行命令"
    }
    fn description(&self) -> &str {
        "Run a shell command with sh -c and return stdout+stderr."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"]
        })
    }
    fn execute(&self, input: serde_json::Value) -> anyhow::Result<ToolOutput> {
        let command = input["command"].as_str().unwrap_or_default();
        let mut process = std::process::Command::new("sh");
        process.arg("-c").arg(command);
        if let Some(cwd) = self.cwd.as_ref().filter(|c| std::path::Path::new(c).is_dir()) {
            process.current_dir(cwd);
        }
        let out = process.output()?;
        let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
        text.push_str(&String::from_utf8_lossy(&out.stderr));
        let truncated: String = text.chars().take(20_000).collect();
        Ok(ToolOutput { content: truncated, details: serde_json::json!({"command": command}) })
    }
}

const SYSTEM_PROMPT: &str = "你是 Flairy，一个友好的中文助手。回答使用 Markdown。需要查看本地文件时使用提供的工具。";

pub fn env_model() -> Option<(Model, String)> {
    let key = std::env::var("FLAIRY_API_KEY")
        .or_else(|_| std::env::var("ANTHROPIC_API_KEY"))
        .ok()?;
    let api = std::env::var("FLAIRY_API").unwrap_or_else(|_| "anthropic".into());
    let (api_id, default_base, default_model) = if api == "openai" {
        (flairy_ai::API_OPENAI, "https://api.openai.com/v1", "gpt-4o-mini")
    } else {
        (flairy_ai::API_ANTHROPIC, "https://api.anthropic.com", "claude-sonnet-4-5")
    };
    let model = Model {
        api: api_id.to_string(),
        provider: api,
        id: std::env::var("FLAIRY_MODEL").unwrap_or_else(|_| default_model.into()),
        base_url: std::env::var("FLAIRY_BASE_URL").unwrap_or_else(|_| default_base.into()),
        max_tokens: 8192,
    };
    Some((model, key))
}

struct ReadFileTool;
impl Tool for ReadFileTool {
    fn name(&self) -> &str {
        "read_file"
    }
    fn label(&self) -> &str {
        "读取文件"
    }
    fn description(&self) -> &str {
        "Read a UTF-8 text file from the local filesystem."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {"path": {"type": "string", "description": "absolute file path"}},
            "required": ["path"]
        })
    }
    fn execute(&self, input: serde_json::Value) -> anyhow::Result<ToolOutput> {
        let path = input["path"].as_str().unwrap_or_default();
        let content = std::fs::read_to_string(path)?;
        let truncated: String = content.chars().take(20_000).collect();
        Ok(ToolOutput { content: truncated, details: serde_json::json!({"path": path}) })
    }
}

struct ListDirTool;
impl Tool for ListDirTool {
    fn name(&self) -> &str {
        "list_dir"
    }
    fn label(&self) -> &str {
        "列出目录"
    }
    fn description(&self) -> &str {
        "List entries of a local directory."
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {"path": {"type": "string", "description": "absolute directory path"}},
            "required": ["path"]
        })
    }
    fn execute(&self, input: serde_json::Value) -> anyhow::Result<ToolOutput> {
        let path = input["path"].as_str().unwrap_or_default();
        let mut names: Vec<String> = std::fs::read_dir(path)?
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        Ok(ToolOutput { content: names.join("\n"), details: serde_json::json!({"path": path}) })
    }
}

/// Runs the agent on a dedicated tokio runtime thread; events flow back over
/// the returned channel (consumed from gpui's executor — tokio channels don't
/// need the tokio runtime on the receiving side).
pub fn spawn_agent(
    model: Model,
    api_key: String,
    history: Vec<Message>,
    user_message: Message,
    cancel: Arc<AtomicBool>,
    system_prompt: Option<String>,
    extra_tools: Vec<Arc<dyn Tool>>,
    allowed: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    exa: Option<crate::server_client::ExaConfig>,
    session_id: String,
    // When set, only these tools (plus the SELECTION_FLOOR) are offered.
    selected_tools: Option<std::collections::HashSet<String>>,
    // Project workspace directory (None ⇒ plain chat).
    workspace: Option<String>,
    // Scheduled (headless) turn: gated tools auto-deny.
    headless: bool,
) -> (
    UnboundedReceiver<AgentEvent>,
    UnboundedReceiver<ApprovalRequest>,
    UnboundedReceiver<QuestionRequest>,
    UnboundedReceiver<flairy_contract::Memory>,
    UnboundedReceiver<crate::schedule::ScheduleRequest>,
) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let (approval_tx, approval_rx) = tokio::sync::mpsc::unbounded_channel();
    let (question_tx, question_rx) = tokio::sync::mpsc::unbounded_channel();
    let (memory_tx, memory_rx) = tokio::sync::mpsc::unbounded_channel();
    let (schedule_tx, schedule_rx) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime");
        runtime.block_on(async move {
            let mut prompt = system_prompt.unwrap_or_else(|| SYSTEM_PROMPT.to_string());
            if let Some(workspace) = &workspace {
                prompt.push_str(&format!(
                    "\n\n<workspace>\nCurrent project directory: {workspace}\nShell commands run with this as their working directory. Use absolute paths when calling file tools.\n</workspace>"
                ));
            }
            let mut agent = Agent::new(
                model,
                prompt,
                Arc::new(move |_provider: &str| Some(api_key.clone())),
            )
            .with_tools({
                let mut tools: Vec<Arc<dyn Tool>> = vec![
                    Arc::new(ReadFileTool),
                    Arc::new(ListDirTool),
                    Arc::new(BashTool { cwd: workspace.clone() }),
                    Arc::new(AskTool { tx: question_tx }),
                    Arc::new(TodoWriteTool),
                    Arc::new(RememberTool { session_id: session_id.clone(), tx: memory_tx }),
                    Arc::new(crate::schedule::ScheduleTool { session_id, tx: schedule_tx }),
                    Arc::new(crate::file_tools::WriteFileTool),
                    Arc::new(crate::file_tools::EditFileTool),
                    Arc::new(crate::file_tools::GrepTool),
                    Arc::new(crate::file_tools::FindTool),
                ];
                if let Some(exa) = exa {
                    // Citation ids are unique across this run: both tools share
                    // the allocator.
                    let ids = Arc::new(crate::web_tools::TurnIds::default());
                    tools.push(Arc::new(crate::web_tools::WebSearchTool {
                        exa: exa.clone(),
                        ids: ids.clone(),
                    }));
                    tools.push(Arc::new(crate::web_tools::WebFetchTool { exa, ids }));
                }
                tools.extend(extra_tools);
                if let Some(selected) = &selected_tools {
                    tools.retain(|t| {
                        SELECTION_FLOOR.contains(&t.name()) || selected.contains(t.name())
                    });
                }
                tools
            })
            .with_approval(Arc::new(UiGate { tx: approval_tx, allowed, auto_deny: headless }))
            .with_messages(history);
            agent.run_message(user_message, tx, cancel).await;
        });
    });
    (rx, approval_rx, question_rx, memory_rx, schedule_rx)
}

/// Tools every turn keeps regardless of what the selector picks (mirrors the
/// Electron floor set, adapted to this client's tool names).
pub const SELECTION_FLOOR: [&str; 4] = ["ask", "read_file", "todo_write", "remember"];

/// Ask the `tool` model which tools the next turn needs (10s timeout).
/// Resolves None on ANY failure — the caller must fail open to all tools.
/// Mirrors agent-service.ts selectTools.
pub fn select_tools(
    model: Model,
    api_key: String,
    system_prompt: String,
    catalog: Vec<(String, String)>,
    recent: String,
    user_text: String,
) -> tokio::sync::oneshot::Receiver<Option<Vec<String>>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build()
        else {
            let _ = tx.send(None);
            return;
        };
        let catalog_names: std::collections::HashSet<String> =
            catalog.iter().map(|(name, _)| name.clone()).collect();
        let tool_lines: String = catalog
            .iter()
            .map(|(name, description)| {
                let first_line = description.lines().next().unwrap_or_default();
                format!("{name}: {first_line}")
            })
            .collect::<Vec<_>>()
            .join("\n");
        let content = format!(
            "<available_tools>\n{tool_lines}\n</available_tools>\n\n{}<user_message>\n{user_text}\n</user_message>\n\n\
             Select the tools needed for the assistant's next turn. Respond with ONLY a JSON object \
             of the form {{\"tools\": [\"tool_name\", ...]}} — no prose, no code fences. Use exact tool \
             names from <available_tools>. Return {{\"tools\": []}} if no tools are needed.",
            if recent.is_empty() {
                String::new()
            } else {
                format!("<recent_conversation>\n{recent}\n</recent_conversation>\n\n")
            }
        );
        let result = runtime.block_on(async move {
            let registry = flairy_ai::ApiRegistry::with_builtins();
            let mut model = model;
            model.max_tokens = 256;
            let messages = vec![flairy_ai::Message {
                role: flairy_ai::Role::User,
                content: vec![flairy_ai::ContentBlock::Text { text: content }],
                timestamp: flairy_ai::types::now_ms(),
            }];
            let opts = flairy_ai::StreamOptions {
                get_api_key: Arc::new(move |_| Some(api_key.clone())),
                cancel: Arc::new(AtomicBool::new(false)),
            };
            tokio::time::timeout(
                std::time::Duration::from_secs(10),
                flairy_ai::stream_simple(
                    &registry,
                    &model,
                    &system_prompt,
                    &messages,
                    &[],
                    &opts,
                    &mut |_| {},
                ),
            )
            .await
        });
        let selected = match result {
            Ok(Ok(turn)) => {
                let raw: String = turn
                    .blocks
                    .iter()
                    .filter_map(|b| match b {
                        flairy_ai::ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect();
                parse_tool_selection(&raw)
                    .map(|names| names.into_iter().filter(|n| catalog_names.contains(n)).collect())
            }
            _ => None,
        };
        let _ = tx.send(selected);
    });
    rx
}

/// Extract {"tools": [...]} from the model reply, tolerating code fences and
/// surrounding prose. None → caller fails open.
fn parse_tool_selection(raw: &str) -> Option<Vec<String>> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    let v: serde_json::Value = serde_json::from_str(&raw[start..=end]).ok()?;
    Some(
        v.get("tools")?
            .as_array()?
            .iter()
            .filter_map(|t| t.as_str())
            .map(str::to_string)
            .collect(),
    )
}

/// Summarize an older conversation prefix on the `tool` model (context
/// compression). Resolves None on any failure — compression is best-effort.
pub fn summarize_history(
    model: Model,
    api_key: String,
    system_prompt: String,
    transcript: String,
) -> tokio::sync::oneshot::Receiver<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build()
        else {
            let _ = tx.send(None);
            return;
        };
        let result = runtime.block_on(async move {
            let registry = flairy_ai::ApiRegistry::with_builtins();
            let mut model = model;
            model.max_tokens = 2048;
            let messages = vec![flairy_ai::Message {
                role: flairy_ai::Role::User,
                content: vec![flairy_ai::ContentBlock::Text { text: transcript }],
                timestamp: flairy_ai::types::now_ms(),
            }];
            let opts = flairy_ai::StreamOptions {
                get_api_key: Arc::new(move |_| Some(api_key.clone())),
                cancel: Arc::new(AtomicBool::new(false)),
            };
            tokio::time::timeout(
                std::time::Duration::from_secs(60),
                flairy_ai::stream_simple(
                    &registry,
                    &model,
                    &system_prompt,
                    &messages,
                    &[],
                    &opts,
                    &mut |_| {},
                ),
            )
            .await
        });
        let summary = match result {
            Ok(Ok(turn)) => {
                let text: String = turn
                    .blocks
                    .iter()
                    .filter_map(|b| match b {
                        flairy_ai::ContentBlock::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect();
                let text = text.trim().to_string();
                (!text.is_empty()).then_some(text)
            }
            _ => None,
        };
        let _ = tx.send(summary);
    });
    rx
}

/// Best-effort one-shot title generation on the `tool` model (mirrors the
/// Electron client's maybeGenerateTitle). Resolves None on any failure —
/// title chores must never surface as chat errors.
pub fn generate_title(
    model: Model,
    api_key: String,
    system_prompt: String,
    first_message: String,
) -> tokio::sync::oneshot::Receiver<Option<String>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    std::thread::spawn(move || {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread().enable_all().build()
        else {
            let _ = tx.send(None);
            return;
        };
        let result = runtime.block_on(async move {
            let registry = flairy_ai::ApiRegistry::with_builtins();
            let mut model = model;
            model.max_tokens = 64;
            let messages = vec![flairy_ai::Message {
                role: flairy_ai::Role::User,
                content: vec![flairy_ai::ContentBlock::Text {
                    text: format!("<userMessage>{first_message}</userMessage>"),
                }],
                timestamp: flairy_ai::types::now_ms(),
            }];
            let opts = flairy_ai::StreamOptions {
                get_api_key: Arc::new(move |_| Some(api_key.clone())),
                cancel: Arc::new(AtomicBool::new(false)),
            };
            flairy_ai::stream_simple(
                &registry,
                &model,
                &system_prompt,
                &messages,
                &[],
                &opts,
                &mut |_| {},
            )
            .await
        });
        let title = result.ok().and_then(|turn| {
            let raw: String = turn
                .blocks
                .iter()
                .filter_map(|b| match b {
                    flairy_ai::ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect();
            let title = sanitize_title(&raw);
            (!title.is_empty()).then_some(title)
        });
        let _ = tx.send(title);
    });
    rx
}

/// Collapse whitespace, strip wrapping quotes, cap at 60 chars.
fn sanitize_title(raw: &str) -> String {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed
        .trim_matches(|c| matches!(c, '"' | '\'' | '“' | '”' | '‘' | '’'))
        .trim();
    trimmed.chars().take(60).collect::<String>().trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::parse_tool_selection;

    #[test]
    fn parses_selection_replies() {
        assert_eq!(
            parse_tool_selection(r#"{"tools": ["bash", "grep"]}"#),
            Some(vec!["bash".to_string(), "grep".to_string()])
        );
        // Tolerates fences and prose around the JSON.
        assert_eq!(
            parse_tool_selection("```json\n{\"tools\": [\"web_search\"]}\n```"),
            Some(vec!["web_search".to_string()])
        );
        assert_eq!(parse_tool_selection(r#"{"tools": []}"#), Some(vec![]));
        assert_eq!(parse_tool_selection("no json here"), None);
    }
}

pub fn tool_label(name: &str) -> String {
    match name {
        "read_file" => "读取文件".into(),
        "list_dir" => "列出目录".into(),
        "bash" => "运行命令".into(),
        "web_search" => "搜索网页".into(),
        "web_fetch" => "读取网页".into(),
        "ask" => "询问".into(),
        "todo_write" => "计划".into(),
        "remember" => "记住".into(),
        "write_file" => "写入文件".into(),
        "edit_file" => "编辑文件".into(),
        "grep" => "搜索内容".into(),
        "find" => "查找文件".into(),
        "schedule" => "计划任务".into(),
        other => other.replace("__", " · "),
    }
}

pub fn tool_preview(input: &serde_json::Value) -> String {
    if let Some(todos) = input["todos"].as_array() {
        let done = todos
            .iter()
            .filter(|t| t["status"].as_str() == Some("completed"))
            .count();
        return format!("{done}/{} 项完成", todos.len());
    }
    input["path"]
        .as_str()
        .or_else(|| input["command"].as_str())
        .or_else(|| input["query"].as_str())
        .or_else(|| input["url"].as_str())
        .or_else(|| input["pattern"].as_str())
        .or_else(|| input["glob"].as_str())
        .or_else(|| input["questions"][0]["question"].as_str())
        .unwrap_or_default()
        .to_string()
}
