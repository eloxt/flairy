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
}

impl ApprovalGate for UiGate {
    fn check(&self, tool_name: &str, input: &serde_json::Value) -> ApprovalDecision {
        // Read-only builtins pass; bash and all MCP tools ask.
        if matches!(tool_name, "read_file" | "list_dir") {
            return ApprovalDecision::Allow;
        }
        if std::env::var("FLAIRY_YOLO").is_ok() {
            return ApprovalDecision::Allow;
        }
        if self.allowed.lock().unwrap().contains(tool_name) {
            return ApprovalDecision::Allow;
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

struct BashTool;
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
        let out = std::process::Command::new("sh").arg("-c").arg(command).output()?;
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
    user_text: String,
    cancel: Arc<AtomicBool>,
    system_prompt: Option<String>,
    extra_tools: Vec<Arc<dyn Tool>>,
    allowed: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
) -> (UnboundedReceiver<AgentEvent>, UnboundedReceiver<ApprovalRequest>) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let (approval_tx, approval_rx) = tokio::sync::mpsc::unbounded_channel();
    std::thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("tokio runtime");
        runtime.block_on(async move {
            let mut agent = Agent::new(
                model,
                system_prompt.unwrap_or_else(|| SYSTEM_PROMPT.to_string()),
                Arc::new(move |_provider: &str| Some(api_key.clone())),
            )
            .with_tools({
                let mut tools: Vec<Arc<dyn Tool>> =
                    vec![Arc::new(ReadFileTool), Arc::new(ListDirTool), Arc::new(BashTool)];
                tools.extend(extra_tools);
                tools
            })
            .with_approval(Arc::new(UiGate { tx: approval_tx, allowed }))
            .with_messages(history);
            agent.run(user_text, tx, cancel).await;
        });
    });
    (rx, approval_rx)
}

pub fn tool_label(name: &str) -> String {
    match name {
        "read_file" => "读取文件".into(),
        "list_dir" => "列出目录".into(),
        "bash" => "运行命令".into(),
        other => other.replace("__", " · "),
    }
}

pub fn tool_preview(input: &serde_json::Value) -> String {
    input["path"]
        .as_str()
        .or_else(|| input["command"].as_str())
        .or_else(|| input["query"].as_str())
        .unwrap_or_default()
        .to_string()
}
