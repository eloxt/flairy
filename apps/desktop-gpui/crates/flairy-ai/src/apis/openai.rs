//! OpenAI-compatible chat completions, backed by the async-openai SDK
//! (supports custom base_url, so server-configured compatible endpoints
//! dispatch through the same implementation).

use crate::model::API_OPENAI;
use crate::registry::{Api, StreamRequest};
use crate::types::{
    AssistantTurn, ContentBlock, LlmDelta, Message, Role, StopReason, StopReason as SR, Usage,
};
use anyhow::{Context as _, Result};
use async_openai::Client;
use async_openai::config::OpenAIConfig;
use async_openai::types::{
    ChatCompletionMessageToolCall, ChatCompletionRequestAssistantMessageArgs,
    ChatCompletionRequestMessage, ChatCompletionRequestSystemMessageArgs,
    ChatCompletionRequestToolMessageArgs, ChatCompletionRequestUserMessageArgs,
    ChatCompletionStreamOptions, ChatCompletionToolArgs, ChatCompletionToolType,
    CreateChatCompletionRequestArgs, FinishReason, FunctionCall, FunctionObjectArgs,
};
use futures_util::StreamExt;
use std::collections::BTreeMap;
use std::sync::atomic::Ordering;

fn convert_messages(
    system: &str,
    messages: &[Message],
) -> Result<Vec<ChatCompletionRequestMessage>> {
    let mut out: Vec<ChatCompletionRequestMessage> = vec![
        ChatCompletionRequestSystemMessageArgs::default()
            .content(system)
            .build()?
            .into(),
    ];
    for m in messages {
        match m.role {
            Role::User => {
                let mut texts = Vec::new();
                for b in &m.content {
                    match b {
                        ContentBlock::Text { text } => texts.push(text.clone()),
                        ContentBlock::ToolResult { tool_use_id, content, is_error } => {
                            let content = if *is_error {
                                format!("Error: {content}")
                            } else {
                                content.clone()
                            };
                            out.push(
                                ChatCompletionRequestToolMessageArgs::default()
                                    .tool_call_id(tool_use_id.clone())
                                    .content(content)
                                    .build()?
                                    .into(),
                            );
                        }
                        ContentBlock::ToolUse { .. } => {}
                    }
                }
                if !texts.is_empty() {
                    out.push(
                        ChatCompletionRequestUserMessageArgs::default()
                            .content(texts.join("\n"))
                            .build()?
                            .into(),
                    );
                }
            }
            Role::Assistant => {
                let mut text = String::new();
                let mut tool_calls = Vec::new();
                for b in &m.content {
                    match b {
                        ContentBlock::Text { text: t } => text.push_str(t),
                        ContentBlock::ToolUse { id, name, input } => {
                            tool_calls.push(ChatCompletionMessageToolCall {
                                id: id.clone(),
                                r#type: ChatCompletionToolType::Function,
                                function: FunctionCall {
                                    name: name.clone(),
                                    arguments: input.to_string(),
                                },
                            });
                        }
                        ContentBlock::ToolResult { .. } => {}
                    }
                }
                let mut builder = ChatCompletionRequestAssistantMessageArgs::default();
                if !text.is_empty() {
                    builder.content(text);
                }
                if !tool_calls.is_empty() {
                    builder.tool_calls(tool_calls);
                }
                out.push(builder.build()?.into());
            }
        }
    }
    Ok(out)
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
        let config = OpenAIConfig::new()
            .with_api_key(req.api_key.clone())
            .with_api_base(req.model.base_url.trim_end_matches('/'));
        let client = Client::with_config(config);

        let tools = req
            .tools
            .iter()
            .map(|t| {
                Ok(ChatCompletionToolArgs::default()
                    .r#type(ChatCompletionToolType::Function)
                    .function(
                        FunctionObjectArgs::default()
                            .name(t.name.clone())
                            .description(t.description.clone())
                            .parameters(t.schema.clone())
                            .build()?,
                    )
                    .build()?)
            })
            .collect::<Result<Vec<_>>>()?;

        let mut builder = CreateChatCompletionRequestArgs::default();
        builder
            .model(req.model.id.clone())
            .max_tokens(req.model.max_tokens)
            .messages(convert_messages(req.system, req.messages)?)
            .stream(true)
            .stream_options(ChatCompletionStreamOptions { include_usage: true });
        if !tools.is_empty() {
            builder.tools(tools);
        }
        let request = builder.build()?;

        let mut stream = client
            .chat()
            .create_stream(request)
            .await
            .context("request failed")?;

        let mut text_acc = String::new();
        let mut tool_acc: BTreeMap<u32, (String, String, String)> = BTreeMap::new();
        let mut stop_reason = SR::EndTurn;
        let mut usage = Usage::default();
        let mut cancelled = false;

        while let Some(chunk) = stream.next().await {
            if req.cancel.load(Ordering::Relaxed) {
                cancelled = true;
                break;
            }
            let chunk = chunk.context("stream error")?;
            if let Some(u) = &chunk.usage {
                usage.input_tokens = u.prompt_tokens;
                usage.output_tokens = u.completion_tokens;
            }
            let Some(choice) = chunk.choices.first() else { continue };
            if let Some(text) = &choice.delta.content {
                if !text.is_empty() {
                    text_acc.push_str(text);
                    on_delta(LlmDelta::Text(text.clone()));
                }
            }
            if let Some(calls) = &choice.delta.tool_calls {
                for c in calls {
                    let entry = tool_acc.entry(c.index).or_default();
                    if let Some(id) = &c.id {
                        entry.0 = id.clone();
                    }
                    if let Some(f) = &c.function {
                        if let Some(name) = &f.name {
                            entry.1.push_str(name);
                        }
                        if let Some(args) = &f.arguments {
                            entry.2.push_str(args);
                        }
                    }
                }
            }
            if let Some(reason) = &choice.finish_reason {
                stop_reason = match reason {
                    FinishReason::ToolCalls => SR::ToolUse,
                    FinishReason::Length => SR::MaxTokens,
                    _ => SR::EndTurn,
                };
            }
        }

        let mut blocks = Vec::new();
        if !text_acc.is_empty() {
            blocks.push(ContentBlock::Text { text: text_acc });
        }
        for (_, (id, name, args)) in tool_acc {
            let input = if args.trim().is_empty() {
                serde_json::json!({})
            } else {
                serde_json::from_str(&args).unwrap_or(serde_json::json!({}))
            };
            blocks.push(ContentBlock::ToolUse { id, name, input });
        }
        if cancelled {
            stop_reason = StopReason::Cancelled;
        }

        Ok(AssistantTurn { blocks, stop_reason, usage })
    }
}
