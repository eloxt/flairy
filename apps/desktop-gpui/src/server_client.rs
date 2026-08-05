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
    /// Login succeeded; the app keeps the JWT for REST calls (skills).
    Authed { token: String, server: String },
    /// Parsed config plus the raw snapshot JSON (persisted encrypted for
    /// offline startup).
    Config(ServerConfig, String),
    /// Another device updated a session (also used for pull results).
    Remote(SessionWithMessages),
    RemoteDelete(String),
    /// Memories changed elsewhere (also used for pull results).
    MemoryRemote(Vec<flairy_contract::Memory>),
}

/// Client → server sync commands, emitted from the socket thread.
pub enum Outgoing {
    Upsert(SessionUpsertPayload),
    PatchTitle { session_id: String, title: String, updated_at: i64 },
    Delete { session_id: String },
    MemoryUpsert(Vec<flairy_contract::Memory>),
}

/// Event name + payload for one command, ready to emit.
fn serialize_command(command: &Outgoing) -> Option<(&'static str, Value)> {
    match command {
        Outgoing::Upsert(payload) => {
            Some(("session:upsert", serde_json::to_value(payload).ok()?))
        }
        Outgoing::PatchTitle { session_id, title, updated_at } => {
            let payload = flairy_contract::SessionPatchPayload {
                session_id: session_id.clone(),
                append_messages: Vec::new(),
                updated_at: *updated_at,
                title: Some(title.clone()),
            };
            Some(("session:patch", serde_json::to_value(&payload).ok()?))
        }
        Outgoing::Delete { session_id } => {
            let payload =
                flairy_contract::SessionDeletePayload { session_id: session_id.clone() };
            Some(("session:delete", serde_json::to_value(&payload).ok()?))
        }
        Outgoing::MemoryUpsert(memories) => {
            let payload =
                flairy_contract::MemoryUpsertPayload { memories: memories.clone() };
            Some(("memory:upsert", serde_json::to_value(&payload).ok()?))
        }
    }
}

/// Commands queued while offline, coalesced so a reconnect replays a compact
/// set (latest upsert per session, latest-wins title patches, newest-wins
/// memory rows). Flushed on connect BEFORE session:pull so the pull reflects
/// this device's state. Mirrors the Electron ServerClient outbox.
#[derive(Default)]
struct Outbox {
    upserts: std::collections::HashMap<String, SessionUpsertPayload>,
    titles: std::collections::HashMap<String, (String, i64)>,
    deletes: std::collections::HashSet<String>,
    memories: std::collections::HashMap<String, flairy_contract::Memory>,
}

impl Outbox {
    fn enqueue(&mut self, command: Outgoing) {
        match command {
            Outgoing::Upsert(payload) => {
                self.deletes.remove(&payload.session.id);
                self.upserts.insert(payload.session.id.clone(), payload);
            }
            Outgoing::PatchTitle { session_id, title, updated_at } => {
                let newer = self
                    .titles
                    .get(&session_id)
                    .map(|(_, prev)| updated_at >= *prev)
                    .unwrap_or(true);
                if newer {
                    self.titles.insert(session_id, (title, updated_at));
                }
            }
            Outgoing::Delete { session_id } => {
                self.upserts.remove(&session_id);
                self.titles.remove(&session_id);
                self.deletes.insert(session_id);
            }
            Outgoing::MemoryUpsert(memories) => {
                for m in memories {
                    let newer = self
                        .memories
                        .get(&m.id)
                        .map(|prev| m.updated_at >= prev.updated_at)
                        .unwrap_or(true);
                    if newer {
                        self.memories.insert(m.id.clone(), m);
                    }
                }
            }
        }
    }

    fn drain(&mut self) -> Vec<(&'static str, Value)> {
        let mut out = Vec::new();
        for (_, payload) in std::mem::take(&mut self.upserts) {
            out.extend(serialize_command(&Outgoing::Upsert(payload)));
        }
        for (session_id, (title, updated_at)) in std::mem::take(&mut self.titles) {
            out.extend(serialize_command(&Outgoing::PatchTitle {
                session_id,
                title,
                updated_at,
            }));
        }
        let memories: Vec<_> = std::mem::take(&mut self.memories).into_values().collect();
        if !memories.is_empty() {
            out.extend(serialize_command(&Outgoing::MemoryUpsert(memories)));
        }
        for session_id in std::mem::take(&mut self.deletes) {
            out.extend(serialize_command(&Outgoing::Delete { session_id }));
        }
        out
    }
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

/// Ready-to-use Exa web-search config resolved from the `services` catalog.
#[derive(Clone, Debug)]
pub struct ExaConfig {
    pub api_key: String,
    pub base_url: String,
    pub num_results: u32,
}

#[derive(Clone, Debug)]
pub struct ServerConfig {
    pub main: Option<ModelOption>,
    /// Small/fast model for background chores (titles, tool selection).
    pub tool: Option<ModelOption>,
    /// Admin-marked selectable candidates (modelOptions).
    pub options: Vec<ModelOption>,
    /// Server-configured system prompt ("chat" falling back to "main"), placeholders stripped.
    pub system_prompt: Option<String>,
    /// All enabled named prompts (name → body, un-stripped) for background chores.
    pub prompts: std::collections::HashMap<String, String>,
    /// Active Exa web-search service, when the admin configured one.
    pub exa: Option<ExaConfig>,
    /// Raw mcpServers array from the snapshot (parsed lazily by McpManager).
    pub mcp_servers: Vec<Value>,
    /// Raw skill summaries from the snapshot (materialized to disk on push).
    pub skills: Vec<Value>,
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

pub(crate) fn strip_placeholders(body: &str) -> String {
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

/// All enabled named prompts from the snapshot, body kept verbatim.
fn parse_prompts(v: &Value) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    let Some(prompts) = v.get("systemPrompts").and_then(|p| p.as_array()) else {
        return map;
    };
    for p in prompts {
        if !p.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true) {
            continue;
        }
        if let (Some(name), Some(body)) = (
            p.get("name").and_then(|n| n.as_str()),
            p.get("body").and_then(|b| b.as_str()),
        ) {
            map.insert(name.to_string(), body.to_string());
        }
    }
    map
}

fn pick_system_prompt(prompts: &std::collections::HashMap<String, String>) -> Option<String> {
    let body = prompts.get("chat").or_else(|| prompts.get("main"))?;
    let stripped = strip_placeholders(body);
    (!stripped.is_empty()).then_some(stripped)
}

/// Resolve the active Exa web-search service (kind == "exa", enabled, secret
/// present). Mirrors resolveExaService in the Electron client.
fn parse_exa(v: &Value) -> Option<ExaConfig> {
    let services = v.get("services")?.as_array()?;
    let svc = services.iter().find(|s| {
        s.get("kind").and_then(|k| k.as_str()) == Some("exa")
            && s.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false)
    })?;
    let api_key = svc.get("secret")?.as_str()?.trim().to_string();
    if api_key.is_empty() {
        return None;
    }
    let settings = svc.get("settings");
    let num_results = settings
        .and_then(|s| s.get("numResults"))
        .and_then(|n| n.as_u64())
        .filter(|n| *n > 0)
        .map(|n| n.min(25) as u32)
        .unwrap_or(10);
    let base_url = settings
        .and_then(|s| s.get("baseUrl"))
        .and_then(|b| b.as_str())
        .map(|b| b.trim().trim_end_matches('/').to_string())
        .filter(|b| !b.is_empty())
        .unwrap_or_else(|| "https://api.exa.ai".to_string());
    Some(ExaConfig { api_key, base_url, num_results })
}

pub(crate) fn parse_snapshot(v: &Value) -> Option<ServerConfig> {
    let main = v.get("llm").and_then(|l| l.get("main")).and_then(parse_active_llm);
    let tool = v.get("llm").and_then(|l| l.get("tool")).and_then(parse_active_llm);
    let options = v
        .get("modelOptions")
        .and_then(|m| m.as_array())
        .map(|list| list.iter().filter_map(parse_active_llm).collect())
        .unwrap_or_default();
    let prompts = parse_prompts(v);
    Some(ServerConfig {
        main,
        tool,
        options,
        system_prompt: pick_system_prompt(&prompts),
        prompts,
        exa: parse_exa(v),
        mcp_servers: v
            .get("mcpServers")
            .and_then(|m| m.as_array())
            .cloned()
            .unwrap_or_default(),
        skills: v
            .get("skills")
            .and_then(|s| s.as_array())
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
        let _ = tx.send(ServerEvent::Authed {
            token: token.to_string(),
            server: server.trim_end_matches('/').to_string(),
        });

        let config_tx = tx.clone();
        let on_config = move |payload: rust_socketio::Payload, _| {
            if let rust_socketio::Payload::Text(values) = payload {
                if let Some(raw) = values.first() {
                    if let Some(config) = parse_snapshot(raw) {
                        let _ = config_tx.send(ServerEvent::Config(config, raw.to_string()));
                    }
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

        let memory_tx = tx.clone();
        let on_memory_remote = move |payload: rust_socketio::Payload, _| {
            if let rust_socketio::Payload::Text(values) = payload {
                if let Some(memories) = values
                    .first()
                    .and_then(|v| v.get("memories"))
                    .and_then(|m| {
                        serde_json::from_value::<Vec<flairy_contract::Memory>>(m.clone()).ok()
                    })
                {
                    let _ = memory_tx.send(ServerEvent::MemoryRemote(memories));
                }
            }
        };

        let outbox: std::sync::Arc<std::sync::Mutex<Outbox>> = Default::default();
        let online = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

        // Pull on every (re)connect so gaps while offline are backfilled.
        let pull_tx = tx.clone();
        let connect_outbox = outbox.clone();
        let connect_online = online.clone();
        let on_connect = move |_: rust_socketio::Payload, client: rust_socketio::RawClient| {
            connect_online.store(true, std::sync::atomic::Ordering::Relaxed);
            // Flush queued offline work BEFORE pulling, so the pull's merge
            // sees this device's latest state on the server.
            let queued = connect_outbox.lock().unwrap().drain();
            for (event, value) in queued {
                let _ = client.emit(event, value);
            }
            let memory_pull_tx = pull_tx.clone();
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
            // Memories: pull everything (the reply carries tombstones too, so
            // deletions made elsewhere land locally).
            let _ = client.emit_with_ack(
                "memory:pull",
                serde_json::json!({}),
                std::time::Duration::from_secs(10),
                move |payload: rust_socketio::Payload, _| {
                    if let rust_socketio::Payload::Text(values) = payload {
                        let list = values
                            .first()
                            .and_then(|v| v.as_array().cloned())
                            .unwrap_or_else(|| values.clone());
                        let memories: Vec<flairy_contract::Memory> = list
                            .into_iter()
                            .filter_map(|entry| serde_json::from_value(entry).ok())
                            .collect();
                        if !memories.is_empty() {
                            let _ = memory_pull_tx.send(ServerEvent::MemoryRemote(memories));
                        }
                    }
                },
            );
        };

        let close_online = online.clone();
        let client = rust_socketio::ClientBuilder::new(&server)
            .auth(serde_json::json!({"token": token}))
            .reconnect(true)
            .reconnect_on_disconnect(true)
            .reconnect_delay(1_000, 30_000)
            .on(rust_socketio::Event::Connect, on_connect)
            .on(rust_socketio::Event::Close, move |_, _| {
                close_online.store(false, std::sync::atomic::Ordering::Relaxed);
            })
            .on("config:snapshot", {
                let on_config = on_config.clone();
                move |p, c| on_config(p, c)
            })
            .on("config:updated", move |p, c| on_config(p, c))
            .on("session:remote", move |p, c| on_remote(p, c))
            .on("session:remote-delete", move |p, c| on_remote_delete(p, c))
            .on("memory:remote", move |p, c| on_memory_remote(p, c))
            .connect();

        let client = match client {
            Ok(client) => client,
            Err(err) => {
                eprintln!("socket connect failed: {err}");
                return;
            }
        };

        // Outgoing sync loop (blocking_recv is fine off-runtime). Offline (or
        // on a failed emit) the command lands in the outbox instead of being
        // dropped; the connect handler replays it.
        while let Some(command) = out_rx.blocking_recv() {
            if !online.load(std::sync::atomic::Ordering::Relaxed) {
                outbox.lock().unwrap().enqueue(command);
                continue;
            }
            let Some((event, value)) = serialize_command(&command) else { continue };
            if client.emit(event, value).is_err() {
                online.store(false, std::sync::atomic::Ordering::Relaxed);
                outbox.lock().unwrap().enqueue(command);
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

    #[test]
    fn parses_tool_role_prompts_and_exa() {
        let v: Value = serde_json::from_str(
            r#"{
              "llm": {
                "main": null,
                "tool": {"provider":{"id":"p1","name":"A","api":"anthropic-messages","credential":"sk-t"},"model":{"id":"m","providerId":"p1","name":"Haiku","model":"claude-haiku-4-5"}}
              },
              "systemPrompts": [
                {"name":"main","body":"hi {{memory}}","enabled":true},
                {"name":"title_generation","body":"make a title","enabled":true},
                {"name":"off","body":"x","enabled":false}
              ],
              "services": [
                {"id":"s1","kind":"exa","name":"Exa","enabled":true,"secret":"exa-key","settings":{"numResults":5,"baseUrl":"https://exa.example.com/"}}
              ]
            }"#,
        )
        .unwrap();
        let config = parse_snapshot(&v).unwrap();
        assert!(config.main.is_none());
        assert_eq!(config.tool.unwrap().model.id, "claude-haiku-4-5");
        assert_eq!(config.system_prompt.as_deref(), Some("hi"));
        assert_eq!(config.prompts.get("title_generation").map(String::as_str), Some("make a title"));
        assert!(!config.prompts.contains_key("off"));
        let exa = config.exa.unwrap();
        assert_eq!(exa.api_key, "exa-key");
        assert_eq!(exa.base_url, "https://exa.example.com");
        assert_eq!(exa.num_results, 5);

        // Disabled or secret-less services resolve to None.
        let v2: Value = serde_json::from_str(
            r#"{"services":[{"kind":"exa","enabled":false,"secret":"k"},{"kind":"exa","enabled":true,"secret":"  "}]}"#,
        )
        .unwrap();
        assert!(parse_snapshot(&v2).unwrap().exa.is_none());
    }

    #[test]
    fn outbox_coalesces() {
        let upsert = |id: &str| {
            Outgoing::Upsert(SessionUpsertPayload {
                session: crate::contract::Session {
                    id: id.into(),
                    user_id: String::new(),
                    title: "t".into(),
                    created_at: 1,
                    updated_at: 1,
                },
                messages: Vec::new(),
            })
        };
        let mut outbox = Outbox::default();
        outbox.enqueue(upsert("a"));
        outbox.enqueue(upsert("a")); // coalesced
        outbox.enqueue(Outgoing::PatchTitle {
            session_id: "a".into(),
            title: "old".into(),
            updated_at: 5,
        });
        outbox.enqueue(Outgoing::PatchTitle {
            session_id: "a".into(),
            title: "stale".into(),
            updated_at: 3, // older — ignored
        });
        outbox.enqueue(upsert("b"));
        outbox.enqueue(Outgoing::Delete { session_id: "b".into() }); // kills b's upsert
        let drained = outbox.drain();
        let events: Vec<&str> = drained.iter().map(|(e, _)| *e).collect();
        assert_eq!(events, vec!["session:upsert", "session:patch", "session:delete"]);
        let patch = &drained[1].1;
        assert_eq!(patch["title"], "old");
        assert!(outbox.drain().is_empty());
    }
}
