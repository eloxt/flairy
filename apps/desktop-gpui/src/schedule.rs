//! Scheduled tasks: the `schedule` tool + due-time evaluation. Device-local
//! by design (like the Electron scheduler) — tasks never sync. The app runs a
//! 60-second ticker; due tasks submit a headless turn into their session with
//! approvals auto-denied.

use flairy_agent::{Tool, ToolOutput};
use serde_json::{Value, json};
use std::str::FromStr;
use tokio::sync::mpsc::UnboundedSender;

#[derive(Debug, Clone)]
pub struct ScheduledTask {
    pub id: String,
    pub session_id: String,
    pub prompt: String,
    /// 5-field cron expression (None ⇒ one-shot).
    pub cron: Option<String>,
    /// Epoch ms for a one-shot run.
    pub run_at: Option<i64>,
    pub active: bool,
    pub last_run: Option<i64>,
    pub created_at: i64,
}

/// True when the task should fire now. Cron tasks fire when an occurrence
/// falls in (last_run.max(created_at), now]; one-shots when run_at ≤ now.
pub fn is_due(task: &ScheduledTask, now_ms: i64) -> bool {
    if !task.active {
        return false;
    }
    if let Some(run_at) = task.run_at {
        return task.last_run.is_none() && run_at <= now_ms;
    }
    let Some(expr) = &task.cron else { return false };
    let Some(schedule) = parse_cron(expr) else { return false };
    let after_ms = task.last_run.unwrap_or(task.created_at);
    let after = chrono::DateTime::<chrono::Local>::from(
        std::time::UNIX_EPOCH + std::time::Duration::from_millis(after_ms.max(0) as u64),
    );
    match schedule.after(&after).next() {
        Some(next) => next.timestamp_millis() <= now_ms,
        None => false,
    }
}

/// Parse a 5-field cron expression (the `cron` crate wants 6/7 fields with
/// seconds, so a 5-field form gets "0 " prepended). Local-time semantics.
pub fn parse_cron(expr: &str) -> Option<cron::Schedule> {
    let trimmed = expr.trim();
    let fields = trimmed.split_whitespace().count();
    let normalized = if fields == 5 { format!("0 {trimmed}") } else { trimmed.to_string() };
    cron::Schedule::from_str(&normalized).ok()
}

pub enum ScheduleAction {
    Create {
        prompt: String,
        cron: Option<String>,
        /// Minutes from now for a one-shot task.
        delay_minutes: Option<u64>,
    },
    List,
    Pause(String),
    Resume(String),
    Delete(String),
}

/// A schedule-tool call; the app applies it against the store and replies
/// with the model-facing result text (Err text for invalid ids etc.).
pub struct ScheduleRequest {
    /// Session the tool was called in — created tasks bind to it.
    pub session_id: String,
    pub action: ScheduleAction,
    pub reply: std::sync::mpsc::Sender<Result<String, String>>,
}

/// schedule — create and manage recurring or one-time automatic prompts.
/// Approval-exempt (only manages the user's own local schedule).
pub struct ScheduleTool {
    pub session_id: String,
    pub tx: UnboundedSender<ScheduleRequest>,
}

impl Tool for ScheduleTool {
    fn name(&self) -> &str {
        "schedule"
    }
    fn label(&self) -> &str {
        "计划任务"
    }
    fn description(&self) -> &str {
        "Create and manage scheduled tasks that automatically run a prompt in this conversation later. Actions: \"create\" (needs `prompt` plus either `cron` — a 5-field cron expression in local time, e.g. \"0 9 * * 1-5\" for weekdays at 09:00 — or `delayMinutes` for a one-time run), \"list\", \"pause\"/\"resume\"/\"delete\" (need `id`). Scheduled runs happen on this device while the app is open; tools that need confirmation are skipped during them."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["create", "list", "pause", "resume", "delete"]},
                "prompt": {"type": "string", "description": "What to ask when the task fires (create)."},
                "cron": {"type": "string", "description": "5-field cron expression, local time (create, recurring)."},
                "delayMinutes": {"type": "number", "description": "Run once after N minutes (create, one-shot)."},
                "id": {"type": "string", "description": "Task id (pause/resume/delete)."}
            },
            "required": ["action"]
        })
    }
    fn execute(&self, input: Value) -> anyhow::Result<ToolOutput> {
        let action = match input.get("action").and_then(|a| a.as_str()) {
            Some("create") => {
                let prompt = input
                    .get("prompt")
                    .and_then(|p| p.as_str())
                    .map(str::trim)
                    .filter(|p| !p.is_empty())
                    .ok_or_else(|| anyhow::anyhow!("create requires a non-empty \"prompt\""))?
                    .to_string();
                let cron_expr = input
                    .get("cron")
                    .and_then(|c| c.as_str())
                    .map(str::trim)
                    .filter(|c| !c.is_empty())
                    .map(str::to_string);
                let delay_minutes = input
                    .get("delayMinutes")
                    .and_then(|d| d.as_u64())
                    .filter(|d| *d > 0);
                if let Some(expr) = &cron_expr {
                    if parse_cron(expr).is_none() {
                        anyhow::bail!("invalid cron expression: \"{expr}\"");
                    }
                }
                if cron_expr.is_none() && delay_minutes.is_none() {
                    anyhow::bail!("create requires either \"cron\" or \"delayMinutes\"");
                }
                ScheduleAction::Create { prompt, cron: cron_expr, delay_minutes }
            }
            Some("list") => ScheduleAction::List,
            Some(other @ ("pause" | "resume" | "delete")) => {
                let id = input
                    .get("id")
                    .and_then(|i| i.as_str())
                    .filter(|i| !i.is_empty())
                    .ok_or_else(|| anyhow::anyhow!("{other} requires \"id\""))?
                    .to_string();
                match other {
                    "pause" => ScheduleAction::Pause(id),
                    "resume" => ScheduleAction::Resume(id),
                    _ => ScheduleAction::Delete(id),
                }
            }
            _ => anyhow::bail!("unknown schedule action"),
        };
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        let request = ScheduleRequest {
            session_id: self.session_id.clone(),
            action,
            reply: reply_tx,
        };
        if self.tx.send(request).is_err() {
            anyhow::bail!("scheduler unavailable");
        }
        match reply_rx.recv() {
            Ok(Ok(text)) => Ok(ToolOutput { content: text, details: json!({}) }),
            Ok(Err(err)) => anyhow::bail!(err),
            Err(_) => anyhow::bail!("scheduler unavailable"),
        }
    }
}

/// Model-facing rendering of the task list.
pub fn format_tasks(tasks: &[ScheduledTask]) -> String {
    if tasks.is_empty() {
        return "No scheduled tasks.".to_string();
    }
    tasks
        .iter()
        .map(|t| {
            let when = t
                .cron
                .as_deref()
                .map(|c| format!("cron \"{c}\""))
                .unwrap_or_else(|| "one-shot".to_string());
            let state = if t.active { "active" } else { "paused" };
            format!("- id: {} | {} | {} | prompt: {}", t.id, when, state, t.prompt)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(cron: Option<&str>, run_at: Option<i64>, last_run: Option<i64>, created: i64) -> ScheduledTask {
        ScheduledTask {
            id: "t".into(),
            session_id: "s".into(),
            prompt: "p".into(),
            cron: cron.map(str::to_string),
            run_at,
            active: true,
            last_run,
            created_at: created,
        }
    }

    #[test]
    fn cron_parsing_and_due() {
        assert!(parse_cron("0 9 * * 1-5").is_some());
        assert!(parse_cron("*/5 * * * *").is_some());
        assert!(parse_cron("not a cron").is_none());

        let now = flairy_ai::types::now_ms() as i64;
        // Every-minute cron created 10 minutes ago and never run → due.
        assert!(is_due(&task(Some("* * * * *"), None, None, now - 600_000), now));
        // Just ran → not due again within the same minute window.
        assert!(!is_due(&task(Some("* * * * *"), None, Some(now), now), now));
        // One-shot in the past, never run → due; already run → never again.
        assert!(is_due(&task(None, Some(now - 1_000), None, now - 10_000), now));
        assert!(!is_due(&task(None, Some(now - 1_000), Some(now - 500), now - 10_000), now));
        // One-shot in the future → not due.
        assert!(!is_due(&task(None, Some(now + 60_000), None, now), now));
        // Paused tasks never fire.
        let mut paused = task(Some("* * * * *"), None, None, now - 600_000);
        paused.active = false;
        assert!(!is_due(&paused, now));
    }
}
