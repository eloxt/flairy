use crate::tool::{ApprovalDecision, ApprovalGate, AutoApprove, Tool};
use flairy_ai::types::now_ms;
use flairy_ai::{
    ApiRegistry, ContentBlock, Message, Model, Role, StopReason, ToolSpec, Usage,
    stream_simple, StreamOptions, LlmDelta,
};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::mpsc::UnboundedSender;

/// Events emitted by the agent loop toward the host UI.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    TurnStart,
    TextDelta { text: String },
    /// Model reasoning text (display-only; not part of the committed turn).
    ThinkingDelta { text: String },
    ToolCallStart { id: String, name: String, input: serde_json::Value },
    ToolResult { id: String, name: String, output: String, is_error: bool },
    TurnEnd { usage: Usage },
    Done { messages: Vec<Message> },
    Error { message: String },
}

pub struct Agent {
    pub model: Model,
    pub system_prompt: String,
    pub tools: Vec<Arc<dyn Tool>>,
    pub approval: Arc<dyn ApprovalGate>,
    pub messages: Vec<Message>,
    /// Credential injection, mirroring pi's `new Agent({ getApiKey })`.
    pub get_api_key: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    pub registry: Arc<ApiRegistry>,
    /// Safety valve against infinite tool loops.
    pub max_turns: usize,
}

impl Agent {
    pub fn new(
        model: Model,
        system_prompt: impl Into<String>,
        get_api_key: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    ) -> Self {
        Self {
            model,
            system_prompt: system_prompt.into(),
            tools: Vec::new(),
            approval: Arc::new(AutoApprove),
            messages: Vec::new(),
            get_api_key,
            registry: Arc::new(ApiRegistry::with_builtins()),
            max_turns: 24,
        }
    }

    pub fn with_tools(mut self, tools: Vec<Arc<dyn Tool>>) -> Self {
        self.tools = tools;
        self
    }

    pub fn with_messages(mut self, messages: Vec<Message>) -> Self {
        self.messages = messages;
        self
    }

    pub fn with_approval(mut self, gate: Arc<dyn ApprovalGate>) -> Self {
        self.approval = gate;
        self
    }

    pub fn with_registry(mut self, registry: Arc<ApiRegistry>) -> Self {
        self.registry = registry;
        self
    }

    fn tool_specs(&self) -> Vec<ToolSpec> {
        self.tools
            .iter()
            .map(|t| ToolSpec {
                name: t.name().to_string(),
                description: t.description().to_string(),
                schema: t.schema(),
            })
            .collect()
    }

    /// Run the loop until the model ends its turn (or cancel/max_turns).
    /// Emits AgentEvents on `tx`; the final message list arrives in Done.
    /// Run with a plain-text user message.
    pub async fn run(
        &mut self,
        user_text: String,
        tx: UnboundedSender<AgentEvent>,
        cancel: Arc<AtomicBool>,
    ) {
        self.run_message(Message::user_text(user_text), tx, cancel).await
    }

    /// Run with a full user message (text + image blocks).
    pub async fn run_message(
        &mut self,
        user: Message,
        tx: UnboundedSender<AgentEvent>,
        cancel: Arc<AtomicBool>,
    ) {
        self.messages.push(user);
        if let Err(err) = self.run_inner(&tx, &cancel).await {
            let _ = tx.send(AgentEvent::Error { message: format!("{err:#}") });
        }
        let _ = tx.send(AgentEvent::Done { messages: self.messages.clone() });
    }

    async fn run_inner(
        &mut self,
        tx: &UnboundedSender<AgentEvent>,
        cancel: &Arc<AtomicBool>,
    ) -> anyhow::Result<()> {
        let specs = self.tool_specs();
        let opts = StreamOptions {
            get_api_key: self.get_api_key.clone(),
            cancel: cancel.clone(),
        };

        for _ in 0..self.max_turns {
            let _ = tx.send(AgentEvent::TurnStart);
            let tx_delta = tx.clone();
            let mut on_delta = move |d: LlmDelta| {
                let _ = match d {
                    LlmDelta::Text(text) => tx_delta.send(AgentEvent::TextDelta { text }),
                    LlmDelta::Thinking(text) => {
                        tx_delta.send(AgentEvent::ThinkingDelta { text })
                    }
                };
            };

            // Transient provider/network failures retry with backoff (the
            // partial turn is never committed, so a retry re-streams cleanly).
            let mut attempt = 0u32;
            let turn = loop {
                match stream_simple(
                    &self.registry,
                    &self.model,
                    &self.system_prompt,
                    &self.messages,
                    &specs,
                    &opts,
                    &mut on_delta,
                )
                .await
                {
                    Ok(turn) => break turn,
                    Err(err) => {
                        attempt += 1;
                        if attempt > 2 || cancel.load(Ordering::Relaxed) {
                            return Err(err);
                        }
                        tokio::time::sleep(std::time::Duration::from_millis(
                            800 * u64::from(attempt),
                        ))
                        .await;
                    }
                }
            };

            if !turn.blocks.is_empty() {
                self.messages.push(Message {
                    role: Role::Assistant,
                    content: turn.blocks.clone(),
                    timestamp: now_ms(),
                });
            }
            let _ = tx.send(AgentEvent::TurnEnd { usage: turn.usage });

            if turn.stop_reason != StopReason::ToolUse {
                return Ok(());
            }

            // Execute the requested tools, then continue the loop.
            let mut results = Vec::new();
            for block in &turn.blocks {
                let ContentBlock::ToolUse { id, name, input } = block else { continue };
                let _ = tx.send(AgentEvent::ToolCallStart {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                });

                let (output, is_error) = if cancel.load(Ordering::Relaxed) {
                    ("cancelled by user".to_string(), true)
                } else if self.approval.check(name, input) == ApprovalDecision::Deny {
                    ("denied by user".to_string(), true)
                } else if let Some(tool) = self.tools.iter().find(|t| t.name() == name) {
                    let tool = tool.clone();
                    let input = input.clone();
                    match tokio::task::spawn_blocking(move || tool.execute(input)).await {
                        Ok(Ok(out)) => (out.content, false),
                        Ok(Err(err)) => (format!("{err:#}"), true),
                        Err(err) => (format!("tool panicked: {err}"), true),
                    }
                } else {
                    (format!("unknown tool: {name}"), true)
                };

                let _ = tx.send(AgentEvent::ToolResult {
                    id: id.clone(),
                    name: name.clone(),
                    output: output.clone(),
                    is_error,
                });
                results.push(ContentBlock::ToolResult {
                    tool_use_id: id.clone(),
                    content: output,
                    is_error,
                });
            }
            self.messages.push(Message { role: Role::User, content: results, timestamp: now_ms() });

            if cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
        }
        anyhow::bail!("max turns reached")
    }
}
