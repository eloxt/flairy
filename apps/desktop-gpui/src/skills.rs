//! Skill materialization: server-pushed skill summaries → on-disk Agent
//! Skills under `~/Library/Application Support/Flairy/skills/<name>/`, plus
//! the `<skills_instructions>` prompt block. Port of the Electron client's
//! skill-materializer.ts.
//!
//! The snapshot carries only lightweight summaries; the full skill (SKILL.md
//! body + files) is fetched over REST and cached by `updatedAt` — a reconnect
//! delivering the same catalog is a no-op and the client stays offline-capable.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub fn skills_root() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(home).join("Library/Application Support/Flairy/skills")
}

fn skill_dir(name: &str) -> std::path::PathBuf {
    skills_root().join(name)
}

fn manifest_path() -> std::path::PathBuf {
    skills_root().join(".manifest.json")
}

/// One entry in the on-disk manifest mirroring what's materialized.
#[derive(Clone, Serialize, Deserialize)]
struct ManifestEntry {
    id: String,
    name: String,
    enabled: bool,
    updated_at: String,
}

fn read_manifest() -> Vec<ManifestEntry> {
    std::fs::read_to_string(manifest_path())
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn write_manifest(entries: &[ManifestEntry]) {
    let _ = std::fs::create_dir_all(skills_root());
    if let Ok(json) = serde_json::to_string_pretty(entries) {
        let _ = std::fs::write(manifest_path(), json);
    }
}

/// Materialize the enabled subset of the snapshot's skill summaries on a
/// background thread. Defensive: one skill's failure never sinks the rest.
pub fn materialize(summaries: Vec<Value>, token: String, base_url: String) {
    std::thread::spawn(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .unwrap_or_default();
        let base_url = base_url.trim_end_matches('/').to_string();

        let enabled: Vec<&Value> = summaries
            .iter()
            .filter(|s| s.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false))
            .collect();
        let mut manifest: std::collections::HashMap<String, ManifestEntry> =
            read_manifest().into_iter().map(|e| (e.id.clone(), e)).collect();

        // Remove skills that are gone or no longer enabled (disk + manifest).
        let keep: std::collections::HashSet<&str> = enabled
            .iter()
            .filter_map(|s| s.get("id").and_then(|i| i.as_str()))
            .collect();
        manifest.retain(|id, entry| {
            if keep.contains(id.as_str()) {
                true
            } else {
                let _ = std::fs::remove_dir_all(skill_dir(&entry.name));
                false
            }
        });

        for summary in enabled {
            let Some(id) = summary.get("id").and_then(|i| i.as_str()) else { continue };
            let updated_at = summary
                .get("updatedAt")
                .and_then(|u| u.as_str())
                .unwrap_or_default();
            if manifest
                .get(id)
                .is_some_and(|prev| prev.updated_at == updated_at && prev.enabled)
            {
                continue; // unchanged — already on disk
            }
            match fetch_and_write(&client, id, &token, &base_url, manifest.get(id)) {
                Ok(entry) => {
                    manifest.insert(id.to_string(), entry);
                }
                Err(err) => {
                    let name = summary.get("name").and_then(|n| n.as_str()).unwrap_or(id);
                    eprintln!("[skills] failed to materialize \"{name}\": {err:#}");
                }
            }
        }

        let entries: Vec<ManifestEntry> = manifest.into_values().collect();
        write_manifest(&entries);
    });
}

fn fetch_and_write(
    client: &reqwest::blocking::Client,
    id: &str,
    token: &str,
    base_url: &str,
    prev: Option<&ManifestEntry>,
) -> anyhow::Result<ManifestEntry> {
    let skill: Value = client
        .get(format!("{base_url}/api/skills/{id}"))
        .bearer_auth(token)
        .send()?
        .error_for_status()?
        .json()?;
    let name = skill
        .get("name")
        .and_then(|n| n.as_str())
        .filter(|n| !n.is_empty() && !n.contains('/') && !n.contains(".."))
        .ok_or_else(|| anyhow::anyhow!("skill {id} has an invalid name"))?;

    // Name changed → drop the stale directory first.
    if let Some(prev) = prev {
        if prev.name != name {
            let _ = std::fs::remove_dir_all(skill_dir(&prev.name));
        }
    }
    let dir = skill_dir(name);
    let _ = std::fs::remove_dir_all(&dir); // start clean between updates
    std::fs::create_dir_all(&dir)?;

    let body = skill.get("skillMdBody").and_then(|b| b.as_str()).unwrap_or_default();
    let skill_md = format!("{}\n\n{body}", compose_frontmatter(&skill));
    std::fs::write(dir.join("SKILL.md"), skill_md)?;

    if let Some(files) = skill.get("files").and_then(|f| f.as_array()) {
        for file in files {
            if let Err(err) = write_skill_file(client, id, token, base_url, &dir, file) {
                let path = file.get("path").and_then(|p| p.as_str()).unwrap_or("?");
                eprintln!("[skills] skill \"{name}\" file \"{path}\" failed: {err:#}");
            }
        }
    }

    Ok(ManifestEntry {
        id: id.to_string(),
        name: name.to_string(),
        enabled: skill.get("enabled").and_then(|e| e.as_bool()).unwrap_or(true),
        updated_at: skill
            .get("updatedAt")
            .and_then(|u| u.as_str())
            .unwrap_or_default()
            .to_string(),
    })
}

fn write_skill_file(
    client: &reqwest::blocking::Client,
    skill_id: &str,
    token: &str,
    base_url: &str,
    dir: &std::path::Path,
    file: &Value,
) -> anyhow::Result<()> {
    use base64::Engine as _;
    let path = file
        .get("path")
        .and_then(|p| p.as_str())
        .filter(|p| !p.is_empty() && !p.contains("..") && !p.starts_with('/'))
        .ok_or_else(|| anyhow::anyhow!("invalid file path"))?;
    let bytes: Vec<u8> = match file.get("sourceType").and_then(|t| t.as_str()) {
        Some("text") => file
            .get("content")
            .and_then(|c| c.as_str())
            .unwrap_or_default()
            .as_bytes()
            .to_vec(),
        Some("dataurl") => {
            let dataurl = file.get("dataurl").and_then(|d| d.as_str()).unwrap_or_default();
            let b64 = dataurl.split_once(',').map(|(_, b)| b).unwrap_or_default();
            base64::engine::general_purpose::STANDARD.decode(b64)?
        }
        // url/upload → fetch from the server with the user JWT.
        _ => {
            let encoded: String = path
                .split('/')
                .map(urlencode_segment)
                .collect::<Vec<_>>()
                .join("/");
            client
                .get(format!("{base_url}/api/skills/{skill_id}/files/{encoded}"))
                .bearer_auth(token)
                .send()?
                .error_for_status()?
                .bytes()?
                .to_vec()
        }
    };
    let dest = dir.join(path);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(dest, bytes)?;
    Ok(())
}

fn urlencode_segment(seg: &str) -> String {
    seg.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            other => format!("%{other:02X}"),
        })
        .collect()
}

fn yaml_scalar(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| format!("\"{value}\""))
}

fn compose_frontmatter(skill: &Value) -> String {
    let mut lines = vec!["---".to_string()];
    for key in ["name", "description", "license", "compatibility"] {
        if let Some(v) = skill.get(key).and_then(|v| v.as_str()).filter(|v| !v.is_empty()) {
            lines.push(format!("{key}: {}", yaml_scalar(v)));
        }
    }
    if let Some(allowed) = skill
        .get("allowedTools")
        .and_then(|a| a.as_str())
        .filter(|a| !a.is_empty())
    {
        lines.push(format!("allowed-tools: {}", yaml_scalar(allowed)));
    }
    if let Some(metadata) = skill.get("metadata").and_then(|m| m.as_object()) {
        if !metadata.is_empty() {
            lines.push("metadata:".to_string());
            for (k, v) in metadata {
                let v = v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string());
                lines.push(format!("  {k}: {v}"));
            }
        }
    }
    lines.push("---".to_string());
    lines.join("\n")
}

/// The `<skills_instructions>` prompt block, or "" when nothing is available.
/// Cross-references the snapshot (source of enabled + description) with what
/// is actually materialized on disk, so we never advertise an unreadable path.
pub fn skills_instructions(config_skills: &[Value]) -> String {
    let enabled: std::collections::HashMap<&str, &str> = config_skills
        .iter()
        .filter(|s| s.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false))
        .filter_map(|s| {
            Some((
                s.get("id")?.as_str()?,
                s.get("description").and_then(|d| d.as_str()).unwrap_or(""),
            ))
        })
        .collect();
    if enabled.is_empty() {
        return String::new();
    }
    let available: Vec<(String, String)> = read_manifest()
        .into_iter()
        .filter(|e| e.enabled && skill_dir(&e.name).join("SKILL.md").is_file())
        .filter_map(|e| {
            let desc = enabled.get(e.id.as_str())?;
            let desc = desc.split_whitespace().collect::<Vec<_>>().join(" ");
            Some((e.name, desc))
        })
        .collect();
    if available.is_empty() {
        return String::new();
    }
    let entries = available
        .iter()
        .map(|(name, desc)| format!("- {name}: {desc} (file: r0/{name}/SKILL.md)"))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "<skills_instructions>\n## Skills\nA skill is a set of instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills available this session. Each entry has a name, a description, and a short path that expands into an absolute path using the skill root below.\n### Skill root\n- `r0` = `{}`\n### Available skills\n{entries}\n### How to use skills\n- Trigger: if the user names a skill, or the task clearly matches a skill's description above, use that skill for that turn. If several apply, pick the minimal set that covers the request.\n- Progressive disclosure: after deciding to use a skill, expand its `r0` short path into an absolute path and read the whole `SKILL.md` (read_file tool) before taking task actions. Do not act on a skill you have not read.\n- Relative paths inside a `SKILL.md` (e.g. `scripts/foo.py`, `references/`, `assets/`) resolve against that skill's own directory. Prefer running or reusing a skill's scripts/assets over rewriting them.\n- Context hygiene: only read the skill files relevant to the current task; don't load unrelated references.\n- Fallback: if a skill can't be applied cleanly (missing files, unclear instructions), say so briefly and continue with the best alternative.\n</skills_instructions>",
        skills_root().display()
    )
}
