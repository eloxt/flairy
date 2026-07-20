/**
 * Lenient JSON parsing — for JSON text that is still streaming in and may be
 * cut off anywhere in its tail.
 *
 * Strategy: parse as-is first; on failure, complete the text (close unfinished
 * strings/brackets, clean dangling `,` / `:`) and retry; if that still fails,
 * cut back to the previous structural boundary (the last `,` `{` `[` `:` not
 * inside a string) and retry, for a bounded number of rounds. The model emits
 * multi-line indented JSON, so almost every cut point lands near an element
 * boundary and this converges within a round or two.
 *
 * Returns null when no valid value can be recovered from the current prefix
 * (the caller renders a skeleton / skips).
 */

export function parsePartialJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // fall through to completion attempts
  }

  let s = trimmed;
  for (let attempt = 0; attempt < 12 && s.length > 0; attempt++) {
    const completed = completeJson(s);
    // Mismatched brackets mean "malformed", not "truncated" — a real streaming
    // prefix never produces a mismatch. Give up entirely.
    if (completed === null) return null;
    try {
      return JSON.parse(completed) as unknown;
    } catch {
      // try cutting back further
    }
    const cut = lastStructuralBoundary(s);
    if (cut <= 0) return null;
    s = s.slice(0, cut).trimEnd();
  }
  return null;
}

/**
 * Complete a truncated JSON prefix into parseable text: close open strings,
 * drop a dangling backslash / comma, give a dangling `key:` a null value, and
 * close brackets in stack order. Returns null when brackets are mismatched
 * (malformed rather than truncated).
 */
function completeJson(s: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escape = false;

  for (const ch of s) {
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return null;
    }
  }

  let out = s;
  if (escape) out = out.slice(0, -1);
  if (inString) out += '"';
  out = out.replace(/,\s*$/, "");
  out = out.replace(/:\s*$/, ": null");
  while (stack.length > 0) out += stack.pop();
  return out;
}

/**
 * The last structural boundary not inside a string, returned as a slice end:
 * a `,` cuts before the comma; `{` `[` `:` cut after the symbol (completeJson
 * fills in the placeholder).
 */
function lastStructuralBoundary(s: string): number {
  let inString = false;
  let escape = false;
  let boundary = -1;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === ",") boundary = i;
    else if (ch === "{" || ch === "[" || ch === ":") boundary = i + 1;
  }
  // A boundary at the very end means no progress; cutting inside a string
  // would corrupt its content, so give up instead.
  return boundary >= s.length ? -1 : boundary;
}
