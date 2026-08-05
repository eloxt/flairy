//! Sync/format conversion helpers on top of the shared `flairy-contract`
//! types (single source of truth for server + clients).

use flairy_agent::{ContentBlock, Message, Role};

pub use flairy_contract::{
    MessageRole, Session, SessionUpsertPayload, SessionWithMessages, SyncMessage,
};

fn text_of(message: &Message) -> String {
    message
        .content
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Agent history → sync envelopes. Fresh UUIDs are fine: we always sync via
/// full upsert (server deletes + reinserts; pi-style messages have no stable id).
pub fn to_sync_messages(history: &[Message]) -> Vec<SyncMessage> {
    history
        .iter()
        .map(|message| {
            let is_tool_result = message
                .content
                .iter()
                .any(|b| matches!(b, ContentBlock::ToolResult { .. }));
            let role = match (message.role, is_tool_result) {
                (Role::User, true) => MessageRole::ToolResult,
                (Role::User, false) => MessageRole::User,
                (Role::Assistant, _) => MessageRole::Assistant,
            };
            SyncMessage {
                id: uuid::Uuid::new_v4().to_string(),
                role,
                text: text_of(message),
                timestamp: message.timestamp as i64,
                raw: serde_json::to_value(message).unwrap_or_default(),
            }
        })
        .collect()
}

/// Sync envelopes → (UI rows, agent history). `raw` is authoritative; the
/// text/role envelope is the fallback for messages another client wrote.
pub fn hydrate(messages: &[SyncMessage]) -> (Vec<crate::app::Msg>, Vec<Message>) {
    let mut history: Vec<Message> = Vec::new();
    for sync in messages {
        if let Ok(message) = serde_json::from_value::<Message>(sync.raw.clone()) {
            history.push(message);
        } else {
            let role = match sync.role {
                MessageRole::Assistant => Role::Assistant,
                _ => Role::User,
            };
            history.push(Message {
                role,
                content: vec![ContentBlock::Text { text: sync.text.clone() }],
                timestamp: sync.timestamp.max(0) as u64,
            });
        }
    }

    let msgs = msgs_from_history(&history);
    (msgs, history)
}

/// Rebuild UI rows from provider-format history (sync pull + local load).
pub fn msgs_from_history(history: &[Message]) -> Vec<crate::app::Msg> {
    use crate::app::Msg;
    let mut msgs: Vec<Msg> = Vec::new();
    for message in history {
        for block in &message.content {
            match (message.role, block) {
                (Role::User, ContentBlock::Text { text }) => {
                    msgs.push(Msg::User(text.clone()));
                }
                (Role::User, ContentBlock::Image { .. }) => {
                    msgs.push(Msg::User("🖼 [图片]".into()));
                }
                (Role::Assistant, ContentBlock::Text { text }) => {
                    msgs.push(Msg::Assistant {
                        md: text.clone(),
                        done: true,
                        view: None,
                        reasoning: String::new(),
                        reasoning_open: false,
                    });
                }
                (Role::Assistant, ContentBlock::ToolUse { id, name, input }) => {
                    msgs.push(Msg::Tool {
                        id: id.clone(),
                        label: crate::agent_runtime::tool_label(name),
                        preview: crate::agent_runtime::tool_preview(input),
                        output: Some(String::new()),
                        is_error: false,
                        expanded: false,
                    });
                }
                (Role::User, ContentBlock::ToolResult { tool_use_id, content, is_error }) => {
                    if let Some(Msg::Tool { output, is_error: err, .. }) = msgs
                        .iter_mut()
                        .rev()
                        .find(|m| matches!(m, Msg::Tool { id, .. } if id == tool_use_id))
                    {
                        *output = Some(content.clone());
                        *err = *is_error;
                    }
                }
                _ => {}
            }
        }
    }
    msgs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_roundtrip_hydrates() {
        let history = vec![
            Message::user_text("你好"),
            Message {
                role: Role::Assistant,
                content: vec![
                    ContentBlock::Text { text: "我看看".into() },
                    ContentBlock::ToolUse {
                        id: "t1".into(),
                        name: "bash".into(),
                        input: serde_json::json!({"command": "ls"}),
                    },
                ],
                timestamp: 1,
            },
            Message {
                role: Role::User,
                content: vec![ContentBlock::ToolResult {
                    tool_use_id: "t1".into(),
                    content: "a.txt".into(),
                    is_error: false,
                }],
                timestamp: 2,
            },
            Message {
                role: Role::Assistant,
                content: vec![ContentBlock::Text { text: "有 a.txt".into() }],
                timestamp: 3,
            },
        ];
        let sync = to_sync_messages(&history);
        assert!(matches!(sync[2].role, MessageRole::ToolResult));
        let (msgs, restored) = hydrate(&sync);
        assert_eq!(restored.len(), 4);
        // User, Assistant text, Tool (with output), Assistant text
        assert_eq!(msgs.len(), 4);
        assert!(matches!(&msgs[2], crate::app::Msg::Tool { output: Some(o), .. } if o == "a.txt"));
    }
}
