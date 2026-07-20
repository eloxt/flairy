/**
 * The single entry point from fence body → typed card data. The renderer calls
 * this for every ui:* code fence; when it returns null the renderer's contract
 * is: show a skeleton while still streaming, silently drop the whole block once
 * closed (zero technical exposure for end users — never dump raw JSON on them).
 */

import { parsePartialJson } from "./partial-json";
import { CARD_DEFS, MAX_FIELD_LEN, type CardBlock, type CardLanguage } from "./schema";

function isCardLanguage(language: string): language is CardLanguage {
  return language in CARD_DEFS;
}

// ---------------------------------------------------------------------------
// Deep truncation: cap every string at MAX_FIELD_LEN and every array at
// MAX_ITEMS so oversized input can neither blow up validation nor break the
// UI. Returns a new object; the input is not mutated.
// ---------------------------------------------------------------------------

const MAX_ITEMS = 50;
const MAX_DEPTH = 6;

export function deepTruncate(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_FIELD_LEN ? value.slice(0, MAX_FIELD_LEN) : value;
  }
  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((v) => deepTruncate(v, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = deepTruncate(v, depth + 1);
  }
  return out;
}

export interface ParseCardOptions {
  /** Whether the fence is still streaming in (not yet closed). */
  incomplete?: boolean;
}

export function parseCardBlock(
  language: string,
  code: string,
  opts: ParseCardOptions = {},
): CardBlock | null {
  if (!isCardLanguage(language)) return null;
  const def = CARD_DEFS[language];
  const incomplete = opts.incomplete === true;

  // Atomic cards (note/suggestions): half an alert is worse than a late one,
  // and a button can't be wired until its text is complete — never render
  // before the fence closes.
  if (incomplete && !("streaming" in def)) return null;

  let raw: unknown;
  // Whether the value was recovered from a truncated prefix rather than parsed
  // whole — either mid-stream, or from a closed fence whose JSON is cut short
  // (a message persisted after an interrupted generation, or streamdown
  // auto-closing an open fence and passing it as "complete"). A recovered
  // tail element is likely half-formed, so such data also goes through the
  // valid-prefix filter below instead of failing full validation outright.
  let salvaged = incomplete;
  if (incomplete) {
    raw = parsePartialJson(code);
  } else {
    try {
      raw = JSON.parse(code) as unknown;
    } catch {
      raw = parsePartialJson(code);
      salvaged = true;
    }
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;

  let data = deepTruncate(raw) as Record<string, unknown>;

  // Salvaged data: filter the row array down to its valid prefix — run each
  // element through the item schema and stop at the first invalid one (usually
  // the half-streamed tail), so completed rows render right away.
  if (salvaged && "streaming" in def) {
    const { key, item } = def.streaming;
    const arr = data[key];
    if (Array.isArray(arr)) {
      const valid: unknown[] = [];
      for (const el of arr) {
        if (!item.safeParse(el).success) break;
        valid.push(el);
      }
      data = { ...data, [key]: valid };
    }
  }

  const parsed = def.schema.safeParse(data);
  if (!parsed.success) return null;

  return { type: language, data: parsed.data } as CardBlock;
}
