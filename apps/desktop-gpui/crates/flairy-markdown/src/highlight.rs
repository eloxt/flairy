//! Syntax highlighting for fenced code blocks.
//!
//! Runs on the background parse thread, never per frame. Each block is
//! highlighted in BOTH the light and dark theme so a runtime appearance
//! switch never shows stale colors — the renderer just picks a side.
//! Results are cached process-wide by (lang, content hash): during
//! streaming only the growing tail block re-highlights, and static
//! history hits the cache on every reparse.

use gpui::Hsla;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::ops::Range;
use std::sync::{Arc, Mutex, OnceLock};
use syntect::easy::HighlightLines;
use syntect::highlighting::Theme;
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;
use two_face::theme::EmbeddedThemeName;

/// Foreground colors for one highlighted span, in both appearances.
#[derive(Clone, Copy, Debug)]
pub struct CodeSpan {
    pub light: Hsla,
    pub dark: Hsla,
}

/// Spans with ranges relative to the start of the code text.
pub type SpanList = Arc<[(Range<usize>, CodeSpan)]>;

fn syntaxes() -> &'static SyntaxSet {
    static SET: OnceLock<SyntaxSet> = OnceLock::new();
    SET.get_or_init(two_face::syntax::extra_newlines)
}

fn themes() -> &'static (Theme, Theme) {
    static THEMES: OnceLock<(Theme, Theme)> = OnceLock::new();
    THEMES.get_or_init(|| {
        let set = two_face::theme::extra();
        (
            set.get(EmbeddedThemeName::OneHalfLight).clone(),
            set.get(EmbeddedThemeName::OneHalfDark).clone(),
        )
    })
}

fn cache() -> &'static Mutex<HashMap<(String, u64), SpanList>> {
    static CACHE: OnceLock<Mutex<HashMap<(String, u64), SpanList>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

const CACHE_CAP: usize = 512;

pub fn highlight(lang: &str, code: &str) -> SpanList {
    if lang.is_empty() || code.is_empty() {
        return Arc::from([]);
    }
    let key = (lang.to_ascii_lowercase(), {
        let mut hasher = DefaultHasher::new();
        code.hash(&mut hasher);
        hasher.finish()
    });
    if let Some(hit) = cache().lock().unwrap().get(&key) {
        return hit.clone();
    }

    let set = syntaxes();
    let Some(syntax) = set.find_syntax_by_token(&key.0) else {
        return Arc::from([]);
    };
    let (light_theme, dark_theme) = themes();
    let mut light = HighlightLines::new(syntax, light_theme);
    let mut dark = HighlightLines::new(syntax, dark_theme);

    let mut spans: Vec<(Range<usize>, CodeSpan)> = Vec::new();
    let mut offset = 0usize;
    for line in LinesWithEndings::from(code) {
        let (Ok(regions_l), Ok(regions_d)) =
            (light.highlight_line(line, set), dark.highlight_line(line, set))
        else {
            offset += line.len();
            continue;
        };
        zip_regions(&regions_l, &regions_d, offset, &mut spans);
        offset += line.len();
    }

    let spans: SpanList = spans.into();
    let mut cache = cache().lock().unwrap();
    if cache.len() >= CACHE_CAP {
        cache.clear();
    }
    cache.insert(key, spans.clone());
    spans
}

/// The two themes can merge adjacent tokens differently; intersect both
/// region lists so every emitted span has a single color per appearance.
fn zip_regions(
    light: &[(syntect::highlighting::Style, &str)],
    dark: &[(syntect::highlighting::Style, &str)],
    line_offset: usize,
    out: &mut Vec<(Range<usize>, CodeSpan)>,
) {
    let mut li = 0;
    let mut di = 0;
    let mut l_end = light.first().map_or(0, |(_, s)| s.len());
    let mut d_end = dark.first().map_or(0, |(_, s)| s.len());
    let mut cursor = 0usize;
    while li < light.len() && di < dark.len() {
        let end = l_end.min(d_end);
        if end > cursor {
            let span = CodeSpan {
                light: to_hsla(light[li].0.foreground),
                dark: to_hsla(dark[di].0.foreground),
            };
            // Merge with the previous span when colors are identical to keep
            // the list (and the resulting TextRuns) short.
            match out.last_mut() {
                Some((range, last))
                    if range.end == line_offset + cursor
                        && eq(last.light, span.light)
                        && eq(last.dark, span.dark) =>
                {
                    range.end = line_offset + end;
                }
                _ => out.push((line_offset + cursor..line_offset + end, span)),
            }
            cursor = end;
        }
        if l_end == end {
            li += 1;
            l_end += light.get(li).map_or(1, |(_, s)| s.len());
        }
        if d_end == end {
            di += 1;
            d_end += dark.get(di).map_or(1, |(_, s)| s.len());
        }
    }
}

fn eq(a: Hsla, b: Hsla) -> bool {
    a.h == b.h && a.s == b.s && a.l == b.l && a.a == b.a
}

fn to_hsla(color: syntect::highlighting::Color) -> Hsla {
    gpui::Rgba {
        r: f32::from(color.r) / 255.,
        g: f32::from(color.g) / 255.,
        b: f32::from(color.b) / 255.,
        a: f32::from(color.a) / 255.,
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_code_produces_spans() {
        let spans = highlight("rust", "fn main() { let x = \"hi\"; }\n");
        assert!(!spans.is_empty());
        // Ranges are sorted, non-overlapping, within bounds.
        let mut last = 0;
        for (r, _) in spans.iter() {
            assert!(r.start >= last);
            assert!(r.end <= 28);
            last = r.end;
        }
    }

    #[test]
    fn unknown_lang_is_empty() {
        assert!(highlight("nope-not-a-lang", "x\n").is_empty());
    }

    #[test]
    fn cache_hit_is_identical() {
        let a = highlight("rust", "let a = 1;\n");
        let b = highlight("rust", "let a = 1;\n");
        assert!(Arc::ptr_eq(&a, &b));
    }

    #[test]
    fn typescript_supported_via_two_face() {
        // syntect's builtin set lacks TS; two-face provides it.
        let spans = highlight("typescript", "const x: number = 1;\n");
        assert!(!spans.is_empty());
    }
}
