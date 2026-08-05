//! Contract for the built-in `todo_write` tool, ported from the Electron
//! client's shared/todo.ts. The tool returns a single JSON object tagged
//! `"type":"flairy_todo"` as its text content; the plan lives entirely in that
//! sentinel (persists + syncs with the message history — no extra state).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub content: String,
    pub status: TodoStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
}

const MARKER: &str = "flairy_todo";

pub fn encode_todos(todos: &[TodoItem]) -> String {
    serde_json::json!({
        "type": MARKER,
        "todos": todos.iter().map(|t| {
            let mut obj = serde_json::json!({
                "content": t.content,
                "status": match t.status {
                    TodoStatus::Pending => "pending",
                    TodoStatus::InProgress => "in_progress",
                    TodoStatus::Completed => "completed",
                },
            });
            if let Some(active) = &t.active_form {
                obj["activeForm"] = serde_json::json!(active);
            }
            obj
        }).collect::<Vec<_>>(),
    })
    .to_string()
}

/// Parse a tool-result text into todos, or None if it isn't our sentinel.
/// Cheap substring guard before the JSON parse; never panics.
pub fn parse_todos(text: &str) -> Option<Vec<TodoItem>> {
    let trimmed = text.trim();
    if !trimmed.starts_with('{') || !trimmed.contains(MARKER) {
        return None;
    }
    let obj: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    if obj.get("type").and_then(|t| t.as_str()) != Some(MARKER) {
        return None;
    }
    let todos = obj.get("todos")?.as_array()?;
    Some(
        todos
            .iter()
            .filter_map(|t| {
                let content = t.get("content")?.as_str()?.to_string();
                if content.is_empty() {
                    return None;
                }
                let status = match t.get("status").and_then(|s| s.as_str()) {
                    Some("in_progress") => TodoStatus::InProgress,
                    Some("completed") => TodoStatus::Completed,
                    _ => TodoStatus::Pending,
                };
                Some(TodoItem {
                    content,
                    status,
                    active_form: t
                        .get("activeForm")
                        .and_then(|a| a.as_str())
                        .map(str::trim)
                        .filter(|a| !a.is_empty())
                        .map(str::to_string),
                })
            })
            .collect(),
    )
}

/// Human-readable checklist for the collapsed tool row / expanded card.
pub fn format_todos(todos: &[TodoItem]) -> String {
    todos
        .iter()
        .map(|t| {
            let mark = match t.status {
                TodoStatus::Completed => "[x]",
                TodoStatus::InProgress => "[~]",
                TodoStatus::Pending => "[ ]",
            };
            format!("{mark} {}", t.content)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_guards() {
        let todos = vec![
            TodoItem { content: "步骤一".into(), status: TodoStatus::Completed, active_form: None },
            TodoItem {
                content: "步骤二".into(),
                status: TodoStatus::InProgress,
                active_form: Some("正在做步骤二".into()),
            },
        ];
        let text = encode_todos(&todos);
        let parsed = parse_todos(&text).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].status, TodoStatus::InProgress);
        assert_eq!(parsed[1].active_form.as_deref(), Some("正在做步骤二"));
        assert!(parse_todos("not json").is_none());
        assert!(parse_todos("{\"type\":\"other\"}").is_none());
        assert_eq!(format_todos(&todos), "[x] 步骤一\n[~] 步骤二");
    }
}
