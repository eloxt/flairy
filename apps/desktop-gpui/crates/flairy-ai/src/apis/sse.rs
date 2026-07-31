use anyhow::Result;
use futures_util::StreamExt;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Reads an SSE response, invoking `on_data` with each `data:` payload.
/// Returns early (Ok) when `cancel` flips true.
pub async fn read_sse(
    response: reqwest::Response,
    cancel: &Arc<AtomicBool>,
    mut on_data: impl FnMut(&str) -> Result<()>,
) -> Result<bool> {
    let mut stream = response.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Ok(true); // cancelled
        }
        buf.push_str(&String::from_utf8_lossy(&chunk?));

        // SSE events are separated by a blank line.
        while let Some(pos) = find_event_boundary(&buf) {
            let (event, rest) = buf.split_at(pos.0);
            let event = event.to_string();
            buf = rest[pos.1..].to_string();
            for line in event.lines() {
                if let Some(data) = line.strip_prefix("data:") {
                    on_data(data.trim_start())?;
                }
            }
        }
    }
    Ok(false)
}

fn find_event_boundary(buf: &str) -> Option<(usize, usize)> {
    let a = buf.find("\n\n").map(|i| (i, 2));
    let b = buf.find("\r\n\r\n").map(|i| (i, 4));
    match (a, b) {
        (Some(x), Some(y)) => Some(if x.0 < y.0 { x } else { y }),
        (x, y) => x.or(y),
    }
}
