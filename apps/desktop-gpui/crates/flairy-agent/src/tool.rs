use serde_json::Value;

pub struct ToolOutput {
    /// Text fed back to the model.
    pub content: String,
    /// Structured details for the host UI (paths, counts, …).
    pub details: Value,
}

/// A local tool. Mirrors pi-agent-core's AgentTool: label is user-facing,
/// execute errors become tool errors (never panics).
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    /// User-facing label, e.g. "读取文件".
    fn label(&self) -> &str;
    fn description(&self) -> &str;
    /// JSON Schema for the input object.
    fn schema(&self) -> Value;
    fn execute(&self, input: Value) -> anyhow::Result<ToolOutput>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Allow,
    Deny,
}

/// Approval gate consulted before each tool call (pi's beforeToolCall).
/// Returning Deny records a tool error and the loop continues.
pub trait ApprovalGate: Send + Sync {
    fn check(&self, tool_name: &str, input: &Value) -> ApprovalDecision;
}

pub struct AutoApprove;
impl ApprovalGate for AutoApprove {
    fn check(&self, _: &str, _: &Value) -> ApprovalDecision {
        ApprovalDecision::Allow
    }
}
