//! Built-in file tools: write_file / edit_file (approval-gated) and
//! grep / find (read-only, gitignore-aware via the `ignore` crate — the same
//! engine ripgrep/fd are built on, so no bundled binaries needed).
//! Ported from the Electron client's write/edit/grep/find tools.

use flairy_agent::{Tool, ToolOutput};
use serde_json::{Value, json};

const GREP_MAX_MATCHES: usize = 200;
const GREP_MAX_FILE_BYTES: u64 = 2_000_000;
const FIND_MAX_RESULTS: usize = 500;

fn required_str<'a>(input: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    input
        .get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("missing required \"{key}\""))
}

pub struct WriteFileTool;

impl Tool for WriteFileTool {
    fn name(&self) -> &str {
        "write_file"
    }
    fn label(&self) -> &str {
        "写入文件"
    }
    fn description(&self) -> &str {
        "Write a UTF-8 text file to the local filesystem, creating parent directories as needed. Overwrites the file if it exists — read it first when editing existing content, or prefer edit_file for targeted changes."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "absolute file path"},
                "content": {"type": "string", "description": "full file content"}
            },
            "required": ["path", "content"]
        })
    }
    fn execute(&self, input: Value) -> anyhow::Result<ToolOutput> {
        let path = required_str(&input, "path")?;
        let content = input.get("content").and_then(|c| c.as_str()).unwrap_or_default();
        if let Some(parent) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, content)?;
        let lines = content.lines().count();
        Ok(ToolOutput {
            content: format!("Wrote {lines} lines to {path}"),
            details: json!({"path": path, "bytes": content.len()}),
        })
    }
}

pub struct EditFileTool;

impl Tool for EditFileTool {
    fn name(&self) -> &str {
        "edit_file"
    }
    fn label(&self) -> &str {
        "编辑文件"
    }
    fn description(&self) -> &str {
        "Make a targeted edit to a text file by exact string replacement. `old_text` must match the file content exactly (including whitespace) and, unless `replace_all` is true, must appear exactly once."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "absolute file path"},
                "old_text": {"type": "string", "description": "exact text to replace"},
                "new_text": {"type": "string", "description": "replacement text"},
                "replace_all": {"type": "boolean", "description": "replace every occurrence (default false)"}
            },
            "required": ["path", "old_text", "new_text"]
        })
    }
    fn execute(&self, input: Value) -> anyhow::Result<ToolOutput> {
        let path = required_str(&input, "path")?;
        let old_text = required_str(&input, "old_text")?;
        let new_text = input.get("new_text").and_then(|t| t.as_str()).unwrap_or_default();
        let replace_all = input.get("replace_all").and_then(|r| r.as_bool()).unwrap_or(false);
        let content = std::fs::read_to_string(path)?;
        let occurrences = content.matches(old_text).count();
        if occurrences == 0 {
            anyhow::bail!("old_text not found in {path}");
        }
        if occurrences > 1 && !replace_all {
            anyhow::bail!(
                "old_text appears {occurrences} times in {path}; make it unique or set replace_all"
            );
        }
        let updated = if replace_all {
            content.replace(old_text, new_text)
        } else {
            content.replacen(old_text, new_text, 1)
        };
        std::fs::write(path, &updated)?;
        Ok(ToolOutput {
            content: format!(
                "Replaced {} occurrence(s) in {path}",
                if replace_all { occurrences } else { 1 }
            ),
            details: json!({"path": path, "occurrences": occurrences}),
        })
    }
}

pub struct GrepTool;

impl Tool for GrepTool {
    fn name(&self) -> &str {
        "grep"
    }
    fn label(&self) -> &str {
        "搜索内容"
    }
    fn description(&self) -> &str {
        "Search file contents under a directory with a regular expression (gitignore-aware, skips binaries). Returns matching lines as path:line: text, capped at 200 matches."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {"type": "string", "description": "regular expression to search for"},
                "path": {"type": "string", "description": "absolute directory (or file) to search in"},
                "ignore_case": {"type": "boolean", "description": "case-insensitive match (default false)"}
            },
            "required": ["pattern", "path"]
        })
    }
    fn execute(&self, input: Value) -> anyhow::Result<ToolOutput> {
        let pattern = required_str(&input, "pattern")?;
        let path = required_str(&input, "path")?;
        let ignore_case = input.get("ignore_case").and_then(|i| i.as_bool()).unwrap_or(false);
        let regex = regex::RegexBuilder::new(pattern)
            .case_insensitive(ignore_case)
            .build()
            .map_err(|e| anyhow::anyhow!("invalid pattern: {e}"))?;

        let mut matches: Vec<String> = Vec::new();
        let mut truncated = false;
        'walk: for entry in ignore::WalkBuilder::new(path).build() {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            if entry.metadata().map(|m| m.len() > GREP_MAX_FILE_BYTES).unwrap_or(true) {
                continue;
            }
            // Skip binary-ish files: read as UTF-8, bail on failure.
            let Ok(content) = std::fs::read_to_string(entry.path()) else { continue };
            for (ix, line) in content.lines().enumerate() {
                if regex.is_match(line) {
                    let line_out: String = line.trim_end().chars().take(400).collect();
                    matches.push(format!("{}:{}: {}", entry.path().display(), ix + 1, line_out));
                    if matches.len() >= GREP_MAX_MATCHES {
                        truncated = true;
                        break 'walk;
                    }
                }
            }
        }
        let count = matches.len();
        let mut content = if matches.is_empty() {
            format!("No matches for /{pattern}/ under {path}")
        } else {
            matches.join("\n")
        };
        if truncated {
            content.push_str("\n…(matches truncated)");
        }
        Ok(ToolOutput { content, details: json!({"count": count, "truncated": truncated}) })
    }
}

pub struct FindTool;

impl Tool for FindTool {
    fn name(&self) -> &str {
        "find"
    }
    fn label(&self) -> &str {
        "查找文件"
    }
    fn description(&self) -> &str {
        "Find files by name under a directory using a glob pattern (e.g. \"*.rs\", \"**/config.*\"). Gitignore-aware; returns matching paths, capped at 500."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "glob": {"type": "string", "description": "glob pattern matched against the path relative to the search root"},
                "path": {"type": "string", "description": "absolute directory to search in"}
            },
            "required": ["glob", "path"]
        })
    }
    fn execute(&self, input: Value) -> anyhow::Result<ToolOutput> {
        let glob = required_str(&input, "glob")?;
        let path = required_str(&input, "path")?;
        // A bare "*.rs" should match at any depth, like fd.
        let effective = if glob.contains('/') { glob.to_string() } else { format!("**/{glob}") };
        let matcher = globset::GlobBuilder::new(&effective)
            .literal_separator(true)
            .build()
            .map_err(|e| anyhow::anyhow!("invalid glob: {e}"))?
            .compile_matcher();

        let root = std::path::Path::new(path);
        let mut results: Vec<String> = Vec::new();
        let mut truncated = false;
        for entry in ignore::WalkBuilder::new(root).build() {
            let Ok(entry) = entry else { continue };
            if !entry.file_type().is_some_and(|t| t.is_file()) {
                continue;
            }
            let relative = entry.path().strip_prefix(root).unwrap_or(entry.path());
            if matcher.is_match(relative) {
                results.push(entry.path().display().to_string());
                if results.len() >= FIND_MAX_RESULTS {
                    truncated = true;
                    break;
                }
            }
        }
        results.sort();
        let count = results.len();
        let mut content = if results.is_empty() {
            format!("No files matching {glob} under {path}")
        } else {
            results.join("\n")
        };
        if truncated {
            content.push_str("\n…(results truncated)");
        }
        Ok(ToolOutput { content, details: json!({"count": count, "truncated": truncated}) })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flairy_agent::Tool;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("flairy-file-tools-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_edit_roundtrip() {
        let dir = temp_dir("we");
        let file = dir.join("a/b.txt");
        let out = WriteFileTool
            .execute(json!({"path": file.to_str().unwrap(), "content": "hello world\nsecond"}))
            .unwrap();
        assert!(out.content.contains("2 lines"));

        let err = EditFileTool
            .execute(json!({"path": file.to_str().unwrap(), "old_text": "nope", "new_text": "x"}))
            .err()
            .expect("edit of missing text must fail");
        assert!(err.to_string().contains("not found"));

        EditFileTool
            .execute(json!({"path": file.to_str().unwrap(), "old_text": "world", "new_text": "rust"}))
            .unwrap();
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "hello rust\nsecond");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn grep_and_find() {
        let dir = temp_dir("gf");
        std::fs::write(dir.join("one.rs"), "fn main() {}\nlet x = 42;\n").unwrap();
        std::fs::write(dir.join("two.txt"), "nothing here\n").unwrap();

        let out = GrepTool
            .execute(json!({"pattern": "x = \\d+", "path": dir.to_str().unwrap()}))
            .unwrap();
        assert!(out.content.contains("one.rs:2"));
        assert_eq!(out.details["count"], 1);

        let out = FindTool
            .execute(json!({"glob": "*.rs", "path": dir.to_str().unwrap()}))
            .unwrap();
        assert!(out.content.contains("one.rs"));
        assert!(!out.content.contains("two.txt"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
