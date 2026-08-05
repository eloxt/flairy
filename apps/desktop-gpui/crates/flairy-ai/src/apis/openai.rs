//! OpenAI-compatible chat completions over raw HTTP + SSE.
//!
//! Raw (not the async-openai SDK) so non-standard fields that compatible
//! providers emit survive parsing — notably `reasoning_content` /
//! `reasoning` (DeepSeek/GLM-style thinking), which typed SDK structs drop
//! at deserialization. Chunk handling is a pure function (`apply_chunk`)
//! so the accumulation logic is unit-testable without a server.

use super::sse::read_sse;
use crate::model::API_OPENAI;
use crate::registry::{Api, StreamRequest};
use crate::types::{
    AssistantTurn, ContentBlock, LlmDelta, Message, Role, StopReason, Usage,
};
use anyhow::{Context as _, Result};
use serde_json::{Value, json};
use std::collections::BTreeMap;

fn convert_messages(system: &str, messages: &[Message]) -> Vec<Value> {
    let mut out: Vec<Value> = vec![json!({"role": "system", "content": system})];
    for m in messages {
        match m.role {
            Role::User => {
                let mut texts = Vec::new();
                let mut images: Vec<Value> = Vec::new();
                for b in &m.content {
                    match b {
                        ContentBlock::Text { text } => texts.push(text.as_str()),
                        ContentBlock::Image { media_type, data } => {
                            images.push(json!({
                                "type": "image_url",
                                "image_url": {"url": format!("data:{media_type};base64,{data}")},
                            }));
                        }
                        ContentBlock::ToolResult { tool_use_id, content, is_error } => {
                            let content = if *is_error {
                                format!("Error: {content}")
                            } else {
                                content.clone()
                            };
                            out.push(json!({
                                "role": "tool",
                                "tool_call_id": tool_use_id,
                                "content": content,
                            }));
                        }
                        ContentBlock::ToolUse { .. } => {}
                    }
                }
                if !images.is_empty() {
                    // Vision requests need the content-parts array form.
                    let mut parts: Vec<Value> = Vec::new();
                    if !texts.is_empty() {
                        parts.push(json!({"type": "text", "text": texts.join("\n")}));
                    }
                    parts.extend(images);
                    out.push(json!({"role": "user", "content": parts}));
                } else if !texts.is_empty() {
                    out.push(json!({"role": "user", "content": texts.join("\n")}));
                }
            }
            Role::Assistant => {
                let mut text = String::new();
                let mut tool_calls: Vec<Value> = Vec::new();
                for b in &m.content {
                    match b {
                        ContentBlock::Text { text: t } => text.push_str(t),
                        ContentBlock::ToolUse { id, name, input } => {
                            tool_calls.push(json!({
                                "id": id,
                                "type": "function",
                                "function": {"name": name, "arguments": input.to_string()},
                            }));
                        }
                        ContentBlock::ToolResult { .. } | ContentBlock::Image { .. } => {}
                    }
                }
                let mut msg = json!({"role": "assistant"});
                if !text.is_empty() {
                    msg["content"] = json!(text);
                }
                if !tool_calls.is_empty() {
                    msg["tool_calls"] = json!(tool_calls);
                }
                out.push(msg);
            }
        }
    }
    out
}

/// Streaming accumulation state for one turn.
#[derive(Default)]
struct StreamState {
    text: String,
    /// index → (id, name, partial argument json)
    tools: BTreeMap<u64, (String, String, String)>,
    stop_reason: Option<StopReason>,
    usage: Usage,
}

impl StreamState {
    fn into_turn(self, cancelled: bool) -> AssistantTurn {
        let mut blocks = Vec::new();
        if !self.text.is_empty() {
            blocks.push(ContentBlock::Text { text: self.text });
        }
        for (_, (id, name, args)) in self.tools {
            let input = if args.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&args).unwrap_or(json!({}))
            };
            blocks.push(ContentBlock::ToolUse { id, name, input });
        }
        let stop_reason = if cancelled {
            StopReason::Cancelled
        } else {
            self.stop_reason.unwrap_or(StopReason::EndTurn)
        };
        AssistantTurn { blocks, stop_reason, usage: self.usage }
    }
}

/// Fold one parsed SSE chunk into the state, emitting deltas. Pure — the
/// network loop stays thin and this stays testable.
fn apply_chunk(state: &mut StreamState, v: &Value, on_delta: &mut (dyn FnMut(LlmDelta) + Send)) {
    if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
        if let Some(input) = u.get("prompt_tokens").and_then(|t| t.as_u64()) {
            state.usage.input_tokens = input as u32;
        }
        if let Some(output) = u.get("completion_tokens").and_then(|t| t.as_u64()) {
            state.usage.output_tokens = output as u32;
        }
    }
    let Some(choice) = v.get("choices").and_then(|c| c.as_array()).and_then(|c| c.first())
    else {
        return;
    };
    if let Some(delta) = choice.get("delta") {
        // DeepSeek/GLM-style reasoning rides in `reasoning_content` (some
        // gateways use `reasoning`). Display-only — never accumulated into
        // the committed blocks.
        for key in ["reasoning_content", "reasoning"] {
            if let Some(text) = delta.get(key).and_then(|t| t.as_str()) {
                if !text.is_empty() {
                    on_delta(LlmDelta::Thinking(text.to_string()));
                }
            }
        }
        if let Some(text) = delta.get("content").and_then(|t| t.as_str()) {
            if !text.is_empty() {
                state.text.push_str(text);
                on_delta(LlmDelta::Text(text.to_string()));
            }
        }
        if let Some(calls) = delta.get("tool_calls").and_then(|c| c.as_array()) {
            for c in calls {
                let index = c.get("index").and_then(|i| i.as_u64()).unwrap_or(0);
                let entry = state.tools.entry(index).or_default();
                if let Some(id) = c.get("id").and_then(|i| i.as_str()) {
                    entry.0 = id.to_string();
                }
                if let Some(f) = c.get("function") {
                    if let Some(name) = f.get("name").and_then(|n| n.as_str()) {
                        entry.1.push_str(name);
                    }
                    if let Some(args) = f.get("arguments").and_then(|a| a.as_str()) {
                        entry.2.push_str(args);
                    }
                }
            }
        }
    }
    if let Some(reason) = choice.get("finish_reason").and_then(|r| r.as_str()) {
        state.stop_reason = Some(match reason {
            "tool_calls" | "function_call" => StopReason::ToolUse,
            "length" => StopReason::MaxTokens,
            _ => StopReason::EndTurn,
        });
    }
}

pub struct OpenAiApi;

#[async_trait::async_trait]
impl Api for OpenAiApi {
    fn id(&self) -> &str {
        API_OPENAI
    }

    async fn stream(
        &self,
        req: StreamRequest<'_>,
        on_delta: &mut (dyn FnMut(LlmDelta) + Send),
    ) -> Result<AssistantTurn> {
        let tools_json: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.schema,
                    },
                })
            })
            .collect();

        let mut body = json!({
            "model": req.model.id,
            "max_tokens": req.model.max_tokens,
            "messages": convert_messages(req.system, req.messages),
            "stream": true,
            "stream_options": {"include_usage": true},
        });
        if !tools_json.is_empty() {
            body["tools"] = json!(tools_json);
        }

        let url = format!(
            "{}/chat/completions",
            req.model.base_url.trim_end_matches('/')
        );
        let client = reqwest::Client::new();
        let response = client
            .post(&url)
            .bearer_auth(&req.api_key)
            .json(&body)
            .send()
            .await
            .context("request failed")?;

        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            anyhow::bail!("provider error {status}: {text}");
        }

        let mut state = StreamState::default();
        let cancelled = read_sse(response, &req.cancel, |data| {
            if data.trim() == "[DONE]" {
                return Ok(());
            }
            let v: Value = serde_json::from_str(data)?;
            apply_chunk(&mut state, &v, on_delta);
            Ok(())
        })
        .await?;

        Ok(state.into_turn(cancelled))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(chunks: &[&str]) -> (AssistantTurn, Vec<String>, Vec<String>) {
        let mut state = StreamState::default();
        let mut texts = Vec::new();
        let mut thinking = Vec::new();
        let mut on_delta = |d: LlmDelta| match d {
            LlmDelta::Text(t) => texts.push(t),
            LlmDelta::Thinking(t) => thinking.push(t),
        };
        for chunk in chunks {
            let v: Value = serde_json::from_str(chunk).unwrap();
            apply_chunk(&mut state, &v, &mut on_delta);
        }
        (state.into_turn(false), texts, thinking)
    }

    #[test]
    fn accumulates_text_and_reasoning() {
        let (turn, texts, thinking) = run(&[
            r#"{"choices":[{"index":0,"delta":{"role":"assistant","reasoning_content":"让我想"}}]}"#,
            r#"{"choices":[{"index":0,"delta":{"reasoning_content":"想…"}}]}"#,
            r#"{"choices":[{"index":0,"delta":{"content":"你好"}}]}"#,
            r#"{"choices":[{"index":0,"delta":{"content":"！"},"finish_reason":"stop"}]}"#,
            r#"{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}"#,
        ]);
        assert_eq!(thinking, vec!["让我想", "想…"]);
        assert_eq!(texts, vec!["你好", "！"]);
        assert_eq!(turn.blocks.len(), 1);
        assert!(matches!(&turn.blocks[0], ContentBlock::Text { text } if text == "你好！"));
        assert!(matches!(turn.stop_reason, StopReason::EndTurn));
        assert_eq!(turn.usage.input_tokens, 12);
        assert_eq!(turn.usage.output_tokens, 34);
    }

    #[test]
    fn accumulates_tool_calls_by_index() {
        let (turn, _, _) = run(&[
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"bash","arguments":""}}]}}]}"#,
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"command\":"}}]}}]}"#,
            r#"{"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ls\"}"}}]}}]}"#,
            r#"{"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}"#,
        ]);
        assert!(matches!(turn.stop_reason, StopReason::ToolUse));
        assert_eq!(turn.blocks.len(), 1);
        match &turn.blocks[0] {
            ContentBlock::ToolUse { id, name, input } => {
                assert_eq!(id, "c1");
                assert_eq!(name, "bash");
                assert_eq!(input["command"], "ls");
            }
            other => panic!("expected tool use, got {other:?}"),
        }
    }

    #[test]
    fn converts_history_round_trip() {
        let messages = vec![
            Message::user_text("hi"),
            Message {
                role: Role::Assistant,
                content: vec![
                    ContentBlock::Text { text: "look".into() },
                    ContentBlock::ToolUse {
                        id: "t1".into(),
                        name: "bash".into(),
                        input: json!({"command": "ls"}),
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
        ];
        let out = convert_messages("sys", &messages);
        assert_eq!(out[0]["role"], "system");
        assert_eq!(out[1]["role"], "user");
        assert_eq!(out[2]["role"], "assistant");
        assert_eq!(out[2]["tool_calls"][0]["id"], "t1");
        assert_eq!(out[3]["role"], "tool");
        assert_eq!(out[3]["tool_call_id"], "t1");
    }
}
