//! MCP integration (rmcp): connects to server-pushed MCP servers, adapts
//! remote tools into flairy-agent `Tool`s. Process-level singleton — servers
//! reconnect on config change, not per session.

use flairy_agent::{Tool, ToolOutput};
use rmcp::ServiceExt;
use rmcp::model::CallToolRequestParams;
use rmcp::service::{RoleClient, RunningService};
use serde_json::Value;
use std::sync::{Arc, Mutex};

type Client = Arc<RunningService<RoleClient, ()>>;

pub struct McpManager {
    runtime: tokio::runtime::Runtime,
    tools: Arc<Mutex<Vec<Arc<dyn Tool>>>>,
    /// Bumped on apply() so stale connect tasks drop their results.
    generation: Arc<Mutex<u64>>,
}

struct McpTool {
    /// Namespaced "{server}__{tool}" to avoid collisions with builtins.
    name: String,
    label: String,
    description: String,
    schema: Value,
    remote_name: String,
    client: Client,
    handle: tokio::runtime::Handle,
}

impl Tool for McpTool {
    fn name(&self) -> &str {
        &self.name
    }
    fn label(&self) -> &str {
        &self.label
    }
    fn description(&self) -> &str {
        &self.description
    }
    fn schema(&self) -> Value {
        self.schema.clone()
    }
    fn execute(&self, input: Value) -> anyhow::Result<ToolOutput> {
        let mut params = CallToolRequestParams::new(self.remote_name.clone());
        if let Some(arguments) = input.as_object().cloned() {
            params = params.with_arguments(arguments);
        }
        let response = self
            .handle
            .block_on(async { self.client.call_tool_once(params).await })
            .map_err(|e| anyhow::anyhow!("mcp call failed: {e}"))?;
        let rmcp::model::CallToolResponse::Complete(result) = response else {
            anyhow::bail!("mcp tool requires client-side input (unsupported)");
        };
        let value = serde_json::to_value(&result)?;
        // Prefer plain text parts; fall back to the raw JSON.
        let text: String = value["content"]
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        let content = if text.is_empty() { value.to_string() } else { text };
        if value["isError"].as_bool() == Some(true) {
            anyhow::bail!("{content}");
        }
        Ok(ToolOutput { content, details: value })
    }
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("mcp runtime"),
            tools: Arc::new(Mutex::new(Vec::new())),
            generation: Arc::new(Mutex::new(0)),
        }
    }

    pub fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.tools.lock().unwrap().clone()
    }

    /// (Re)connect to the pushed server list; replaces the tool set when done.
    pub fn apply(&self, servers: Vec<Value>) {
        let generation = {
            let mut g = self.generation.lock().unwrap();
            *g += 1;
            *g
        };
        let tools_slot = self.tools.clone();
        let gen_slot = self.generation.clone();
        let handle = self.runtime.handle().clone();
        self.runtime.spawn(async move {
            let mut collected: Vec<Arc<dyn Tool>> = Vec::new();
            for server in &servers {
                if server.get("enabled").and_then(|e| e.as_bool()) == Some(false) {
                    continue;
                }
                let name = server["name"].as_str().unwrap_or("mcp").to_string();
                match connect_and_list(server, &name, handle.clone()).await {
                    Ok(mut tools) => collected.append(&mut tools),
                    Err(err) => eprintln!("mcp [{name}] connect failed: {err:#}"),
                }
            }
            if *gen_slot.lock().unwrap() == generation {
                eprintln!("mcp: {} tools ready", collected.len());
                *tools_slot.lock().unwrap() = collected;
            }
        });
    }
}

async fn connect_and_list(
    server: &Value,
    server_name: &str,
    handle: tokio::runtime::Handle,
) -> anyhow::Result<Vec<Arc<dyn Tool>>> {
    let transport = &server["transport"];
    let client: Client = match transport["kind"].as_str().unwrap_or_default() {
        "stdio" => {
            let command = transport["command"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("stdio transport missing command"))?;
            let mut cmd = tokio::process::Command::new(command);
            if let Some(args) = transport["args"].as_array() {
                cmd.args(args.iter().filter_map(|a| a.as_str()));
            }
            if let Some(env) = transport["env"].as_object() {
                for (k, v) in env {
                    if let Some(v) = v.as_str() {
                        cmd.env(k, v);
                    }
                }
            }
            let process = rmcp::transport::TokioChildProcess::new(cmd)?;
            Arc::new(().serve(process).await?)
        }
        "http" => {
            let url = transport["url"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("http transport missing url"))?;
            let t = rmcp::transport::StreamableHttpClientTransport::from_uri(url.to_string());
            Arc::new(().serve(t).await?)
        }
        other => anyhow::bail!("unsupported transport kind: {other}"),
    };

    let allowed: Vec<String> = server["allowedTools"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();

    let remote_tools = client.list_all_tools().await?;
    let mut tools: Vec<Arc<dyn Tool>> = Vec::new();
    for tool in remote_tools {
        if !allowed.is_empty() && !allowed.iter().any(|a| a == tool.name.as_ref()) {
            continue;
        }
        tools.push(Arc::new(McpTool {
            name: format!("{server_name}__{}", tool.name),
            label: format!("{server_name} · {}", tool.name),
            description: tool.description.clone().unwrap_or_default().into_owned(),
            schema: serde_json::to_value(tool.input_schema.as_ref())
                .unwrap_or_else(|_| serde_json::json!({"type": "object"})),
            remote_name: tool.name.to_string(),
            client: client.clone(),
            handle: handle.clone(),
        }));
    }
    Ok(tools)
}
