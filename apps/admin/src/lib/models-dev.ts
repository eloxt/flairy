import type { Modality, ModelCost, ModelMetadata } from "@flairy/shared";

/**
 * Parse a JSON blob copied from models.dev (https://models.dev) into the
 * pieces of the model form it can prefill. Accepts a single model entry of
 * their `api.json` — either the bare model object or the same object still
 * wrapped in its provider / `models` map — and rejects blobs that contain
 * more than one model (the form edits exactly one).
 */

/** The subset of a models.dev model entry we consume (all snake_case). */
interface ModelsDevModel {
  id: string;
  name?: string;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  knowledge?: string;
  release_date?: string;
  last_updated?: string;
  open_weights?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
  };
  limit?: { context?: number; output?: number };
}

/** What the form can be prefilled with. Optional pieces were absent in the JSON. */
export interface ParsedModelsDevModel {
  /** Provider model id (models.dev `id`). */
  model: string;
  /** Human display name (models.dev `name`); falls back to the id. */
  name: string;
  /** Input modalities narrowed to the ones we support (always contains "text"). */
  input: Modality[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: ModelCost;
  /** Descriptive facts forwarded to clients for the model picker card. */
  metadata: ModelMetadata;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Does this object look like one models.dev model entry? */
function isModelEntry(v: Record<string, unknown>): v is ModelsDevModel & Record<string, unknown> {
  if (typeof v.id !== "string" || !v.id) return false;
  // Distinguish a model from a provider (providers also carry `id`/`name`
  // but never these model-only keys — and they carry a `models` map).
  if (isRecord(v.models)) return false;
  return (
    isRecord(v.cost) ||
    isRecord(v.limit) ||
    isRecord(v.modalities) ||
    typeof v.reasoning === "boolean" ||
    typeof v.tool_call === "boolean" ||
    typeof v.attachment === "boolean"
  );
}

/**
 * Find the single model entry inside the pasted JSON, unwrapping the
 * provider / `models` layers of api.json. Throws a user-facing message when
 * nothing (or more than one model) is found.
 */
function extractModelEntry(root: unknown): ModelsDevModel {
  const found: ModelsDevModel[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (found.length > 1 || depth > 4 || !isRecord(node)) return;
    if (isModelEntry(node)) {
      found.push(node);
      return;
    }
    // Unwrap `{ models: { ... } }` and provider-keyed wrappers alike: descend
    // into object values only.
    for (const value of Object.values(node)) {
      if (isRecord(value)) visit(value, depth + 1);
      if (found.length > 1) return;
    }
  };
  visit(root, 0);

  if (found.length === 0) {
    throw new Error(
      "No model found in this JSON. Paste a single model entry from models.dev.",
    );
  }
  const single = found.length === 1 ? found[0] : undefined;
  if (!single) {
    throw new Error(
      "This JSON contains more than one model. Paste a single model entry.",
    );
  }
  return single;
}

/** Positive finite number or undefined. */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Parse the pasted text. Throws `Error` with a user-facing message on failure. */
export function parseModelsDevJson(text: string): ParsedModelsDevModel {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new Error("Not valid JSON. Copy the model's JSON from models.dev and paste it as-is.");
  }
  const entry = extractModelEntry(root);

  // models.dev lists modalities like ["text","image","audio","video","pdf"];
  // keep the ones the client supports. Text is always sendable.
  const rawInput = Array.isArray(entry.modalities?.input) ? entry.modalities.input : [];
  const input: Modality[] = rawInput.includes("image") ? ["text", "image"] : ["text"];

  const costIn = num(entry.cost?.input);
  const costOut = num(entry.cost?.output);
  const cacheRead = num(entry.cost?.cache_read);
  const cacheWrite = num(entry.cost?.cache_write);
  const cost =
    costIn !== undefined || costOut !== undefined || cacheRead !== undefined || cacheWrite !== undefined
      ? {
          input: costIn ?? 0,
          output: costOut ?? 0,
          cacheRead: cacheRead ?? 0,
          cacheWrite: cacheWrite ?? 0,
        }
      : undefined;

  const metadata: ModelMetadata = {
    ...(entry.knowledge ? { knowledge: entry.knowledge } : {}),
    ...(entry.release_date ? { releaseDate: entry.release_date } : {}),
    ...(entry.last_updated ? { lastUpdated: entry.last_updated } : {}),
    ...(typeof entry.reasoning === "boolean" ? { reasoning: entry.reasoning } : {}),
    ...(typeof entry.tool_call === "boolean" ? { toolCall: entry.tool_call } : {}),
    ...(typeof entry.attachment === "boolean" ? { attachment: entry.attachment } : {}),
    ...(typeof entry.temperature === "boolean" ? { temperature: entry.temperature } : {}),
    ...(typeof entry.open_weights === "boolean" ? { openWeights: entry.open_weights } : {}),
  };

  return {
    model: entry.id,
    name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
    input,
    contextWindow: num(entry.limit?.context),
    maxTokens: num(entry.limit?.output),
    cost,
    metadata,
  };
}
