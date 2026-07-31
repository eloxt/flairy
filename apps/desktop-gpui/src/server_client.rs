//! Minimal control-plane client: REST login → socket.io (socketioxide) with
//! JWT in the handshake auth → consume config:snapshot / config:updated and
//! map the pushed llm.main into a flairy-ai Model + credential.

use crate::contract::{SessionUpsertPayload, SessionWithMessages};
use flairy_ai::Model;
use serde_json::Value;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct Credentials {
    pub email: String,
    pub password: String,
    #[serde(default = "default_server")]
    pub server: String,
}

fn default_server() -> String {
    "http://127.0.0.1:8787".into()
}

fn credentials_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    let dir = std::path::PathBuf::from(home).join("Library/Application Support/Flairy");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("credentials.json")
}

fn keyring_entry() -> Option<keyring::Entry> {
    keyring::Entry::new("Flairy", "credentials").ok()
}

/// Credentials live in the macOS Keychain (safeStorage equivalent).
pub fn save_credentials(creds: &Credentials) {
    let Ok(json) = serde_json::to_string(creds) else { return };
    if let Some(entry) = keyring_entry() {
        if entry.set_password(&json).is_ok() {
            let _ = std::fs::remove_file(credentials_path()); // clean up legacy plaintext
            return;
        }
    }
    let _ = std::fs::write(credentials_path(), json); // fallback
}

pub fn clear_credentials() {
    if let Some(entry) = keyring_entry() {
        let _ = entry.delete_credential();
    }
    let _ = std::fs::remove_file(credentials_path());
}

pub fn stored_or_env_credentials() -> Option<Credentials> {
    if let (Ok(email), Ok(password)) = (std::env::var("FLAIRY_EMAIL"), std::env::var("FLAIRY_PASSWORD")) {
        let server = std::env::var("FLAIRY_SERVER_URL").unwrap_or_else(|_| default_server());
        return Some(Credentials { email, password, server });
    }
    if let Some(json) = keyring_entry().and_then(|e| e.get_password().ok()) {
        if let Ok(creds) = serde_json::from_str::<Credentials>(&json) {
            return Some(creds);
        }
    }
    // Legacy plaintext file: read once and migrate into the keychain.
    let json = std::fs::read_to_string(credentials_path()).ok()?;
    let creds: Credentials = serde_json::from_str(&json).ok()?;
    save_credentials(&creds);
    Some(creds)
}

/// Everything the server pushes down to the app.
pub enum ServerEvent {
    /// Login rejected — back to the auth screen.
    AuthFailed(String),
    Config(ServerConfig),
    /// Another device updated a session (also used for pull results).
    Remote(SessionWithMessages),
    RemoteDelete(String),
}

/// Client → server sync commands, emitted from the socket thread.
pub enum Outgoing {
    Upsert(SessionUpsertPayload),
    PatchTitle { session_id: String, title: String, updated_at: i64 },
    Delete { session_id: String },
}

/// One usable model (main or a user-selectable option) with its credential.
#[derive(Clone, Debug)]
pub struct ModelOption {
    pub model: Model,
    pub api_key: String,
    pub name: String,
    pub context_window: Option<u32>,
    /// USD per million tokens.
    pub cost_input: Option<f64>,
    pub cost_output: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub main: Option<ModelOption>,
    /// Admin-marked selectable candidates (modelOptions).
    pub options: Vec<ModelOption>,
    /// Server-configured system prompt ("chat" falling back to "main"), placeholders stripped.
    pub system_prompt: Option<String>,
    /// Raw mcpServers array from the snapshot (parsed lazily by McpManager).
    pub mcp_servers: Vec<Value>,
}

/// Parse one ActiveLlm ({provider, model}) into a usable ModelOption.
fn parse_active_llm(v: &Value) -> Option<ModelOption> {
    let provider = v.get("provider")?;
    let model = v.get("model")?;
    let (api, default_base) = match provider.get("api")?.as_str()? {
        "anthropic-messages" => (flairy_ai::API_ANTHROPIC, "https://api.anthropic.com"),
        "openai-completions" => (flairy_ai::API_OPENAI, "https://api.openai.com/v1"),
        other => {
            eprintln!("server pushed unsupported api: {other}");
            return None;
        }
    };
    Some(ModelOption {
        model: Model {
            api: api.to_string(),
            provider: provider.get("id")?.as_str()?.to_string(),
            id: model.get("model")?.as_str()?.to_string(),
            base_url: provider
                .get("baseUrl")
                .and_then(|b| b.as_str())
                .unwrap_or(default_base)
                .to_string(),
            max_tokens: model.get("maxTokens").and_then(|m| m.as_u64()).unwrap_or(8192) as u32,
        },
        api_key: provider.get("credential")?.as_str()?.to_string(),
        name: model.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_string(),
        context_window: model.get("contextWindow").and_then(|c| c.as_u64()).map(|c| c as u32),
        cost_input: model.get("cost").and_then(|c| c.get("input")).and_then(|x| x.as_f64()),
        cost_output: model.get("cost").and_then(|c| c.get("output")).and_then(|x| x.as_f64()),
    })
}

fn strip_placeholders(body: &str) -> String {
    let mut out = String::with_capacity(body.len());
    let mut rest = body;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        match rest[start..].find("}}") {
            Some(end) => rest = &rest[start + end + 2..],
            None => {
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out.trim().to_string()
}

fn pick_system_prompt(v: &Value) -> Option<String> {
    let prompts = v.get("systemPrompts")?.as_array()?;
    let find = |wanted: &str| {
        prompts.iter().find(|p| {
            p.get("name").and_then(|n| n.as_str()) == Some(wanted)
                && p.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true)
        })
    };
    let prompt = find("chat").or_else(|| find("main"))?;
    let body = prompt.get("body")?.as_str()?;
    let stripped = strip_placeholders(body);
    (!stripped.is_empty()).then_some(stripped)
}

fn parse_snapshot(v: &Value) -> Option<ServerConfig> {
    let main = v.get("llm").and_then(|l| l.get("main")).and_then(parse_active_llm);
    let options = v
        .get("modelOptions")
        .and_then(|m| m.as_array())
        .map(|list| list.iter().filter_map(parse_active_llm).collect())
        .unwrap_or_default();
    Some(ServerConfig {
        main,
        options,
        system_prompt: pick_system_prompt(v),
        mcp_servers: v
            .get("mcpServers")
            .and_then(|m| m.as_array())
            .cloned()
            .unwrap_or_default(),
    })
}

/// Config snapshots (initial + live updates) arrive on the returned channel.
pub fn connect(creds: Credentials) -> (UnboundedReceiver<ServerEvent>, UnboundedSender<Outgoing>) {
    let Credentials { email, password, server } = creds;

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Outgoing>();
    std::thread::spawn(move || {
        let login = match reqwest::blocking::Client::new()
            .post(format!("{}/api/auth/login", server.trim_end_matches('/')))
            .json(&serde_json::json!({"email": email, "password": password}))
            .send()
            .and_then(|r| r.error_for_status())
            .and_then(|r| r.json::<Value>())
        {
            Ok(v) => v,
            Err(err) => {
                let _ = tx.send(ServerEvent::AuthFailed(format!("{err}")));
                return;
            }
        };
        let Some(token) = login.get("token").and_then(|t| t.as_str()) else {
            let _ = tx.send(ServerEvent::AuthFailed("登录响应缺少 token".into()));
            return;
        };

        let config_tx = tx.clone();
        let on_config = move |payload: rust_socketio::Payload, _| {
            if let rust_socketio::Payload::Text(values) = payload {
                if let Some(config) = values.first().and_then(parse_snapshot) {
                    let _ = config_tx.send(ServerEvent::Config(config));
                }
            }
        };
        let remote_tx = tx.clone();
        let on_remote = move |payload: rust_socketio::Payload, _| {
            if let rust_socketio::Payload::Text(values) = payload {
                if let Some(session) = values
                    .first()
                    .and_then(|v| serde_json::from_value::<SessionWithMessages>(v.clone()).ok())
                {
                    let _ = remote_tx.send(ServerEvent::Remote(session));
                }
            }
        };
        let delete_tx = tx.clone();
        let on_remote_delete = move |payload: rust_socketio::Payload, _| {
            if let rust_socketio::Payload::Text(values) = payload {
                if let Some(id) = values
                    .first()
                    .and_then(|v| v.get("sessionId"))
                    .and_then(|s| s.as_str())
                {
                    let _ = delete_tx.send(ServerEvent::RemoteDelete(id.to_string()));
                }
            }
        };

        // Pull on every (re)connect so gaps while offline are backfilled.
        let pull_tx = tx.clone();
        let on_connect = move |_: rust_socketio::Payload, client: rust_socketio::RawClient| {
            let pull_tx = pull_tx.clone();
            let _ = client.emit_with_ack(
                "session:pull",
                serde_json::json!({}),
                std::time::Duration::from_secs(10),
                move |payload: rust_socketio::Payload, _| {
                    if let rust_socketio::Payload::Text(values) = payload {
                        let list = values
                            .first()
                            .and_then(|v| v.as_array().cloned())
                            .unwrap_or_else(|| values.clone());
                        for entry in list {
                            if let Ok(session) =
                                serde_json::from_value::<SessionWithMessages>(entry)
                            {
                                let _ = pull_tx.send(ServerEvent::Remote(session));
                            }
                        }
                    }
                },
            );
        };

        let client = rust_socketio::ClientBuilder::new(&server)
            .auth(serde_json::json!({"token": token}))
            .reconnect(true)
            .reconnect_on_disconnect(true)
            .reconnect_delay(1_000, 30_000)
            .on(rust_socketio::Event::Connect, on_connect)
            .on("config:snapshot", {
                let on_config = on_config.clone();
                move |p, c| on_config(p, c)
            })
            .on("config:updated", move |p, c| on_config(p, c))
            .on("session:remote", move |p, c| on_remote(p, c))
            .on("session:remote-delete", move |p, c| on_remote_delete(p, c))
            .connect();

        let client = match client {
            Ok(client) => client,
            Err(err) => {
                eprintln!("socket connect failed: {err}");
                return;
            }
        };

        // Outgoing sync loop (blocking_recv is fine off-runtime).
        while let Some(command) = out_rx.blocking_recv() {
            match command {
                Outgoing::Upsert(payload) => {
                    if let Ok(value) = serde_json::to_value(&payload) {
                        let _ = client.emit("session:upsert", value);
                    }
                }
                Outgoing::PatchTitle { session_id, title, updated_at } => {
                    let payload = flairy_contract::SessionPatchPayload {
                        session_id,
                        append_messages: Vec::new(),
                        updated_at,
                        title: Some(title),
                    };
                    if let Ok(value) = serde_json::to_value(&payload) {
                        let _ = client.emit("session:patch", value);
                    }
                }
                Outgoing::Delete { session_id } => {
                    let payload = flairy_contract::SessionDeletePayload { session_id };
                    if let Ok(value) = serde_json::to_value(&payload) {
                        let _ = client.emit("session:delete", value);
                    }
                }
            }
        }
    });
    (rx, out_tx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_snapshot_llm_main() {
        let v: Value = serde_json::from_str(
            r#"{"llm":{"main":{"provider":{"id":"p1","name":"Anthropic","api":"anthropic-messages","credential":"sk-test"},"model":{"id":"m1","providerId":"p1","name":"Claude Sonnet 4.5","model":"claude-sonnet-4-5","maxTokens":16000,"selectable":true}},"tool":null,"visual":null},"modelOptions":[],"mcpServers":[],"skills":[],"systemPrompts":[],"announcements":[],"services":[],"version":3}"#,
        )
        .unwrap();
        let config = parse_snapshot(&v).unwrap();
        let main = config.main.unwrap();
        assert_eq!(main.model.api, flairy_ai::API_ANTHROPIC);
        assert_eq!(main.model.id, "claude-sonnet-4-5");
        assert_eq!(main.model.base_url, "https://api.anthropic.com");
        assert_eq!(main.model.max_tokens, 16000);
        assert_eq!(main.api_key, "sk-test");
        assert_eq!(main.name, "Claude Sonnet 4.5");

        // openai-compatible with explicit baseUrl
        let v2: Value = serde_json::from_str(
            r#"{"llm":{"main":{"provider":{"id":"p2","name":"X","api":"openai-completions","credential":"k","baseUrl":"https://llm.example.com/v1"},"model":{"id":"m2","providerId":"p2","name":"GLM","model":"glm-4"}}}}"#,
        )
        .unwrap();
        let m2 = parse_snapshot(&v2).unwrap().main.unwrap();
        assert_eq!(m2.model.api, flairy_ai::API_OPENAI);
        assert_eq!(m2.model.base_url, "https://llm.example.com/v1");
        assert_eq!(m2.model.max_tokens, 8192);
    }
}
