//! End-to-end agent loop test against a local mock server speaking the
//! Anthropic Messages SSE protocol: text → tool_use → tool result → end_turn.
//! No real API key or network needed.

use flairy_agent::{Agent, AgentEvent, Tool, ToolOutput};
use flairy_ai::Model;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

fn sse_body(events: &[serde_json::Value]) -> String {
    events
        .iter()
        .map(|e| format!("data: {e}\n\n"))
        .collect::<String>()
}

fn respond(stream: &mut std::net::TcpStream, body: &str) {
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    stream.write_all(response.as_bytes()).unwrap();
}

fn read_request(stream: &mut std::net::TcpStream) -> String {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let lower = line.to_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            content_length = v.trim().parse().unwrap();
        }
        if line == "\r\n" {
            break;
        }
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body).unwrap();
    String::from_utf8(body).unwrap()
}

/// Mock server: first request returns text + a tool_use; second returns
/// a final text and end_turn.
fn spawn_mock_server() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        // Request 1: tool call
        let (mut s1, _) = listener.accept().unwrap();
        let body1 = read_request(&mut s1);
        assert!(body1.contains("\"echo\""), "tools should be sent");
        respond(
            &mut s1,
            &sse_body(&[
                serde_json::json!({"type":"message_start","message":{"usage":{"input_tokens":10}}}),
                serde_json::json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                serde_json::json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"让我调用工具。"}}),
                serde_json::json!({"type":"content_block_stop","index":0}),
                serde_json::json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"tu_1","name":"echo","input":{}}}),
                serde_json::json!({"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"text\":\"hi\"}"}}),
                serde_json::json!({"type":"content_block_stop","index":1}),
                serde_json::json!({"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":7}}),
                serde_json::json!({"type":"message_stop"}),
            ]),
        );

        // Request 2: must contain the tool result; final answer
        let (mut s2, _) = listener.accept().unwrap();
        let body2 = read_request(&mut s2);
        assert!(body2.contains("tool_result"), "tool result should be echoed back");
        assert!(body2.contains("echoed: hi"), "tool output should be in the request");
        respond(
            &mut s2,
            &sse_body(&[
                serde_json::json!({"type":"message_start","message":{"usage":{"input_tokens":20}}}),
                serde_json::json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}),
                serde_json::json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"完成："}}),
                serde_json::json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"echoed: hi"}}),
                serde_json::json!({"type":"content_block_stop","index":0}),
                serde_json::json!({"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}),
                serde_json::json!({"type":"message_stop"}),
            ]),
        );
    });
    port
}

struct EchoTool;
impl Tool for EchoTool {
    fn name(&self) -> &str {
        "echo"
    }
    fn label(&self) -> &str {
        "回显"
    }
    fn description(&self) -> &str {
        "Echo the input text back"
    }
    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"]
        })
    }
    fn execute(&self, input: serde_json::Value) -> anyhow::Result<ToolOutput> {
        let text = input["text"].as_str().unwrap_or_default();
        Ok(ToolOutput {
            content: format!("echoed: {text}"),
            details: serde_json::json!({}),
        })
    }
}

#[tokio::test]
async fn agent_loop_streams_and_calls_tools() {
    let port = spawn_mock_server();

    let model = Model {
        api: flairy_ai::API_ANTHROPIC.to_string(),
        provider: "anthropic".to_string(),
        id: "claude-test".to_string(),
        base_url: format!("http://127.0.0.1:{port}"),
        max_tokens: 1024,
    };

    let mut agent = Agent::new(
        model,
        "你是测试助手。",
        Arc::new(|_provider: &str| Some("test-key".to_string())),
    )
    .with_tools(vec![Arc::new(EchoTool)]);

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let cancel = Arc::new(AtomicBool::new(false));
    agent.run("请回显 hi".to_string(), tx, cancel).await;

    let mut deltas = String::new();
    let mut tool_started = false;
    let mut tool_output = String::new();
    let mut done_messages = 0usize;
    let mut errors = Vec::new();
    while let Some(event) = rx.recv().await {
        match event {
            AgentEvent::TextDelta { text } => deltas.push_str(&text),
            AgentEvent::ToolCallStart { name, input, .. } => {
                assert_eq!(name, "echo");
                assert_eq!(input["text"], "hi");
                tool_started = true;
            }
            AgentEvent::ToolResult { output, is_error, .. } => {
                assert!(!is_error);
                tool_output = output;
            }
            AgentEvent::Done { messages } => done_messages = messages.len(),
            AgentEvent::Error { message } => errors.push(message),
            _ => {}
        }
    }

    assert!(errors.is_empty(), "agent errored: {errors:?}");
    assert!(tool_started, "tool call should have started");
    assert_eq!(tool_output, "echoed: hi");
    assert!(deltas.contains("让我调用工具。"));
    assert!(deltas.contains("完成：echoed: hi"));
    // user + assistant(tool_use) + user(tool_result) + assistant(final)
    assert_eq!(done_messages, 4);
}
