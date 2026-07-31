use crate::model::Model;
use crate::types::{AssistantTurn, LlmDelta, Message, ToolSpec};
use anyhow::Result;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

pub struct StreamRequest<'a> {
    pub model: &'a Model,
    pub api_key: String,
    pub system: &'a str,
    pub messages: &'a [Message],
    pub tools: &'a [ToolSpec],
    pub cancel: Arc<AtomicBool>,
}

/// A protocol implementation. Backed by raw HTTP (Anthropic has no official
/// Rust SDK; raw Messages API is the sanctioned path) or a vendor SDK
/// (openai-completions uses async-openai underneath).
#[async_trait::async_trait]
pub trait Api: Send + Sync {
    fn id(&self) -> &str;
    async fn stream(
        &self,
        req: StreamRequest<'_>,
        on_delta: &mut (dyn FnMut(LlmDelta) + Send),
    ) -> Result<AssistantTurn>;
}

/// pi-ai's api registry: custom (e.g. OpenAI-compatible) endpoints resolve
/// here by `model.api`.
pub struct ApiRegistry {
    apis: HashMap<String, Arc<dyn Api>>,
}

impl ApiRegistry {
    pub fn with_builtins() -> Self {
        let mut registry = Self { apis: HashMap::new() };
        registry.register(Arc::new(crate::apis::anthropic::AnthropicApi::new()));
        registry.register(Arc::new(crate::apis::openai::OpenAiApi));
        registry
    }

    pub fn register(&mut self, api: Arc<dyn Api>) {
        self.apis.insert(api.id().to_string(), api);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn Api>> {
        self.apis.get(id).cloned()
    }
}

impl Default for ApiRegistry {
    fn default() -> Self {
        Self::with_builtins()
    }
}

/// Credentials + cancellation, mirroring pi's `streamSimple(model, ctx, opts)`
/// with `getApiKey` injection.
pub struct StreamOptions {
    pub get_api_key: Arc<dyn Fn(&str) -> Option<String> + Send + Sync>,
    pub cancel: Arc<AtomicBool>,
}

pub async fn stream_simple(
    registry: &ApiRegistry,
    model: &Model,
    system: &str,
    messages: &[Message],
    tools: &[ToolSpec],
    opts: &StreamOptions,
    on_delta: &mut (dyn FnMut(LlmDelta) + Send),
) -> Result<AssistantTurn> {
    let api = registry
        .get(&model.api)
        .ok_or_else(|| anyhow::anyhow!("unknown api: {}", model.api))?;
    let api_key = (opts.get_api_key)(&model.provider)
        .ok_or_else(|| anyhow::anyhow!("no api key for provider: {}", model.provider))?;
    api.stream(
        StreamRequest {
            model,
            api_key,
            system,
            messages,
            tools,
            cancel: opts.cancel.clone(),
        },
        on_delta,
    )
    .await
}

