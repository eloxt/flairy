//! Anthropic Messages API (streaming).

use super::sse::read_sse;
use crate::model::Model;
use crate::types::{AssistantTurn, ContentBlock, LlmDelta, Message, Role, StopReason, ToolSpec, Usage};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

fn convert_messages(messages: &[Message]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| {
            let role = match m.role {
                Role::User => "user",
                Role::Assistant => "assistant",
            };
            let content: Vec<Value> = m
                .content
                .iter()
                .map(|b| match b {
                    ContentBlock::Text { text } => json!({"type": "text", "text": text}),
                    ContentBlock::ToolUse { id, name, input } => {
                        json!({"type": "tool_use", "id": id, "name": name, "input": input})
                    }
                    ContentBlock::ToolResult { tool_use_id, content, is_error } => json!({
                        "type": "tool_result",
                        "tool_use_id": tool_use_id,
                        "content": content,
                        "is_error": is_error,
                    }),
                })
                .collect();
            json!({"role": role, "content": content})
        })
        .collect()
}

pub async fn stream_turn(
    client: &reqwest::Client,
    api_key: &str,
    model: &Model,
    system: &str,
    messages: &[Message],
    tools: &[ToolSpec],
    cancel: &Arc<AtomicBool>,
    on_delta: &mut (dyn FnMut(LlmDelta) + Send),
) -> Result<AssistantTurn> {
    let tools_json: Vec<Value> = tools
        .iter()
        .map(|t| json!({"name": t.name, "description": t.description, "input_schema": t.schema}))
        .collect();

    let body = json!({
        "model": model.id,
        "max_tokens": model.max_tokens,
        "system": system,
        "messages": convert_messages(messages),
        "tools": tools_json,
        "stream": true,
    });

    let url = format!("{}/v1/messages", model.base_url.trim_end_matches('/'));
    let response = client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .context("request failed")?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        anyhow::bail!("provider error {status}: {text}");
    }

    let mut blocks: Vec<ContentBlock> = Vec::new();
    let mut current_text = String::new();
    let mut current_tool: Option<(String, String, String)> = None; // id, name, partial json
    let mut stop_reason = StopReason::EndTurn;
    let mut usage = Usage::default();

    let cancelled = read_sse(response, cancel, |data| {
        let ev: Value = serde_json::from_str(data)?;
        match ev["type"].as_str().unwrap_or("") {
            "message_start" => {
                usage.input_tokens =
                    ev["message"]["usage"]["input_tokens"].as_u64().unwrap_or(0) as u32;
            }
            "content_block_start" => {
                let block = &ev["content_block"];
                match block["type"].as_str().unwrap_or("") {
                    "tool_use" => {
                        current_tool = Some((
                            block["id"].as_str().unwrap_or_default().to_string(),
                            block["name"].as_str().unwrap_or_default().to_string(),
                            String::new(),
                        ));
                    }
                    _ => current_text.clear(),
                }
            }
            "content_block_delta" => {
                let delta = &ev["delta"];
                match delta["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        let text = delta["text"].as_str().unwrap_or_default();
                        current_text.push_str(text);
                        on_delta(LlmDelta::Text(text.to_string()));
                    }
                    "input_json_delta" => {
                        if let Some((_, _, partial)) = current_tool.as_mut() {
                            partial.push_str(delta["partial_json"].as_str().unwrap_or_default());
                        }
                    }
                    _ => {}
                }
            }
            "content_block_stop" => {
                if let Some((id, name, partial)) = current_tool.take() {
                    let input = if partial.trim().is_empty() {
                        json!({})
                    } else {
                        serde_json::from_str(&partial).unwrap_or(json!({}))
                    };
                    blocks.push(ContentBlock::ToolUse { id, name, input });
                } else if !current_text.is_empty() {
                    blocks.push(ContentBlock::Text { text: std::mem::take(&mut current_text) });
                }
            }
            "message_delta" => {
                if let Some(reason) = ev["delta"]["stop_reason"].as_str() {
                    stop_reason = match reason {
                        "tool_use" => StopReason::ToolUse,
                        "max_tokens" => StopReason::MaxTokens,
                        _ => StopReason::EndTurn,
                    };
                }
                if let Some(out) = ev["usage"]["output_tokens"].as_u64() {
                    usage.output_tokens = out as u32;
                }
            }
            _ => {}
        }
        Ok(())
    })
    .await?;

    if !current_text.is_empty() {
        blocks.push(ContentBlock::Text { text: current_text });
    }
    if cancelled {
        stop_reason = StopReason::Cancelled;
    }

    Ok(AssistantTurn { blocks, stop_reason, usage })
}

/// Anthropic Messages API. No official Rust SDK exists — raw HTTP against
/// `POST /v1/messages` is the sanctioned integration path for Rust.
pub struct AnthropicApi {
    client: reqwest::Client,
}

impl AnthropicApi {
    pub fn new() -> Self {
        Self { client: reqwest::Client::new() }
    }
}

impl Default for AnthropicApi {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl crate::registry::Api for AnthropicApi {
    fn id(&self) -> &str {
        crate::model::API_ANTHROPIC
    }

    async fn stream(
        &self,
        req: crate::registry::StreamRequest<'_>,
        on_delta: &mut (dyn FnMut(LlmDelta) + Send),
    ) -> Result<AssistantTurn> {
        stream_turn(
            &self.client,
            &req.api_key,
            req.model,
            req.system,
            req.messages,
            req.tools,
            &req.cancel,
            on_delta,
        )
        .await
    }
}
