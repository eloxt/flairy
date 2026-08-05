//! Built-in web_search / web_fetch tools backed by Exa, ported from the
//! Electron client (main/agent/tools/web-search.ts, web-fetch.ts).
//!
//! Both return the same sentinel JSON text format as the Electron client so
//! citation ids and Sources rendering stay compatible across devices:
//! - web_search → one JSON object tagged `"type":"flairy_web_search"`
//! - web_fetch  → a JSON header line tagged `"type":"flairy_web_fetch"`,
//!   blank line, then the page content as markdown-ish text.
//!
//! Citation ids are unique across one agent run: both tools share a counter
//! (`TurnIds`) created per run, so a second search continues numbering.

use flairy_agent::{Tool, ToolOutput};
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use crate::server_client::ExaConfig;

/// Per-run allocator for the shared citation id namespace.
#[derive(Default)]
pub struct TurnIds {
    next: AtomicU32,
}

impl TurnIds {
    /// Reserve `count` consecutive ids; returns the 0-based start of the block.
    fn allocate(&self, count: u32) -> u32 {
        self.next.fetch_add(count, Ordering::Relaxed)
    }
}

const SEARCH_MARKER: &str = "flairy_web_search";
const FETCH_MARKER: &str = "flairy_web_fetch";
const FETCH_MAX_CHARACTERS: usize = 40_000;

fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .unwrap_or_default()
}

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Best short snippet: prefer Exa highlights, fall back to text.
fn snippet_of(r: &Value) -> String {
    let from_highlights = r
        .get("highlights")
        .and_then(|h| h.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|h| h.as_str())
                .collect::<Vec<_>>()
                .join(" … ")
        })
        .map(|s| collapse_ws(&s))
        .unwrap_or_default();
    if !from_highlights.is_empty() {
        return from_highlights;
    }
    let text = collapse_ws(r.get("text").and_then(|t| t.as_str()).unwrap_or_default());
    if text.chars().count() > 280 {
        let clipped: String = text.chars().take(280).collect();
        format!("{clipped}…")
    } else {
        text
    }
}

/// Publication date reduced to YYYY-MM-DD (freshness signal at minimal cost).
fn date_of(r: &Value) -> Option<String> {
    let date = r.get("publishedDate")?.as_str()?.trim();
    (!date.is_empty()).then(|| date.chars().take(10).collect())
}

/// The page's own preview image (og:image, else the first in-page image link).
fn image_of(r: &Value) -> Option<String> {
    let mut candidates: Vec<&str> = Vec::new();
    if let Some(img) = r.get("image").and_then(|i| i.as_str()) {
        candidates.push(img);
    }
    if let Some(links) = r
        .get("extras")
        .and_then(|e| e.get("imageLinks"))
        .and_then(|l| l.as_array())
    {
        candidates.extend(links.iter().filter_map(|l| l.as_str()));
    }
    candidates
        .into_iter()
        .map(str::trim)
        .find(|u| u.starts_with("http://") || u.starts_with("https://"))
        .map(str::to_string)
}

/// `days` ago at UTC midnight, as an ISO-8601 timestamp (no chrono dependency:
/// Howard Hinnant's civil-from-days algorithm).
fn start_published_date(days_back: u64) -> String {
    let now_days = (std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
        / 86_400) as i64;
    let z = now_days - days_back.min(3_650) as i64 + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T00:00:00.000Z")
}

pub struct WebSearchTool {
    pub exa: ExaConfig,
    pub ids: Arc<TurnIds>,
}

impl Tool for WebSearchTool {
    fn name(&self) -> &str {
        "web_search"
    }
    fn label(&self) -> &str {
        "搜索网页"
    }
    fn description(&self) -> &str {
        r#"Search the web for any topic and get clean, ready-to-use content. Each result carries a numeric "id"; ids are unique across ALL searches in the current turn (a later search continues counting, e.g. its results may be 11, 12, …).
When citing information from search results in your response, cite the EXACT "id" field of the result as an inline citation like [11], or [11,12] for multiple sources. Never renumber results from 1 yourself.
This helps users identify the source of information.

Best for: Finding current information, news, facts, people, companies, or answering questions about any topic.
Returns: Clean text content from top search results.

Query tips:
describe the ideal page, not keywords. "blog post comparing React and Vue performance" not "React vs Vue".
Use the "category" parameter to focus on a content type (news, research paper, github, people…), and "daysBack" for time-sensitive queries where only recent pages are useful.
Each result may carry a "date" (publication date) — weigh it when the topic moves fast, and prefer newer sources for claims about the current state of things.
If highlights are insufficient, follow up with web_fetch on the best URLs."#
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "minLength": 1,
                    "description": "Natural language search query. Should be a semantically rich description of the ideal page, not just keywords."
                },
                "numResults": {
                    "type": "number",
                    "description": "Number of search results to return (default: 10)."
                },
                "category": {
                    "type": "string",
                    "enum": ["company", "research paper", "news", "pdf", "github", "tweet", "personal site", "linkedin profile", "financial report"],
                    "description": "Focus the search on one content type — e.g. \"news\" for current events, \"research paper\" for academic sources. Omit for general search."
                },
                "daysBack": {
                    "type": "number",
                    "description": "Only return pages published within the last N days. Use for time-sensitive queries where stale results would mislead."
                }
            },
            "required": ["query"],
            "additionalProperties": false
        })
    }
    fn execute(&self, input: Value) -> anyhow::Result<ToolOutput> {
        let query = input
            .get("query")
            .and_then(|q| q.as_str())
            .map(str::trim)
            .unwrap_or_default();
        if query.is_empty() {
            anyhow::bail!("web_search requires a non-empty \"query\"");
        }
        let count = input
            .get("numResults")
            .and_then(|n| n.as_u64())
            .filter(|n| *n > 0)
            .map(|n| n.min(25) as u32)
            .unwrap_or(self.exa.num_results);

        let mut body = json!({
            "query": query,
            "numResults": count,
            "type": "auto",
            "contents": {
                "text": {"maxCharacters": 800},
                "highlights": true,
                "extras": {"imageLinks": 1}
            }
        });
        if let Some(category) = input.get("category").and_then(|c| c.as_str()) {
            if !category.is_empty() {
                body["category"] = json!(category);
            }
        }
        if let Some(days) = input.get("daysBack").and_then(|d| d.as_u64()).filter(|d| *d > 0) {
            body["startPublishedDate"] = json!(start_published_date(days));
        }

        let res = http()
            .post(format!("{}/search", self.exa.base_url))
            .header("x-api-key", &self.exa.api_key)
            .json(&body)
            .send()
            .map_err(|e| anyhow::anyhow!("Web search request failed: {e}"))?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().unwrap_or_default();
            anyhow::bail!(
                "Web search failed ({status}): {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let data: Value = res.json()?;
        let found: Vec<&Value> = data
            .get("results")
            .and_then(|r| r.as_array())
            .map(|list| {
                list.iter()
                    .filter(|r| r.get("url").and_then(|u| u.as_str()).is_some())
                    .collect()
            })
            .unwrap_or_default();

        if found.is_empty() {
            return Ok(ToolOutput {
                content: format!("No web results found for \"{query}\"."),
                details: json!({"count": 0}),
            });
        }

        let id_start = self.ids.allocate(found.len() as u32);
        let results: Vec<Value> = found
            .iter()
            .enumerate()
            .map(|(idx, r)| {
                let url = r.get("url").and_then(|u| u.as_str()).unwrap_or_default();
                let title = r
                    .get("title")
                    .and_then(|t| t.as_str())
                    .map(collapse_ws)
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| url.to_string());
                let mut entry = json!({
                    "id": id_start + idx as u32 + 1,
                    "title": title,
                    "url": url,
                    "snippet": snippet_of(r),
                });
                if let Some(image) = image_of(r) {
                    entry["image"] = json!(image);
                }
                if let Some(date) = date_of(r) {
                    entry["date"] = json!(date);
                }
                entry
            })
            .collect();

        let payload = json!({
            "type": SEARCH_MARKER,
            "instructions": "Cite results you use inline by their exact \"id\" field, e.g. [1] or [1,2] for several. Ids are unique across all searches this turn — a later search continues counting, so never renumber from 1.",
            "results": results,
        });
        Ok(ToolOutput {
            content: payload.to_string(),
            details: json!({"count": results.len(), "query": query}),
        })
    }
}

pub struct WebFetchTool {
    pub exa: ExaConfig,
    pub ids: Arc<TurnIds>,
}

impl Tool for WebFetchTool {
    fn name(&self) -> &str {
        "web_fetch"
    }
    fn label(&self) -> &str {
        "读取网页"
    }
    fn description(&self) -> &str {
        "Fetch the full, clean text content of one web page by URL. Use after web_search when a result's highlights are not enough, or when the user gives you a URL directly. The page becomes a citable source: cite it inline by the \"id\" in the JSON header line of the result."
    }
    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Absolute http(s) URL of the page to fetch."}
            },
            "required": ["url"],
            "additionalProperties": false
        })
    }
    fn execute(&self, input: Value) -> anyhow::Result<ToolOutput> {
        let url = input
            .get("url")
            .and_then(|u| u.as_str())
            .map(str::trim)
            .unwrap_or_default();
        if url.is_empty() {
            anyhow::bail!("web_fetch requires a non-empty \"url\"");
        }
        if !url.starts_with("http://") && !url.starts_with("https://") {
            anyhow::bail!("web_fetch only supports http(s) URLs, got \"{url}\"");
        }

        let res = http()
            .post(format!("{}/contents", self.exa.base_url))
            .header("x-api-key", &self.exa.api_key)
            .json(&json!({
                "urls": [url],
                "text": {"maxCharacters": FETCH_MAX_CHARACTERS},
            }))
            .send()
            .map_err(|e| anyhow::anyhow!("Web fetch request failed: {e}"))?;
        if !res.status().is_success() {
            let status = res.status();
            let body = res.text().unwrap_or_default();
            anyhow::bail!(
                "Web fetch failed ({status}): {}",
                body.chars().take(200).collect::<String>()
            );
        }
        let data: Value = res.json()?;
        let result = data
            .get("results")
            .and_then(|r| r.as_array())
            .and_then(|list| list.first())
            .cloned()
            .unwrap_or(Value::Null);
        let text = result
            .get("text")
            .and_then(|t| t.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();
        if text.is_empty() {
            return Ok(ToolOutput {
                content: format!("No readable content found for {url}."),
                details: json!({"url": url, "ok": false}),
            });
        }
        let title = result
            .get("title")
            .and_then(|t| t.as_str())
            .map(collapse_ws)
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| url.to_string());
        let snippet: String = collapse_ws(&text).chars().take(200).collect();

        let mut source = json!({
            "id": self.ids.allocate(1) + 1,
            "title": title,
            "url": url,
            "snippet": snippet,
        });
        if let Some(date) = date_of(&result) {
            source["date"] = json!(date);
        }
        if let Some(image) = result
            .get("image")
            .and_then(|i| i.as_str())
            .map(str::trim)
            .filter(|i| i.starts_with("http://") || i.starts_with("https://"))
        {
            source["image"] = json!(image);
        }
        let source_id = source["id"].clone();
        let header = json!({
            "type": FETCH_MARKER,
            "instructions": format!("Cite information you use from this page inline as [{source_id}]."),
            "source": source,
        });
        let chars = text.chars().count();
        Ok(ToolOutput {
            content: format!("{header}\n\n# {title}\n{url}\n\n{text}"),
            details: json!({"url": url, "chars": chars}),
        })
    }
}

/// Parse a tool-result text into sources (citation id, title, url), or None
/// if it isn't web_search/web_fetch output. Cheap substring guard first.
pub fn parse_sources(text: &str) -> Option<Vec<(u64, String, String)>> {
    let trimmed = text.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    let head: String = trimmed.chars().take(200).collect();
    let extract = |source: &Value| -> Option<(u64, String, String)> {
        let url = source.get("url")?.as_str()?.to_string();
        let id = source.get("id").and_then(|i| i.as_u64()).unwrap_or(0);
        let title = source
            .get("title")
            .and_then(|t| t.as_str())
            .unwrap_or(&url)
            .to_string();
        Some((id, title, url))
    };
    if head.contains(SEARCH_MARKER) {
        let obj: Value = serde_json::from_str(trimmed).ok()?;
        if obj.get("type").and_then(|t| t.as_str()) != Some(SEARCH_MARKER) {
            return None;
        }
        let results = obj.get("results")?.as_array()?;
        Some(results.iter().filter_map(extract).collect())
    } else if head.contains(FETCH_MARKER) {
        let header_line = trimmed.lines().next()?;
        let obj: Value = serde_json::from_str(header_line).ok()?;
        if obj.get("type").and_then(|t| t.as_str()) != Some(FETCH_MARKER) {
            return None;
        }
        Some(vec![extract(obj.get("source")?)?])
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_date_math_is_sane() {
        // 2026-08-01 minus 0 days stays in 2026 with a valid shape.
        let s = start_published_date(0);
        assert_eq!(s.len(), "2026-08-01T00:00:00.000Z".len());
        assert!(s.ends_with("T00:00:00.000Z"));
        // Known fixed point: unix day 0 → 1970-01-01. Recompute via the same
        // algorithm shifted by "days since epoch" to avoid clock dependence.
        let today = start_published_date(0);
        let long_ago = start_published_date(3_650);
        assert!(long_ago < today, "10y back sorts before today: {long_ago} vs {today}");
    }

    #[test]
    fn parses_search_sources() {
        let text = r#"{"type":"flairy_web_search","instructions":"x","results":[{"id":3,"title":"Rust","url":"https://www.rust-lang.org/","snippet":"s"}]}"#;
        let sources = parse_sources(text).unwrap();
        assert_eq!(
            sources,
            vec![(3, "Rust".to_string(), "https://www.rust-lang.org/".to_string())]
        );

        let fetch = "{\"type\":\"flairy_web_fetch\",\"instructions\":\"x\",\"source\":{\"id\":7,\"title\":\"Page\",\"url\":\"https://e.com\"}}\n\n# Page\nbody";
        let sources = parse_sources(fetch).unwrap();
        assert_eq!(sources[0].0, 7);
        assert_eq!(sources[0].1, "Page");
        assert!(parse_sources("plain text").is_none());
    }
}
