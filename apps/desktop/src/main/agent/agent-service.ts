import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
// pi 0.81 split the provider catalog out of the main entry: the global
// api-dispatch `streamSimple` now lives behind the `/compat` subpath. We build
// every Model from server config, so the catalog itself is not needed — only
// the dispatcher that turns a Model's `api` into a request.
import { streamSimple } from "@earendil-works/pi-ai/compat";
import {
  CHAT_PROMPT_NAME,
  IMAGE_DESCRIPTION_PROMPT_NAME,
  MAIN_PROMPT_NAME,
  TITLE_GENERATION_PROMPT_NAME,
  COMPRESSION_PROMPT_NAME,
  TOOL_SELECTION_PROMPT_NAME,
  type ActiveLlm,
  type ConfigSnapshot,
  type Memory,
} from "@flairy/shared";
import {
  encodeImageDescriptions,
  stripImageDescriptions,
} from "@shared/image-description";
import { buildCardsPrompt, CHAT_CARD_SET, MAIN_CARD_SET } from "@shared/cards/prompt";
import { platform } from "node:os";
import { app } from "electron";
import {
  IPC,
  type AgentStreamEvent,
  type Attachment,
  type PermissionMode,
} from "@shared/ipc";
import { createTools, isReadOnlyTool } from "./tools";
import { createAskTool } from "./tools/ask";
import { createMemoryTool } from "./tools/memory";
import { createTodoTool } from "./tools/todo";
import { createScheduleTool } from "./tools/schedule";
import { createSearchToolTool } from "./tools/search-tool";
import { expandPath } from "./tools/paths";
import { createWebSearchTool, resolveExaService } from "./tools/web-search";
import { createWebFetchTool } from "./tools/web-fetch";
import { createGithubTools } from "../github/tools";
import { createDispatchTaskTool } from "./tools/dispatch-task";
import { createDispatchReviewTool } from "./tools/dispatch-review";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { McpManager } from "./mcp";
import { questions } from "./questions";
import { desktopChannel, type InteractionChannel } from "./interaction";
import { listMaterializedSkills, skillsRoot } from "./skill-materializer";
import {
  saveMessages,
  getSession,
  updateSessionTitle,
  upsertMemory,
  listActiveMemoriesForPrompt,
  loadCompression,
  saveCompression,
  loadToolSelection,
  saveToolSelection,
} from "../store/db";
import { putImage, rehydrateImages } from "../store/image-store";
import { toSyncMessage, projectText } from "../sync/session-payload";
import { getMainWindow, broadcast } from "../windows";
import { getLanguage } from "../locale";
import type { ServerClient } from "../sync/server-client";
import {
  DESKTOP_ORIGIN,
  type TurnOrigin,
  type AgentEventInternalEnvelope,
} from "./turn-origin";

/**
 * Built-in instruction for the `visual`-role model when it extracts image
 * descriptions on behalf of a text-only main model. An admin can override it
 * with a system prompt named `image_description`; unlike title generation this
 * has a default, so assigning a visual model alone is enough to make it work.
 */
const BASE_IMAGE_DESCRIPTION_PROMPT =
  "You describe images on behalf of a model that cannot see them. " +
  "For each attached image, describe it thoroughly: transcribe any visible " +
  "text verbatim, and describe layout, UI elements, charts, diagrams, code, " +
  "and anything else relevant. Number the descriptions when there are several " +
  "images. Output plain text only — no preamble, no commentary.";

const CONVERSATION_ID_HEADER = "x-bf-lh-conversation-id";

function withConversationHeader(
  sessionId: string,
  options?: SimpleStreamOptions,
): SimpleStreamOptions {
  return {
    ...options,
    headers: {
      ...options?.headers,
      [CONVERSATION_ID_HEADER]: sessionId,
    },
  };
}

/**
 * Context-compression tunables.
 *   - `KEEP_RECENT`: the most recent N conversational messages are NEVER folded
 *     into the summary, so the active working context stays intact for the next
 *     turn (incl. any in-flight/paired tool results, since compression only runs
 *     while no turn is active).
 *   - `COMPRESS_TRIGGER_RATIO`: auto-compress once the last turn's provider-
 *     reported prompt size reaches this fraction of the main model's context
 *     window. Real usage (not an estimate) — the same number the renderer's
 *     context meter shows, so the trigger and the UI can never disagree.
 */
const KEEP_RECENT = 12;
const COMPRESS_TRIGGER_RATIO = 0.7;

/**
 * Auto-retry tunables for failed model requests (main agent loop).
 *   - `MAX_AUTO_RETRIES`: retries per user turn — resets on each fresh prompt().
 *   - `RETRY_BASE_DELAY_MS`: first backoff; doubles each attempt (1/2/4/8s)
 *     with ±20% jitter so parallel sessions don't re-hit a provider in lockstep.
 */
const MAX_AUTO_RETRIES = 4;

/**
 * Tools automatic tool selection never filters out:
 * - ask: the user-interaction round-trip — filtering it could strand a turn.
 * - read: skills progressive disclosure requires reading r0/<name>/SKILL.md.
 * - todo_write / remember: approval-exempt, tiny schemas, and invoked
 *   spontaneously by the main prompt's standing instructions — filtering them
 *   silently degrades behavior for near-zero token savings.
 * - search_tool: the escape hatch for selection misses — the agent uses it to
 *   enable tools whose need is only discovered mid-turn (e.g. after reading a
 *   SKILL.md). Filtering the recovery mechanism itself would defeat it.
 */
const TOOL_SELECTION_FLOOR = new Set([
  "ask",
  "read",
  "todo_write",
  "remember",
  "search_tool",
]);
/**
 * The default toolset of a `chat` session. Chat exposes the full catalog minus
 * the file/shell tools (see buildAllTools), but nothing beyond this floor is
 * enabled by default — `search_tool` is the only expansion path (there is no
 * automatic selector call in chat; see maybeSelectTools). Unlike the project
 * floor, `todo_write`/`remember` are NOT here: they exist in the chat catalog
 * but stay off until searched for (`read` is a file tool, absent from chat).
 */
const CHAT_TOOL_FLOOR = new Set([
  "ask",
  "schedule",
  "web_search",
  "web_fetch",
  "search_tool",
]);
/** Hard cap on the tool-selector side call so it can't stall the turn. */
const TOOL_SELECTION_TIMEOUT_MS = 10_000;
/** Trailing conversational messages given to the selector as routing context. */
const SELECTION_CONTEXT_MESSAGES = 6;
/** Per-message clip so a huge paste can't blow up the cheap selector call. */
const SELECTION_CONTEXT_CLIP = 500;
const RETRY_BASE_DELAY_MS = 1000;

/**
 * Permanent failures that a retry can never fix: auth/credential problems,
 * billing, a missing model, an over-long prompt, malformed requests, and user
 * aborts. pi-ai flattens HTTP-level provider errors to a plain `errorMessage`
 * string (no structured status), so those are classified by substring. Anything
 * NOT matched here — 429/5xx/overloaded/timeouts/socket resets/unknown network
 * junk — is treated as transient and retried. Content-level terminal stops are
 * classified structurally via `rawStopReason` before this regex is consulted
 * (see {@link isRetryableModelError}).
 */
const NON_RETRYABLE_ERROR =
  /\b40[0134]\b|invalid[ _]*(api[ _]*)?key|api key|unauthorized|authentication|permission|forbidden|billing|credit|payment|model not found|does not exist|not_found_error|invalid_request_error|context (length|window)|too many tokens|prompt is too long|maximum context|abort/i;

/** The failure signals retry classification reads off an errored message. */
interface ModelFailure {
  errorMessage?: string;
  rawStopReason?: string;
}

/** Whether an errored model request is worth retrying (transient by default). */
function isRetryableModelError({ errorMessage, rawStopReason }: ModelFailure): boolean {
  // A raw provider stop reason on a FAILED message (pi-ai 0.83+) means the
  // provider returned a well-formed terminal response — a refusal, a safety
  // filter, or a stop reason pi can't map (surfaced as errors instead of fake
  // successful stops). The request itself succeeded, so re-sending the same
  // prompt would just terminate the same way: never retry these. HTTP/network
  // failures never carry a raw stop reason and fall through to the substring
  // classification below.
  if (rawStopReason) return false;
  if (!errorMessage) return true;
  return !NON_RETRYABLE_ERROR.test(errorMessage);
}

/** Exponential backoff with ±20% jitter: 1s, 2s, 4s, 8s for attempts 1–4. */
function retryBackoffMs(attempt: number): number {
  const base = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Sleep that a user stop can cut short. Resolves true after the full delay,
 * false immediately when the signal fires (the retry must not happen).
 */
function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One AgentService instance per session. Wraps a pi-agent-core Agent, forwards
 * its event stream to the renderer over IPC, gates dangerous tools behind the
 * approval registry, persists messages to SQLite, and mirrors them to the
 * server for multi-device sync.
 *
 * The model, credential, system prompt and tools all come from the server-pushed
 * ConfigSnapshot (ServerClient) — there is no local API-key path anymore.
 */
export class AgentService {
  private agent: Agent;
  private sessionId: string;
  private server: ServerClient;
  /** Shared MCP connections; source of the remote tools merged into the agent. */
  private mcp: McpManager;
  /** Current working directory; kept so MCP tool-set changes can rebind tools. */
  private cwd: string;
  /** Unsubscribe handle for the MCP tool-set subscription, called on dispose(). */
  private mcpUnsub?: () => void;
  /** Unsubscribe handle for the server-config subscription, called on dispose(). */
  private configUnsub?: () => void;
  /** True once we've pushed the initial full session; later saves use patch. */
  private upserted = false;
  /**
   * True once automatic title generation has been kicked off for this session.
   * Guards against re-running on later messages (set up-front, even on failure).
   */
  private titleGenerated = false;
  /** Unsubscribe handle for the pi event subscription, called on dispose(). */
  private unsubscribe?: () => void;
  /**
   * Set once the service is being torn down (session deleted). Blocks any
   * late persist() so a post-abort terminal event can't re-insert messages for
   * an already-deleted session.
   */
  private disposed = false;
  /**
   * Tool names the user chose "Allow for this session", PARTITIONED BY ORIGIN
   * KIND. A desktop "Allow for this session" must not silently approve a
   * Telegram-origin tool call on the same shared session (and vice versa) — each
   * front-end's session-scoped approvals are tracked separately (see allowSet).
   * In-memory only and per-session, so it's discarded when the session ends.
   */
  private sessionAllowed = new Map<TurnOrigin["kind"], Set<string>>();
  /**
   * Tool-approval posture. `'full'` ("Full access") bypasses the approval gate
   * entirely. In-memory only and per-session, so it resets to `'ask'` on
   * restart — matching the "never persisted" semantics of session approvals.
   */
  private permissionMode: PermissionMode = "ask";
  /**
   * Whether a turn is currently in flight. Tracked so a session reopened while it
   * runs in the background can report its live running state (see isRunning),
   * driving both the sidebar indicator and the renderer's restored view.
   */
  private running = false;
  /**
   * Running count of web-search results emitted in the current turn, used to give
   * each search a turn-unique citation id block. Reset to 0 at each `agent_start`
   * (a new user-initiated run) so numbering restarts per turn, while a second
   * search WITHIN a turn continues from where the first stopped — keeping every
   * `[n]` the model writes unambiguous when the renderer merges a turn's sources.
   */
  private searchIdOffset = 0;
  /** Same discipline for the separate image-id namespace (`#i<n>` embeds). */
  private searchImageIdOffset = 0;
  /**
   * Compressed summary of the conversation's OLDER messages, applied only in the
   * LLM-bound view (convertToLlm) — `agent.state.messages` stays fully intact for
   * display, persistence, and multi-device sync. Empty until the first
   * compression; hydrated from SQLite on construction.
   */
  private compressedSummary = "";
  /**
   * Count of conversational messages (user/assistant/toolResult, in the filtered
   * order `convertToLlm` sees) already folded into {@link compressedSummary}.
   * `convertToLlm` drops this many leading messages and prepends the summary.
   */
  private compressedUpTo = 0;
  /** True while a compression auxiliary call is in flight (drives the UI shimmer). */
  private compressing = false;
  /**
   * Aborts the in-flight compression stream. abort()/dispose() fire it so a user
   * stop cancels compression too (it's otherwise an unabortable side stream).
   */
  private compressAbort: AbortController | null = null;
  /**
   * Accumulate-only union of every tool name the selector has ever enabled for
   * this session (automatic tool selection). null = no selection yet — feature
   * off, first turn pending, or the selector failed open. Never shrinks within
   * a session: pi-ai places an Anthropic cache breakpoint on the last tool
   * definition, so removing tools turn-over-turn would thrash the prefix cache.
   */
  private selectedToolNames: Set<string> | null = null;
  /** Session kind, read once at construction — see {@link isChatSession}. */
  private readonly chatSession: boolean;
  /**
   * Set when a selector call fails: stop selecting for the rest of the session
   * and run with the full toolset (fail-open, cache-stable). Not persisted — a
   * recreated service re-hydrates the saved union and tries again.
   */
  private toolSelectionBypassed = false;
  /** Aborts the in-flight selector stream (user stop / dispose / timeout). */
  private selectAbort: AbortController | null = null;
  /**
   * Set when search_tool grows the selection union DURING a run. The agent
   * loop snapshots tools once per run, so assigning `agent.state.tools` alone
   * cannot reach the in-flight loop; prepareNextTurnWithContext consumes this
   * flag to hand the loop a refreshed toolset before its next provider request.
   */
  private toolsGrewMidTurn = false;
  /**
   * Retries already made for the CURRENT user turn (reset on each fresh
   * prompt()). The subscribe handler reads it to decide whether an errored run
   * will be retried; the retry loop in {@link runTurnRetries} increments it.
   */
  private retryAttempt = 0;
  /**
   * True from the moment the subscribe handler sees a retryable model error
   * until the retry actually re-runs (or is given up on). While set, the errored
   * run's terminal events (message_end/turn_end/agent_end) are swallowed — the
   * failed message is about to be popped, so persisting it or letting the
   * renderer flip to idle would both be wrong.
   */
  private retryPending = false;
  /** Cuts the backoff sleep short on abort()/dispose() so a stop is immediate. */
  private retryAbort: AbortController | null = null;
  /**
   * Settle every pending interaction (approval + question) for this session.
   * Injected so abort()/dispose() can reach the centralized fan-out in
   * AgentManager without a circular dependency. Defaults to today's behavior
   * (cancel open questions only) when constructed standalone; AgentManager
   * supplies a callback that also rejects approvals (+ the Telegram channel).
   */
  private onRejectInteractions: (sessionId: string) => void;
  /**
   * The origin of the turn currently in flight (set when a fresh prompt starts;
   * defaults to desktop). The event sink, interaction channel, and permission
   * gate all follow this rather than the session — so a session driven by both
   * desktop and Telegram routes each turn to the front-end that authored it.
   */
  private activeTurnOrigin: TurnOrigin = DESKTOP_ORIGIN;
  /**
   * True once any `telegram` origin has contributed to the running turn (started
   * it, or steered it). Disables the desktop `full`-mode bypass for the rest of
   * the turn (most-restrictive-origin-wins) so a Telegram-authored tool call can
   * never ride a desktop "Full access" posture. Reset on `agent_end`.
   */
  private gatedByTelegram = false;
  /**
   * Where this service's (origin-tagged) event envelopes go. Injected so they can
   * flow onto AgentManager's bus (window forwarder + Telegram subscriber);
   * defaults to today's behavior — forward straight to the main window, origin
   * stripped — when constructed standalone.
   */
  private emitEvent: (envelope: AgentEventInternalEnvelope) => void;
  /**
   * Resolve the interaction channel (approval + `ask`) for a turn's origin, at
   * call time. Injected so AgentManager can route telegram turns to the Telegram
   * channel; defaults to the desktop channel when constructed standalone.
   */
  private resolveChannel: (origin: TurnOrigin) => InteractionChannel;
  private onTitleChanged?: (sessionId: string, title: string) => void;

  constructor(opts: {
    sessionId: string;
    cwd: string;
    server: ServerClient;
    mcp: McpManager;
    messages?: unknown[];
    onRejectInteractions?: (sessionId: string) => void;
    emitEvent?: (envelope: AgentEventInternalEnvelope) => void;
    resolveChannel?: (origin: TurnOrigin) => InteractionChannel;
    onTitleChanged?: (sessionId: string, title: string) => void;
  }) {
    const { sessionId, cwd, server, mcp } = opts;
    this.sessionId = sessionId;
    this.server = server;
    this.mcp = mcp;
    this.cwd = cwd;
    this.chatSession = getSession(sessionId)?.kind === "chat";
    this.onRejectInteractions =
      opts.onRejectInteractions ?? ((id) => questions.rejectSession(id));
    this.emitEvent =
      opts.emitEvent ??
      ((env) =>
        getMainWindow()?.webContents.send(IPC.AgentEvent, {
          sessionId: env.sessionId,
          event: env.event,
        }));
    this.resolveChannel = opts.resolveChannel ?? (() => desktopChannel);
    this.onTitleChanged = opts.onTitleChanged;

    // Hydrate any persisted compression summary so it survives reload/restart.
    // Kept independent of agent.state.messages (the summary replaces the older
    // prefix only in the LLM view; the full transcript is rehydrated verbatim).
    const compression = loadCompression(sessionId);
    if (compression) {
      this.compressedSummary = compression.summary;
      this.compressedUpTo = compression.upTo;
    }

    // Hydrate the accumulated tool selection BEFORE initialState.tools is built
    // below, so a service recreated after idle eviction starts filtered — no
    // window where the full toolset would be shipped (and cached) once.
    const savedSelection = loadToolSelection(sessionId);
    if (savedSelection?.length) this.selectedToolNames = new Set(savedSelection);

    const config = server.getConfig();
    if (!config || !config.llm.main) {
      // Mirrors the old "no key configured" guard: without a `main` role model we
      // have no model + no credential, so we can't run the agent yet.
      throw new Error(
        "No active model configured yet; sign in and wait for sync",
      );
    }
    const mainLlm = config.llm.main;

    this.agent = new Agent({
      // pi 0.81 made the stream function an explicit dependency (pi-agent-core no
      // longer reaches into pi-ai's provider registry itself).
      streamFn: (model, context, options) =>
        streamSimple(model, context, withConversationHeader(sessionId, options)),
      // Credential is resolved per-request from the latest server config — never
      // embedded in the model object or sent to the renderer.
      getApiKey: () => server.getConfig()?.llm.main?.provider.credential,
      // Coalesce rapid steers: drain ALL queued steering messages together at the
      // next turn boundary instead of pi's default one-per-turn, which would
      // otherwise spread a quick burst of redirects across several turns.
      steeringMode: "all",
      // The loop snapshots tools once per run (createContextSnapshot), so a
      // mid-run search_tool enable has to be handed to the loop explicitly.
      // Only fires after a step whose tool calls grew the union — every other
      // step returns undefined and leaves the loop's context untouched.
      prepareNextTurnWithContext: (ctx: any) => {
        if (!this.toolsGrewMidTurn) return undefined;
        this.toolsGrewMidTurn = false;
        return {
          context: { ...ctx.context, tools: this.buildTools(this.cwd) },
        };
      },
      initialState: {
        systemPrompt: buildSystemPrompt(config, cwd, this.isChatSession()),
        model: buildModel(mainLlm),
        // Reasoning effort is server-driven per model. Only set it when delivered
        // so an unset value leaves pi's own default in place. pi maps this uniform
        // level onto the provider's native control (Anthropic effort, OpenAI
        // reasoning_effort, …).
        ...(mainLlm.model.thinkingLevel
          ? { thinkingLevel: mainLlm.model.thinkingLevel }
          : {}),
        tools: this.buildTools(cwd),
        messages: (opts.messages ?? []) as AgentMessage[],
      },
      // Only forward roles the LLM should see, and — when a compression summary
      // exists — replace the already-summarized older prefix with a single
      // synthetic summary message. The summary is LLM-only: agent.state.messages
      // stays fully intact for display, persistence, and multi-device sync.
      convertToLlm: (messages: any[]) => {
        const convo = messages.filter((m) =>
          ["user", "assistant", "toolResult"].includes(m.role),
        );
        // Image parts may carry on-disk store refs instead of inline base64
        // (persisted/dehydrated history); the provider needs real bytes, so
        // resolve them here — LLM-view only, the stored messages keep the refs.
        if (!this.compressedSummary || this.compressedUpTo <= 0)
          return rehydrateImages(convo) as any[];
        // Clamp to the current length: a remote session-restore could shrink the
        // history below the persisted upTo, in which case we compress nothing.
        const upTo = safeCompressionBoundary(convo, this.compressedUpTo);
        if (upTo <= 0) return rehydrateImages(convo) as any[];
        const kept = rehydrateImages(convo.slice(upTo)) as any[];
        return [
          {
            role: "user",
            content:
              "<context_summary>\nThe following is a summary of the earlier " +
              "part of this conversation, provided to conserve context:\n\n" +
              this.compressedSummary +
              "\n</context_summary>",
            timestamp: kept[0]?.timestamp ?? Date.now(),
          },
          ...kept,
        ];
      },
      // Approval gate: every tool runs through here. Read-only tools (read/grep/
      // find/ls) pass silently; everything else — mutating local tools and all
      // MCP/remote tools — needs user confirmation, unless already approved for
      // this session.
      beforeToolCall: async ({ toolCall, args }: any) => {
        const name = toolCall.name as string;
        // `ask` only collects the user's own choice — there is nothing to approve,
        // and gating it would deadlock (the user is already being prompted).
        if (name === "ask") return undefined;
        // `remember` writes only to the user's own memory store (no files/commands),
        // so it's inherently safe and exempt — gating it would nag the user for
        // something the assistant does silently and often.
        if (name === "remember") return undefined;
        // `todo_write` only records the agent's own task plan (no files/commands),
        // so it's inherently safe and exempt — gating it would nag for something
        // the assistant does silently and often while working.
        if (name === "todo_write") return undefined;
        // `schedule` only writes local task metadata (no files/commands run at
        // creation time); the runs themselves are gated per-tool when they fire.
        if (name === "schedule") return undefined;
        // `search_tool` only changes which tool DEFINITIONS the model sees; every
        // enabled tool is still individually gated when actually called, so no
        // privilege is gained by enabling and there is nothing to approve.
        if (name === "search_tool") return undefined;
        const origin = this.activeTurnOrigin;
        // "Full access" auto-approves everything — but only for a purely
        // desktop-origin turn (most-restrictive-origin-wins). Any telegram
        // contribution to the turn (start or steer) flips `gatedByTelegram`, so a
        // Telegram-authored tool call can never ride a desktop "Full access".
        if (
          !this.gatedByTelegram &&
          origin.kind === "desktop" &&
          this.permissionMode === "full"
        )
          return undefined;
        if (isReadOnlyTool(name)) return undefined;
        // Session-scoped approvals are partitioned by origin, so a desktop
        // "Allow for this session" never auto-approves a Telegram tool call.
        if (this.allowSet(origin).has(name)) return undefined;

        // Route the approval to the channel that owns this turn's origin (desktop
        // window vs. Telegram chat), resolved at call time. Carry the cwd so the
        // (remote) approval card can show where a command/file tool will run.
        const decision = await this.resolveChannel(origin).requestApproval({
          sessionId,
          origin,
          toolName: name,
          args,
          cwd: this.cwd,
        });
        if (!decision.approved)
          return { block: true, reason: "User denied the action" };
        if (decision.scope === "session") this.allowSet(origin).add(name);
        return undefined;
      },
    });

    this.agent.sessionId = sessionId;

    // MCP servers connect asynchronously and can come and go as the server pushes
    // config. Re-merge the live tool set onto the running agent whenever it
    // changes (assigning state.tools is pi's sanctioned injection point).
    this.mcpUnsub = this.mcp.onToolsChanged(() => {
      this.agent.state.tools = this.buildTools(this.cwd);
    });

    // Config values baked into initialState (model, system prompt, thinking
    // level, config-gated tools like web_search) would otherwise freeze at
    // construction time — only getApiKey resolves live. Re-apply them whenever
    // the server pushes a new snapshot/delta so long-lived sessions pick up
    // admin changes; pi reads state at each turn start, so mid-run assignment
    // simply takes effect from the next turn. (onConfig fires immediately with
    // the current snapshot; re-applying identical values is harmless.)
    this.configUnsub = server.onConfig((cfg) => {
      const llm = cfg.llm.main;
      if (!llm) return; // keep the last working config rather than break the agent
      this.agent.state.model = buildModel(llm);
      if (llm.model.thinkingLevel)
        this.agent.state.thinkingLevel = llm.model.thinkingLevel;
      this.agent.state.systemPrompt = buildSystemPrompt(
        cfg,
        this.cwd,
        this.isChatSession(),
      );
      this.agent.state.tools = this.buildTools(this.cwd);
    });

    // Forward every pi event to the renderer, tagged with sessionId.
    this.unsubscribe = this.agent.subscribe((event: any) => {
      // pi has no top-level "error" AgentEvent: a failed stream surfaces as an
      // inner assistantMessageEvent of type "error". Lift it to a visible error.
      const inner = event?.assistantMessageEvent;
      if (event.type === "message_update" && inner?.type === "error") {
        const msg =
          inner.error?.errorMessage ?? `LLM stream ${inner.reason ?? "error"}`;
        // A retryable failure opens a retry window instead of surfacing: the
        // run is about to end with an errored message that runTurnRetries (in
        // prompt(), which is still awaiting this run) will pop and re-issue.
        if (
          inner.reason !== "aborted" &&
          this.willAutoRetry({
            errorMessage: msg,
            rawStopReason: inner.error?.rawStopReason,
          })
        ) {
          this.beginRetryWindow();
          return;
        }
        this.running = false;
        this.send(sessionId, { type: "error", message: msg });
        return;
      }
      // A terminal request/model failure (bad credential, endpoint, model id,
      // network) is NOT thrown and NOT a mid-stream soft error: pi-agent-core
      // encodes it as the turn's final assistant message — a `message_end` whose
      // `errorMessage` is set + `stopReason: "error"` (agent.js). The branch above
      // only catches mid-stream soft errors, so without this the turn ends
      // silently (empty reply, no error). `aborted` is a user stop, not an error.
      const endMsg = event?.message;
      if (
        event.type === "message_end" &&
        endMsg?.role === "assistant" &&
        endMsg.stopReason !== "aborted" &&
        (endMsg.errorMessage || endMsg.stopReason === "error")
      ) {
        // Same retry window as the mid-stream branch (which may already have
        // opened it — beginRetryWindow is idempotent per failure). Swallow the
        // errored message_end: the failed message never reaches the renderer.
        if (
          this.willAutoRetry({
            errorMessage: endMsg.errorMessage,
            rawStopReason: endMsg.rawStopReason,
          })
        ) {
          this.beginRetryWindow();
          return;
        }
        this.running = false;
        this.send(sessionId, {
          type: "error",
          message: endMsg.errorMessage ?? "LLM request failed",
        });
        return;
      }
      // While a retry window is open, the errored run's terminal events stay
      // internal: forwarding agent_end would flash the renderer to idle, and
      // persisting on turn_end/agent_end would sync the failed message that
      // runTurnRetries is about to pop.
      if (
        this.retryPending &&
        (event.type === "turn_end" || event.type === "agent_end")
      )
        return;
      // Keep the run-state flag in lockstep with the lifecycle events the
      // renderer also keys off, so isRunning() matches what the UI shows.
      if (event.type === "agent_start") {
        this.running = true;
        // New turn: restart per-turn web-search citation + image numbering.
        this.searchIdOffset = 0;
        this.searchImageIdOffset = 0;
      }
      if (event.type === "agent_end") {
        this.running = false;
        // The turn is over: drop any Telegram gate-escalation so the next
        // (possibly desktop-only) turn re-evaluates the gate from scratch.
        this.gatedByTelegram = false;
      }
      this.send(sessionId, normalizeEvent(event));
      // Persist policy: `turn_end` fires on EVERY model round-trip (a 20-tool
      // run has 20 of them) and the full save — stringify + FTS rebuild + sync
      // snapshot — runs synchronously inside pi's event dispatch, blocking the
      // agent loop. So mid-run turn ends are only throttled crash-safety
      // checkpoints (local save, no sync); the authoritative save + server
      // sync + dehydrated-array adoption run once per run at `agent_end`.
      if (event.type === "turn_end") void this.persist("turn");
      if (event.type === "agent_end") void this.persist("final");
    });
  }

  /**
   * Whether this session is a `chat` (no workspace). Kind is fixed at session
   * creation — a project's workspace is chosen before the session exists and
   * never changes — so it's read from SQLite once in the constructor. Chat
   * sessions run a floor-only default toolset (see CHAT_TOOL_FLOOR) over a
   * catalog that excludes the file/shell tools, and use the `chat` system
   * prompt instead of `main`.
   */
  private isChatSession(): boolean {
    return this.chatSession;
  }

  /**
   * Assemble the agent's tool set: the unfiltered catalog ({@link
   * buildAllTools}) with the enabled-name filter ({@link enabledToolNames})
   * applied. Every rebuild site (constructor, MCP change, config push) calls
   * this method, so the filter is re-applied automatically.
   */
  private buildTools(cwd: string): AgentTool<any>[] {
    const all = this.buildAllTools(cwd);
    const enabled = this.enabledToolNames();
    if (!enabled) return all;
    // Membership filter only — buildAllTools' stable ordering is preserved so
    // pi-ai's automatic cache breakpoint on the last tool def sits on a prefix
    // that only ever GROWS within a session (accumulate-only union).
    return all.filter((t) => enabled.has(t.name));
  }

  /**
   * The tool names currently enabled — always floor ∪ accumulated union — or
   * null when no filter applies (full catalog):
   * - chat: always filtered. CHAT_TOOL_FLOOR by default, grown only by
   *   `search_tool` — independent of the server-driven selector feature.
   * - project: filtered only while automatic selection is live — the selector
   *   has seeded the union, hasn't failed open, and the server still delivers
   *   the `tool_selection` prompt. Checking the prompt HERE (not just at
   *   selection time) means an admin disabling it restores the full toolset at
   *   the very next rebuild (onConfig fires immediately on the push).
   */
  private enabledToolNames(): Set<string> | null {
    if (this.isChatSession())
      return new Set([...CHAT_TOOL_FLOOR, ...(this.selectedToolNames ?? [])]);
    if (this.toolSelectionBypassed || !this.selectedToolNames) return null;
    const config = this.server.getConfig();
    if (!config || !findPromptBody(config, TOOL_SELECTION_PROMPT_NAME)) return null;
    return new Set([...TOOL_SELECTION_FLOOR, ...this.selectedToolNames]);
  }

  /**
   * Grow the selection union with catalog tool names (search_tool's enable
   * path) and return the names actually newly enabled. No-op while nothing is
   * filtered: the full catalog is already available then, and seeding the
   * union would ACTIVATE filtering and shrink the toolset — the opposite of
   * what the caller wants. Accumulate-only, like the selector.
   */
  private enableSelectedTools(names: string[]): string[] {
    const enabled = this.enabledToolNames();
    if (!enabled) return [];
    const valid = new Set(this.buildAllTools(this.cwd).map((t) => t.name));
    const added = names.filter((n) => valid.has(n) && !enabled.has(n));
    if (added.length === 0) return [];
    const union = new Set([...(this.selectedToolNames ?? []), ...added]);
    this.selectedToolNames = union;
    saveToolSelection(this.sessionId, [...union]);
    // Reaches the NEXT run immediately; the in-flight run is refreshed via the
    // toolsGrewMidTurn flag in prepareNextTurnWithContext.
    this.agent.state.tools = this.buildTools(this.cwd);
    this.toolsGrewMidTurn = true;
    console.log(
      `[ToolSelection] search_tool enabled=[${added.join(", ")}] union=${union.size}`,
    );
    return added;
  }

  /**
   * Unfiltered tool catalog — everything the session could have. Identical for
   * chat and project sessions except the file/shell tools (createTools), which
   * a chat (no workspace chosen) never gets; what a chat actually STARTS with
   * is the much smaller CHAT_TOOL_FLOOR (see enabledToolNames).
   */
  private buildAllTools(cwd: string): AgentTool<any>[] {
    const chat = this.isChatSession();
    const tools: AgentTool<any>[] = [
      ...(chat ? [] : createTools(cwd)),
      // Resolve origin + channel at CALL time (not here at build time) so an
      // `ask` routes to the front-end that authored the turn currently running.
      createAskTool(this.sessionId, () => ({
        origin: this.activeTurnOrigin,
        channel: this.resolveChannel(this.activeTurnOrigin),
      })),
      // Scheduled tasks can be set up from ANY session (chat or project): the
      // task binds to this session and its runs reply here. Approval-exempt
      // (local metadata only) — see beforeToolCall.
      createScheduleTool(this.sessionId),
    ];
    tools.push(
      createMemoryTool(this.sessionId, (m) => this.persistMemory(m)),
      createTodoTool(),
    );
    // The selection escape hatch — registered whenever filtering can be active:
    // always in chat (the ONLY way a chat grows its toolset), and in a project
    // only while the server-driven `tool_selection` feature exists (without it
    // the full catalog is always enabled and the tool would be dead weight).
    // Floor member in both kinds, so never filtered out.
    const config = this.server.getConfig();
    if (chat || (config && findPromptBody(config, TOOL_SELECTION_PROMPT_NAME))) {
      tools.push(
        createSearchToolTool({
          getCatalog: () => this.buildAllTools(this.cwd),
          getEnabledNames: () =>
            new Set(this.buildTools(this.cwd).map((t) => t.name)),
          enable: (names) => this.enableSelectedTools(names),
        }),
      );
    }
    // GitHub tools are a generic capability (the orchestrator skill builds on
    // them). Always registered so the model can surface a clear "connect GitHub
    // in Settings" error instead of the tools silently not existing; only
    // github_read is read-only-allowlisted.
    tools.push(...createGithubTools(cwd));
    tools.push(createDispatchTaskTool(this.sessionId, cwd));
    tools.push(createDispatchReviewTool(this.sessionId, cwd));
    // Offer web_search only when an Exa service is configured + enabled, so the
    // model never sees a tool it can't actually use. Resolved fresh at execute
    // time from the latest server config (key never captured here).
    if (resolveExaService(this.server.getConfig())) {
      tools.push(
        createWebSearchTool(
          () => resolveExaService(this.server.getConfig()),
          // Reserve a turn-unique id block per search (advance synchronously so
          // parallel searches get disjoint ranges); reset each turn (agent_start).
          (count) => {
            const start = this.searchIdOffset;
            this.searchIdOffset += count;
            return start;
          },
          (count) => {
            const start = this.searchImageIdOffset;
            this.searchImageIdOffset += count;
            return start;
          }
        )
      );
      // Same citation-id and image-id allocators as web_search: fetched pages
      // and search results share the turn-unique [n] and #i<n> namespaces.
      tools.push(
        createWebFetchTool(
          () => resolveExaService(this.server.getConfig()),
          (count) => {
            const start = this.searchIdOffset;
            this.searchIdOffset += count;
            return start;
          },
          (count) => {
            const start = this.searchImageIdOffset;
            this.searchImageIdOffset += count;
            return start;
          }
        )
      );
    }
    tools.push(...this.mcp.getTools());
    return tools;
  }

  /**
   * Persist a memory the `remember` tool produced: write it to local SQLite,
   * mirror it to the server for multi-device sync, and tell open windows (e.g.
   * the Settings "memories" view) to refresh. User-scoped, so it's independent
   * of which session wrote it.
   */
  private persistMemory(memory: Memory): void {
    upsertMemory(memory);
    this.server.sendMemoryUpsert({ memories: [memory] });
    broadcast(IPC.MemoriesChanged);
  }

  private send(sessionId: string, event: AgentStreamEvent): void {
    // Emit the envelope (tagged with this turn's origin) onto the injected sink
    // instead of touching the window directly. The default sink reproduces the
    // old behavior (forward to the live main window, resolved at send time so
    // events still arrive after a close→reopen on macOS); the Telegram sink
    // subscribes the same bus and filters by origin.
    this.emitEvent({ sessionId, event, origin: this.activeTurnOrigin });
  }

  /** The agent's current in-memory message set (may be ahead of the last persist). */
  getLiveMessages(): unknown[] {
    return this.agent.state.messages;
  }

  /** Whether a turn is currently running (for the sidebar + restored view). */
  isRunning(): boolean {
    return this.running;
  }

  /** Last crash-safety checkpoint; throttles mid-run `turn` persists. */
  private lastSaveAt = 0;

  /** Minimum spacing between mid-run crash-safety saves. */
  private static readonly TURN_SAVE_MIN_INTERVAL_MS = 30_000;

  /**
   * Snapshot messages to SQLite (and, for a `final` persist, mirror them to
   * the server). `turn` = a mid-run crash-safety checkpoint: throttled to one
   * save per {@link AgentService.TURN_SAVE_MIN_INTERVAL_MS} and never synced —
   * the save (stringify + FTS rebuild) runs synchronously inside pi's event
   * dispatch, so doing it on every model round-trip stalls the agent loop and
   * the main thread on long conversations. `final` (agent_end / retry
   * exhaustion) always saves, adopts the dehydrated array, and syncs once.
   */
  private async persist(mode: "turn" | "final" = "final"): Promise<void> {
    // A terminal event can land after dispose() (session deleted); skip so we
    // don't re-insert a messages row for a session that's already gone.
    if (this.disposed) return;
    if (
      mode === "turn" &&
      Date.now() - this.lastSaveAt < AgentService.TURN_SAVE_MIN_INTERVAL_MS
    )
      return;
    const messages = this.agent.state.messages;
    // saveMessages extracts inline base64 images to the on-disk store and
    // returns the slim ref-bearing array (identical when nothing changed).
    const stored = await saveMessages(this.sessionId, messages);
    this.lastSaveAt = Date.now();
    if (mode === "turn") return;
    // Adopt the slim array in the live agent only BETWEEN runs — never mid-run,
    // where pi may hold a reference to the current array. convertToLlm
    // rehydrates the refs, so the LLM view is unaffected.
    if (stored !== messages && !this.running && !this.disposed) {
      this.agent.state.messages = stored as AgentMessage[];
    }
    this.syncToServer(stored);
  }

  /**
   * Mirror the current message set to the server as a FULL snapshot (upsert =
   * server-side DELETE + reinsert). Best-effort: no-op offline.
   *
   * Why always upsert instead of an incremental patch: we never actually compute
   * a message-level delta — `messages` is the entire `agent.state.messages` every
   * turn. pi also does NOT assign ids to user messages (agent.prompt builds them
   * as `{ role, content, timestamp }`), so `toSyncMessage` mints a fresh random id
   * for those each call. A per-message "append keyed by id" therefore fails to
   * dedupe id-less messages and re-inserts them every turn, piling up duplicates
   * server-side — which then overwrite the local copy on the next session:pull. A
   * full upsert makes the server a pure mirror of local state, immune to id churn.
   * (sendSessionPatch is still used for title-only updates via syncTitle.)
   */
  private syncToServer(messages: unknown[]): void {
    const meta = getSession(this.sessionId);
    if (!meta || meta.kind !== "chat") return;
    // The wire contract carries full images: resolve store refs back to inline
    // base64 so other devices receive real bytes (they re-extract on write).
    const synced = rehydrateImages(messages).map(toSyncMessage);
    const updatedAt = Date.now();

    this.server.sendSessionUpsert({
      session: {
        id: meta.id,
        // userId is filled in server-side from the authenticated token.
        userId: "",
        title: meta.title,
        createdAt: meta.createdAt,
        updatedAt,
      },
      messages: synced,
    });
    // Mark the session as established server-side so syncTitle's title-only patch
    // (which is UPDATE-only on the server) targets an existing row.
    this.upserted = true;
  }

  /**
   * Single entry point for composer text. Decides the routing the renderer can't
   * safely do itself: while a turn is in flight, inject the text as a STEERING
   * message (pi forbids prompt() during an active run and drains steers at the
   * next turn boundary); otherwise start a fresh run via prompt().
   *
   * The running check happens here against the authoritative `this.running`, so
   * the "user hit send the instant the turn ended" race lands on prompt() and
   * re-starts the run — rather than leaving the text stranded in the steering
   * queue, which only drains while a run is active.
   */
  async submit(
    text: string,
    attachments?: Attachment[],
    origin: TurnOrigin = DESKTOP_ORIGIN,
  ): Promise<void> {
    if (this.running) {
      // Inject as steering. Skip a truly empty submit (no text and no images) so we
      // don't push a blank user message into the running turn.
      if (text.trim() || attachments?.length) this.steer(text, attachments, origin);
      return;
    }
    await this.prompt(text, attachments, origin);
  }

  async prompt(
    text: string,
    attachments?: Attachment[],
    origin: TurnOrigin = DESKTOP_ORIGIN,
  ): Promise<void> {
    // A fresh run fixes the turn's routing origin: the event sink + gate read this
    // for the rest of the turn.
    this.activeTurnOrigin = origin;
    // Fresh user turn → fresh retry budget.
    this.retryAttempt = 0;
    // First user message in a fresh session → generate a title from it. Capture
    // "is first" BEFORE agent.prompt mutates state.messages, and fire it off
    // before the await so it runs in parallel with (never blocks) the turn.
    // Schedule-origin turns are machine-authored ("[scheduled run] …") — never
    // derive a session title from them (edge case: a task session with an empty
    // history would otherwise get titled from the injected trigger text).
    const isFirst = this.agent.state.messages.length === 0;
    if (isFirst && !this.titleGenerated && text.trim() && origin.kind !== "schedule") {
      void this.maybeGenerateTitle(text);
    }
    // Mark running BEFORE the (potentially seconds-long) compression await:
    // submit() routes on this flag, so a second send arriving mid-compression
    // must land in the steering queue (drained at run start) rather than a
    // concurrent prompt(), which pi forbids. Also keeps a session reopened
    // before the first event reporting as running; agent_start/agent_end keep
    // it accurate thereafter.
    this.running = true;
    try {
      // Auto context-compression: fold older messages into a rolling summary
      // before the turn if the conversation nears the model's context window.
      // Awaits so the compressed view is in place for this very turn.
      await this.maybeCompressContext(false, true);
      // abort() during the compression await flips `running` off — the user
      // asked to stop, so don't start the turn compression was preparing.
      if (!this.running) return;
      // Two independent pre-turn side calls, overlapped so the added latency is
      // max() not sum():
      // - maybeDescribeImages: with a text-only main model + an assigned
      //   `visual` model, extract a text description of the images to ride on
      //   the same user message. Inherent latency: the description must exist
      //   before the main model runs.
      // - maybeSelectTools: automatic tool selection — assigns the filtered
      //   agent.state.tools itself before resolving, so the set is in place
      //   when agent.prompt() snapshots state at run start. (A steer into a
      //   running turn never re-selects: submit() routes it past prompt() and
      //   the run's tool snapshot is already taken.)
      const [description] = await Promise.all([
        this.maybeDescribeImages(attachments),
        this.maybeSelectTools(text),
      ]);
      // Write attached images to the on-disk store and put only refs into the
      // message, so the transcript never holds their base64 (convertToLlm
      // rehydrates for the request; the visual model above got the originals).
      const stored = storeAttachments(attachments);
      if (description && stored?.length) {
        await this.agent.prompt({
          role: "user",
          content: [
            { type: "text", text },
            ...stored,
            { type: "text", text: encodeImageDescriptions(description) },
          ],
          timestamp: Date.now(),
        } as any);
      } else {
        await this.agent.prompt(text, stored as any);
      }
      // The run has fully resolved. If it ended in a retryable model error,
      // re-issue it with exponential backoff (up to MAX_AUTO_RETRIES).
      await this.runTurnRetries();
    } catch (err) {
      this.running = false;
      this.retryPending = false;
      // A rejected run (bad credential, provider/baseUrl, network) would
      // otherwise vanish silently — surface it as a visible error event.
      this.send(this.sessionId, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Whether the subscribe handler should hold back an errored run for an
   * automatic retry. Must agree with the loop guard in {@link runTurnRetries}:
   * the handler decides at message_end time, the loop re-checks once the run
   * resolves — same state, same predicate.
   */
  private willAutoRetry(failure: ModelFailure): boolean {
    return (
      this.running &&
      !this.disposed &&
      this.retryAttempt < MAX_AUTO_RETRIES &&
      isRetryableModelError(failure)
    );
  }

  /**
   * Open the retry window for the failure currently unwinding: swallow the
   * run's terminal events and tell the renderer a retry is coming (shimmer
   * row). Idempotent per failure — the mid-stream and terminal error branches
   * can both land for the same failed request.
   */
  private beginRetryWindow(): void {
    if (this.retryPending) return;
    this.retryPending = true;
    this.notifyRetryStatus(true, this.retryAttempt + 1);
  }

  /** Push the retry-in-progress flag to the renderer (drives the shimmer row). */
  private notifyRetryStatus(active: boolean, attempt: number): void {
    this.send(this.sessionId, {
      type: "retry_status",
      active,
      attempt,
      max: MAX_AUTO_RETRIES,
    });
  }

  /**
   * The retry state a cold session-open should seed the renderer with, mirroring
   * isRunning()/isCompressing(). Non-null only while a retry window is open.
   */
  getRetryStatus(): { attempt: number; max: number } | null {
    return this.retryPending
      ? { attempt: this.retryAttempt + 1, max: MAX_AUTO_RETRIES }
      : null;
  }

  /**
   * Auto-retry loop for the run prompt() just awaited. pi never throws on a
   * model failure — it leaves an assistant message with `stopReason: "error"`
   * at the tail of the transcript and ends the run. Recovery: pop that message
   * (the live array is safe to mutate between runs), wait out the backoff, and
   * `agent.continue()` — which re-issues the request from the surviving
   * transcript, draining any steering messages the user queued meanwhile.
   *
   * The subscribe handler has already suppressed the failed run's error event
   * and terminal events (see beginRetryWindow); if retries are exhausted — or
   * the guard disagrees because state moved under us — the error the handler
   * swallowed is surfaced here instead.
   */
  private async runTurnRetries(): Promise<void> {
    while (true) {
      const messages = this.agent.state.messages as any[];
      const last = messages[messages.length - 1];
      // Failure predicate must MATCH the subscribe handler's error branch: if
      // the handler held a run back for retry, this loop must agree it failed —
      // otherwise the swallowed agent_end leaves the session stuck "running".
      const failed =
        last?.role === "assistant" &&
        last.stopReason !== "aborted" &&
        (last.errorMessage || last.stopReason === "error");
      // Clean end (or user abort, which keeps stopReason "aborted"): done.
      if (!failed) break;
      if (
        !this.running ||
        this.disposed ||
        this.retryAttempt >= MAX_AUTO_RETRIES ||
        !isRetryableModelError({
          errorMessage: last.errorMessage,
          rawStopReason: last.rawStopReason,
        })
      ) {
        // Give up. If the handler swallowed the terminal error expecting a
        // retry that won't happen, surface it now — unless the user stopped
        // (running already false), where a deliberate stop shows no error.
        if (this.retryPending && this.running && !this.disposed) {
          this.running = false;
          this.send(this.sessionId, {
            type: "error",
            message: last.errorMessage ?? "LLM request failed",
          });
        }
        break;
      }
      this.retryAttempt++;
      // The failed message must not survive: the provider would reject a
      // transcript continuing from it, and it must never persist/sync.
      messages.pop();
      this.retryAbort = new AbortController();
      const slept = await sleepUnlessAborted(
        retryBackoffMs(this.retryAttempt),
        this.retryAbort.signal,
      );
      this.retryAbort = null;
      // Stopped during the backoff → the user's abort wins, no retry.
      if (!slept || !this.running || this.disposed) break;
      // Close the window so the new run's events flow to the renderer again.
      this.retryPending = false;
      try {
        await this.agent.continue();
      } catch (err) {
        // continue() only throws on invalid state (a model failure would land
        // as another errored message and loop again). Surface and stop.
        this.running = false;
        this.send(this.sessionId, {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }
    if (this.retryPending || this.retryAttempt > 0) {
      if (this.retryPending) {
        // The failed run's terminal events — and the persist they trigger —
        // were swallowed, and no successful run followed (retries exhausted or
        // stopped mid-backoff). Snapshot what survived so the user's message
        // (and, on exhaustion, the final errored reply) reach disk/sync, and
        // synthesize the agent_end the renderer never saw so every surface
        // (background sessions, Telegram-initiated stops) leaves "running".
        this.retryPending = false;
        void this.persist();
        this.send(this.sessionId, { type: "agent_end" });
      }
      this.notifyRetryStatus(false, this.retryAttempt);
    }
  }

  /**
   * Generate a session title from the user's first message using the
   * server-delivered `title_generation` system prompt and the `tool`-role model
   * (falling back to `main`). Best-effort: any failure keeps the default title
   * and never surfaces a chat error. Runs in parallel with the agent turn.
   */
  /**
   * Automatic tool selection: before a fresh turn, ask the `tool`-role model
   * (fallback `main`, same as title generation) which tools the turn needs and
   * enable the UNION of every selection this session has made (accumulate-only
   * — see {@link selectedToolNames} for the cache rationale). Strictly
   * server-driven: no `tool_selection` prompt → no selector call, full toolset.
   * Fail-open: any error/timeout/bad JSON bypasses selection for the rest of
   * the session (full toolset, console.warn only, never a chat error).
   */
  private async maybeSelectTools(text: string): Promise<void> {
    if (this.toolSelectionBypassed) return;
    // Chat never runs the selector: its default is the fixed CHAT_TOOL_FLOOR
    // and search_tool is the only expansion path (no per-turn side call).
    if (this.isChatSession()) return;
    const config = this.server.getConfig();
    if (!config) return;
    const sysPrompt = findPromptBody(config, TOOL_SELECTION_PROMPT_NAME);
    if (!sysPrompt) return; // feature off → enabledToolNames() stays null
    const llm = config.llm.tool ?? config.llm.main;
    if (!llm) return;

    // Catalog from the UNFILTERED assembly — every tool participates, including
    // MCP tools connected right now. Tools not yet connected can't be selected
    // this turn; they become candidates on the next fresh prompt.
    const catalog = this.buildAllTools(this.cwd);
    const catalogNames = new Set(catalog.map((t) => t.name));
    const lowerIndex = new Map(catalog.map((t) => [t.name.toLowerCase(), t.name]));

    // Shimmer row on only AFTER all the early-return guards: a session where the
    // feature is off must never flash the status row.
    this.setSelectingTools(true);
    this.selectAbort = new AbortController();
    const timeout = setTimeout(
      () => this.selectAbort?.abort(),
      TOOL_SELECTION_TIMEOUT_MS,
    );
    try {
      const stream = streamSimple(
        buildModel(llm),
        {
          systemPrompt: sysPrompt,
          messages: [
            {
              role: "user",
              content: this.buildSelectionRequest(catalog, text),
              timestamp: Date.now(),
            },
          ] as any,
        },
        // maxRetries re-enables the provider SDK's own backoff (pi defaults it
        // to 0). 512 output tokens: a {"tools":[...]} over a large catalog
        // would truncate at title-gen's 64.
        withConversationHeader(this.sessionId, {
          apiKey: llm.provider.credential,
          maxTokens: 512,
          maxRetries: 2,
          signal: this.selectAbort.signal,
        }),
      );
      const result = await stream.result();
      // .result() resolves even on a SOFT stream error — treat both as failure.
      if (result.stopReason === "error" || result.stopReason === "aborted")
        throw new Error(`selector stream ${result.stopReason}`);
      const raw = result.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      // Take the first {...} block, ignoring any prose around it.
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match)
        throw new Error(`no JSON object in selector output: ${raw.slice(0, 200)}`);
      const parsed = JSON.parse(match[0]) as { tools?: unknown };
      if (!Array.isArray(parsed.tools))
        throw new Error('selector output missing "tools" array');
      // Validate against the catalog: exact name, then case-insensitive
      // fallback; unknown names are dropped.
      const picked: string[] = [];
      for (const n of parsed.tools) {
        if (typeof n !== "string") continue;
        if (catalogNames.has(n)) picked.push(n);
        else {
          const ci = lowerIndex.get(n.toLowerCase());
          if (ci) picked.push(ci);
        }
      }
      // Accumulate-only union. An empty first selection is valid: the turn runs
      // floor-only ({ask, read, todo_write, remember}); later turns only add.
      const union = new Set(this.selectedToolNames ?? []);
      for (const n of picked) union.add(n);
      const grew =
        !this.selectedToolNames || union.size > this.selectedToolNames.size;
      this.selectedToolNames = union;
      if (grew) saveToolSelection(this.sessionId, [...union]);
      this.agent.state.tools = this.buildTools(this.cwd);
      console.log(
        `[ToolSelection] picked=[${picked.join(", ")}] union=${union.size} ` +
          `enabled=${this.agent.state.tools.length}/${catalog.length}`,
      );
    } catch (err) {
      // Fail-open FOR THE SESSION: never filter on a broken selector, and don't
      // grow-then-shrink the tool list turn over turn (cache thrash). The
      // persisted union is untouched; a recreated service re-hydrates it and
      // tries selecting again.
      this.toolSelectionBypassed = true;
      this.agent.state.tools = this.buildTools(this.cwd); // filter now off → full set
      console.warn("[ToolSelection] failed, running with full toolset:", err);
    } finally {
      clearTimeout(timeout);
      this.selectAbort = null;
      this.setSelectingTools(false);
    }
  }

  /** Push the tool-selection flag to the renderer (drives the shimmer row). */
  private setSelectingTools(active: boolean): void {
    getMainWindow()?.webContents.send(IPC.AgentToolSelectionStatus, {
      sessionId: this.sessionId,
      active,
    });
  }

  /** The selector's user message: tool catalog + recent context + the request. */
  private buildSelectionRequest(catalog: AgentTool<any>[], text: string): string {
    const toolLines = catalog
      .map((t) => {
        // First line of the description, clipped — enough signal to route on.
        const desc = (t.description ?? "").split("\n")[0].slice(0, 150);
        return `- ${t.name}: ${desc}`;
      })
      .join("\n");
    // Recent context: trailing user/assistant text only. Tool results and
    // images are noise for routing, and projectText already flattens parts.
    const recent = (this.agent.state.messages as any[])
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-SELECTION_CONTEXT_MESSAGES)
      .map((m) => {
        const t = projectText(m.content).replace(/\s+/g, " ").trim();
        return t ? `${m.role}: ${t.slice(0, SELECTION_CONTEXT_CLIP)}` : "";
      })
      .filter(Boolean)
      .join("\n");
    return (
      `<available_tools>\n${toolLines}\n</available_tools>\n\n` +
      (recent ? `<recent_conversation>\n${recent}\n</recent_conversation>\n\n` : "") +
      `<user_message>\n${text}\n</user_message>\n\n` +
      'Select the tools needed for the assistant\'s next turn. Respond with ONLY ' +
      'a JSON object of the form {"tools": ["tool_name", ...]} — no prose, no ' +
      "code fences. Use exact tool names from <available_tools>. Return " +
      '{"tools": []} if no tools are needed.'
    );
  }

  private async maybeGenerateTitle(firstMessage: string): Promise<void> {
    this.titleGenerated = true; // guard re-entry even if this throws
    const config = this.server.getConfig();
    const meta = getSession(this.sessionId);
    if (!config || !meta) return;
    const sysPrompt = findPromptBody(config, TITLE_GENERATION_PROMPT_NAME);
    if (!sysPrompt) return; // strictly server-driven: no prompt → no title
    const llm = config.llm.tool ?? config.llm.main;
    if (!llm) return;
    try {
      const stream = streamSimple(
        buildModel(llm),
        {
          systemPrompt: sysPrompt,
          messages: [
            {
              role: "user",
              content: `<userMessage>${firstMessage}</userMessage>`,
              timestamp: Date.now(),
            },
          ] as any,
        },
        // maxRetries re-enables the provider SDK's own backoff (pi defaults it
        // to 0) — right for an invisible best-effort side call.
        withConversationHeader(this.sessionId, {
          apiKey: llm.provider.credential,
          maxTokens: 64,
          maxRetries: 2,
        }),
      );
      const result = await stream.result();
      // .result() resolves even on a SOFT stream error (an AssistantMessage with
      // stopReason 'error'/'aborted'); bail before turning that into a title.
      if (result.stopReason === "error" || result.stopReason === "aborted")
        return;
      const raw = result.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("");
      const title = sanitizeTitle(raw);
      if (!title) return;
      updateSessionTitle(this.sessionId, title);
      this.emitTitle(title);
      this.syncTitle(title);
      this.onTitleChanged?.(this.sessionId, title);
    } catch (err) {
      // Catches THROWN setup/network failures; soft errors handled above. Never
      // a chat error — just log.
      console.warn("[title-gen] failed:", err);
    }
  }

  /** Notify the renderer so the sidebar reflects the new title live. */
  private emitTitle(title: string): void {
    getMainWindow()?.webContents.send(IPC.SessionTitleUpdated, {
      sessionId: this.sessionId,
      title,
    });
  }

  /**
   * Mirror the title to the server — but only once the session row exists there.
   * Pre-upsert, the imminent first-turn sendSessionUpsert re-reads meta.title and
   * carries this title; sending a patch now would hit a non-existent row (the
   * server's patch is UPDATE-only) and be dropped.
   */
  private syncTitle(title: string): void {
    if (!this.upserted) return;
    if (getSession(this.sessionId)?.kind !== "chat") return;
    this.server.sendSessionPatch({
      sessionId: this.sessionId,
      appendMessages: [],
      updatedAt: Date.now(),
      title,
    });
  }

  steer(
    text: string,
    attachments?: Attachment[],
    origin: TurnOrigin = DESKTOP_ORIGIN,
  ): void {
    // Most-restrictive-origin-wins: a telegram steer into a running turn keeps the
    // approval gate on for the rest of that turn, even if it started desktop-origin
    // in "Full access". The turn's routing origin stays whatever started it.
    if (origin.kind === "telegram") this.gatedByTelegram = true;
    // pi's ImageContent and our Attachment are the same shape ({ type: 'image',
    // data, mimeType }), so images drop straight into the user message's content
    // array next to the text part — the same array agent.prompt() builds for an
    // image prompt. With no attachments, keep the plain-string content form.
    const timestamp = Date.now();
    if (attachments && attachments.length > 0) {
      // Best-effort visual extraction first (resolves undefined when the main
      // model can see images itself, no visual model is assigned, or the call
      // fails — never rejects). Queuing the steer after it resolves is safe: pi
      // drains steers at turn boundaries anyway, so the delay only risks
      // reordering against a steer sent moments later — acceptable for a
      // mid-turn redirect.
      void this.maybeDescribeImages(attachments).then((description) => {
        // Same as prompt(): the transcript keeps store refs, not base64.
        const stored = storeAttachments(attachments) ?? [];
        this.agent.steer({
          role: "user",
          content: [
            { type: "text", text },
            ...stored,
            ...(description
              ? [{ type: "text", text: encodeImageDescriptions(description) }]
              : []),
          ],
          timestamp,
        } as any);
      });
      return;
    }
    this.agent.steer({
      role: "user",
      content: text,
      timestamp,
    } as any);
  }

  /**
   * Extract a text description of image attachments with the server-assigned
   * `visual`-role model, for a main model that cannot see images (pi would strip
   * them with an "(image omitted)" note). Returns undefined whenever extraction
   * doesn't apply (no images, main model accepts images, no visual model) or
   * fails — best-effort like title generation: the turn then proceeds exactly as
   * it does today, and this never surfaces a chat error.
   */
  private async maybeDescribeImages(
    attachments: Attachment[] | undefined,
  ): Promise<string | undefined> {
    if (!attachments?.length) return undefined;
    const config = this.server.getConfig();
    const visual = config?.llm.visual;
    if (!config || !visual) return undefined;
    // Mirror buildModel's fallback: a snapshot omitting `input` means text-only.
    const mainInput = config.llm.main?.model.input;
    const mainSeesImages = (mainInput?.length ? mainInput : ["text"]).includes(
      "image",
    );
    if (mainSeesImages) return undefined;
    const sysPrompt =
      findPromptBody(config, IMAGE_DESCRIPTION_PROMPT_NAME) ??
      BASE_IMAGE_DESCRIPTION_PROMPT;
    try {
      const stream = streamSimple(
        buildModel(visual),
        {
          systemPrompt: sysPrompt,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Describe the attached image(s) for a model that cannot see them.",
                },
                ...attachments,
              ],
              timestamp: Date.now(),
            },
          ] as any,
        },
        // SDK-level backoff (see maybeGenerateTitle) — a transient failure here
        // shouldn't silently drop the image description.
        withConversationHeader(this.sessionId, {
          apiKey: visual.provider.credential,
          maxTokens: 2048,
          maxRetries: 2,
        }),
      );
      const result = await stream.result();
      // .result() resolves even on a SOFT stream error (an AssistantMessage with
      // stopReason 'error'/'aborted'); bail before injecting that as a description.
      if (result.stopReason === "error" || result.stopReason === "aborted")
        return undefined;
      const text = result.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("")
        .trim();
      return text || undefined;
    } catch (err) {
      // Catches THROWN setup/network failures; soft errors handled above.
      console.warn("[visual-extract] failed:", err);
      return undefined;
    }
  }

  /**
   * The set of "Allow for this session" tool names for a turn's origin kind,
   * created on first use. Keeping desktop and Telegram grants in separate sets is
   * what stops a desktop session-grant from ungating a later Telegram-origin call.
   */
  private allowSet(origin: TurnOrigin): Set<string> {
    let set = this.sessionAllowed.get(origin.kind);
    if (!set) {
      set = new Set<string>();
      this.sessionAllowed.set(origin.kind, set);
    }
    return set;
  }

  /** Switch the tool-approval posture for the rest of this session. */
  setPermissionMode(mode: PermissionMode): void {
    this.permissionMode = mode;
  }

  /**
   * Snapshot the session-scoped tool approvals (per origin kind) so
   * AgentManager can preserve them across an idle eviction. Plain arrays —
   * cheap to hold while the service itself is gone.
   */
  exportSessionApprovals(): [string, string[]][] {
    return [...this.sessionAllowed.entries()]
      .map(([kind, set]): [string, string[]] => [kind, [...set]])
      .filter(([, names]) => names.length > 0);
  }

  /** Restore approvals exported by {@link exportSessionApprovals}. */
  importSessionApprovals(saved: [string, string[]][]): void {
    for (const [kind, names] of saved) {
      this.sessionAllowed.set(
        kind as TurnOrigin["kind"],
        new Set(names),
      );
    }
  }

  /** Whether a compression auxiliary call is currently in flight. */
  isCompressing(): boolean {
    return this.compressing;
  }

  /**
   * Manually trigger context compression on demand (the ModelPanel button). Runs
   * the same path as the auto trigger but bypasses the threshold check — there
   * must still be enough compressible history (older than the keep-recent window)
   * to actually fold. Best-effort: never throws to the renderer.
   */
  async compressContextNow(): Promise<void> {
    await this.maybeCompressContext(true);
  }

  /**
   * Compress the conversation's older messages into a rolling summary, applied
   * LLM-only via {@link convertToLlm}. Mirrors the auxiliary-call pattern of
   * {@link maybeGenerateTitle} / {@link maybeDescribeImages}: the `tool`-role
   * model is driven by the server-delivered `compression` system prompt.
   * Strictly server-driven: no prompt or no `tool` model → no compression.
   * Best-effort: any failure keeps the existing summary and never surfaces as a
   * chat error.
   *
   * Strategy: keep the most recent {@link KEEP_RECENT} conversational messages
   * uncompressed; fold everything between the already-summarized prefix
   * (`compressedUpTo`) and that recent window into a single (existing-summary +
   * new-messages) summary, then advance `compressedUpTo`. The `force` flag
   * (manual button) skips the token-threshold gate but still requires
   * compressible history. `startingTurn` is set only by prompt(), which flips
   * `running` on BEFORE this await (to route concurrent sends to steering) but
   * has not started the agent loop yet — so slicing is still safe there.
   */
  private async maybeCompressContext(
    force = false,
    startingTurn = false,
  ): Promise<void> {
    // Never compress while the agent loop is active (slicing the message set
    // mid-loop could drop a tool result before it's paired with its call) or
    // while a compression is already in flight.
    if (this.compressing) return;
    if (this.running && !startingTurn) return;
    const config = this.server.getConfig();
    if (!config) return;
    const compressionPrompt = findPromptBody(config, COMPRESSION_PROMPT_NAME);
    if (!compressionPrompt) return; // strictly server-driven
    const llm = config.llm.tool;
    if (!llm) return;

    // Work over the SAME filtered conversational view convertToLlm uses, so the
    // upTo index stays consistent with what gets sliced at send time.
    const convo = this.agent.state.messages.filter((m: any) =>
      ["user", "assistant", "toolResult"].includes(m.role),
    );
    // The recent window is never folded: keep the last KEEP_RECENT messages.
    const currentUpTo = safeCompressionBoundary(convo, this.compressedUpTo);
    const desiredNewUpTo = Math.max(0, convo.length - KEEP_RECENT);
    const newUpTo = safeCompressionBoundary(convo, desiredNewUpTo);
    // Nothing to do if there's no history beyond the already-summarized prefix.
    if (newUpTo <= currentUpTo) return;

    // Auto gate: only compress once the last turn's provider-reported prompt
    // size approaches the main model's context window. This is the request as
    // the provider actually measured it (system prompt, tool schemas, images,
    // and any existing summary included) — the same number the renderer's
    // context meter derives. No usage yet (no completed turn) → nothing worth
    // compressing. Manual (force) skips the gate.
    if (!force) {
      const contextWindow =
        config.llm.main?.model.contextWindow ?? 128_000;
      const used = lastReportedContextTokens(this.agent.state.messages);
      if (used === undefined || used < contextWindow * COMPRESS_TRIGGER_RATIO)
        return;
    }

    this.setCompressing(true);
    this.compressAbort = new AbortController();
    try {
      // Candidates = the slice not yet summarized, up to the new boundary.
      const candidates = convo.slice(currentUpTo, newUpTo);
      const userContent =
        "Use the material in <existing_summary> and " +
        "<conversation_to_summarize> as source material.\n\n" +
        (this.compressedSummary
          ? `<existing_summary>\n${this.compressedSummary}\n</existing_summary>\n\n`
          : "<existing_summary>\n(none)\n</existing_summary>\n\n") +
        `<conversation_to_summarize>\n${serializeForCompression(candidates)}\n</conversation_to_summarize>\n\n` +
        "Output exactly the Markdown structure shown inside <template> and " +
        "keep the section order unchanged. Do not include the <template> tags " +
        "in your response.\n" +
        "<template>\n" +
        "## Objective\n" +
        "- [one or two brief sentences describing what the user is trying to accomplish]\n\n" +
        "## Important Details\n" +
        "- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or \"(none)\"]\n\n" +
        "## Work State\n" +
        "### Completed\n" +
        "- [finished work, verified facts, or changes made; otherwise \"(none)\"]\n\n" +
        "### Active\n" +
        "- [current work, partial changes, or investigation state; otherwise \"(none)\"]\n\n" +
        "### Blocked\n" +
        "- [blockers, failing commands, or unknowns; otherwise \"(none)\"]\n\n" +
        "## Next Move\n" +
        "1. [immediate concrete action, or \"(none)\"]\n" +
        "2. [next action if known, or \"(none)\"]\n\n" +
        "## Relevant Files\n" +
        "- [file or directory path: why it matters, or \"(none)\"]\n" +
        "</template>\n\n" +
        "Rules:\n" +
        "- Keep every section, even when empty.\n" +
        "- Use terse bullets, not prose paragraphs.\n" +
        "- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.\n" +
        "- Do not mention the summary process or that context was compacted.";
      const stream = streamSimple(
        buildModel(llm),
        {
          systemPrompt: compressionPrompt,
          messages: [
            { role: "user", content: userContent, timestamp: Date.now() } as any,
          ],
        },
        // SDK-level backoff (see maybeGenerateTitle); still abortable via signal.
        withConversationHeader(this.sessionId, {
          apiKey: llm.provider.credential,
          signal: this.compressAbort.signal,
          maxRetries: 2,
        }),
      );
      const result = await stream.result();
      if (result.stopReason === "error" || result.stopReason === "aborted")
        return;
      const summary = result.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("")
        .trim();
      if (!summary) return;
      this.compressedSummary = summary;
      this.compressedUpTo = newUpTo;
      saveCompression(this.sessionId, summary, newUpTo);
    } catch (err) {
      // Best-effort: keep the existing summary. Never a chat error.
      console.warn("[compress] failed:", err);
    } finally {
      this.compressAbort = null;
      this.setCompressing(false);
    }
  }

  /** Push the compressing flag to the renderer (drives the message-list shimmer). */
  private setCompressing(active: boolean): void {
    this.compressing = active;
    getMainWindow()?.webContents.send(IPC.AgentCompressStatus, {
      sessionId: this.sessionId,
      active,
    });
  }

  abort(): void {
    this.running = false;
    // Cancel any in-flight compression side stream too; prompt() checks
    // `running` after its compression await, so the prepared turn never starts.
    this.compressAbort?.abort();
    // Cancel an in-flight tool-selector side stream the same way.
    this.selectAbort?.abort();
    // Cut a pending retry backoff short — the loop re-checks `running` and
    // gives up without re-issuing (and without an error row: deliberate stop).
    this.retryAbort?.abort();
    this.agent.abort();
    // Drop any queued steering/follow-up messages so a stop fully clears intent —
    // otherwise a steer queued just before the stop would be injected into the
    // next prompt's run (pi drains the queues at run start).
    this.agent.clearAllQueues();
    // Aborting the run won't settle a blocked approval/`ask` Promise on its own,
    // so cancel every open interaction for this session — otherwise the turn
    // hangs. Routed through the injected fan-out so it also settles approvals
    // (and, later, the Telegram channel), not just questions.
    this.onRejectInteractions(this.sessionId);
  }

  /**
   * Full teardown for a deleted session: stop the run, mark disposed so no late
   * terminal event re-persists messages, and detach the pi subscription so the
   * callback (and its persist path) can't fire again.
   */
  dispose(): void {
    this.disposed = true;
    this.running = false;
    this.compressAbort?.abort();
    this.selectAbort?.abort();
    this.retryAbort?.abort();
    this.agent.abort();
    // Settle any interaction still open for this session so its blocked Promise
    // resolves and no registry entries leak. Routed through the injected fan-out
    // so it covers approvals + questions (+ the Telegram channel later).
    this.onRejectInteractions(this.sessionId);
    this.unsubscribe?.();
    this.mcpUnsub?.();
    this.configUnsub?.();
  }
}

/**
 * Resolve the agent's system prompt from the server-delivered prompts,
 * applying runtime variable substitution ({{os}}, {{date}}, {{skill}}, …) to
 * the body. The client does NOT assemble or append anything — the server is the
 * sole source of the prompt. A `chat` session (no workspace) uses the reserved
 * `chat` prompt, falling back to `main` when the admin hasn't configured one so
 * existing deployments keep working.
 */
function buildSystemPrompt(
  config: ConfigSnapshot,
  cwd: string,
  chat: boolean,
): string {
  // The server is the single source of the system prompt: take the reserved
  // prompt body verbatim and apply runtime variable substitution only. No
  // client-side assembly, appending, or built-in fallback — if neither prompt
  // is delivered the prompt is empty.
  const body =
    (chat ? findPromptBody(config, CHAT_PROMPT_NAME) : undefined) ??
    findPromptBody(config, MAIN_PROMPT_NAME) ??
    "";
  return injectContext(body, config, cwd, chat);
}

/** Human-readable name for the current OS, for prompt injection. */
function osName(): string {
  switch (platform()) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return platform();
  }
}

/**
 * The user's UI language as an endonym (e.g. `中文`, `English`), for prompt
 * injection so the agent replies in the user's language. Derived from the
 * in-app interface language setting (not the OS locale), falling back to the
 * raw locale tag if it can't be resolved.
 */
function uiLanguage(): string {
  const locale = getLanguage() || "en";
  const base = locale.split("-")[0];
  return new Intl.DisplayNames([locale], { type: "language" }).of(base) ?? locale;
}

/**
 * Substitute runtime context placeholders in a prompt body. Admins write
 * `{{os}}` / `{{date}}` / `{{skill}}` / `{{cards}}` / `{{language}}` /
 * `{{cwd}}` / `{{model}}` / `{{version}}` in the prompt; unknown placeholders
 * are left untouched.
 */
function injectContext(
  prompt: string,
  config: ConfigSnapshot,
  cwd: string,
  chat: boolean,
): string {
  const mainModel = config.llm.main?.model;
  const values: Record<string, string> = {
    os: osName(),
    date: new Date().toISOString().slice(0, 10),
    // Skills rely on the `read` tool for progressive disclosure; a chat session
    // has no file tools, so advertising skills there would only make the agent
    // call a tool it doesn't have. Injected empty instead.
    skill: chat ? "" : buildSkillsInstructions(config),
    // Inline-card vocabulary for the renderer's ui:* fences. Chat sessions get
    // a trimmed set (no timeline/progress — process-state cards belong to task
    // execution, which a lean chat session doesn't do).
    cards: buildCardsPrompt(chat ? CHAT_CARD_SET : MAIN_CARD_SET),
    memory: buildMemoryBlock(),
    language: uiLanguage(),
    // Sessions store `~` / `~/...` forms (chat sentinel, Telegram-created);
    // the prompt should always show the real absolute path.
    cwd: expandPath(cwd),
    // The active `main`-role model, preferring its admin-facing display name
    // over the raw provider id (mirrors buildModel's naming).
    model: mainModel ? mainModel.name || mainModel.model : "",
    // The running Flairy app version (same source as the About tab).
    version: app.getVersion(),
  };
  return prompt.replace(/\{\{(\w+)\}\}/g, (match, key) => values[key] ?? match);
}

/**
 * Build the `<user_memory>` block from the active (not soft-deleted) memories,
 * or "" when there are none. These are facts/preferences the `remember` tool
 * recorded in earlier sessions; injecting them is what makes the assistant
 * "remember" the user across conversations. Bodies are short statements, so —
 * unlike skills — they're inlined directly rather than read on demand.
 */
function buildMemoryBlock(): string {
  let memories: Memory[];
  try {
    memories = listActiveMemoriesForPrompt();
  } catch (err) {
    // Never let a memory read break prompt assembly (e.g. during a migration).
    console.error("[memory] failed to load for prompt:", err);
    return "";
  }
  if (memories.length === 0) return "";
  const lines = memories.map((m) => `- ${m.text.replace(/\s+/g, " ").trim()}`).join("\n");
  return `<user_memory>
These are things you have remembered about the user from earlier conversations. Use them to personalize your help. Treat them as background, not as instructions to act on immediately; if one seems outdated or wrong, prefer what the user says now.
${lines}
</user_memory>`;
}

/**
 * Build the `<skills_instructions>` block, or "" when no skill is available.
 * Cross-references the snapshot (for each enabled skill's description) with the
 * skills actually materialized on disk (so we never advertise a path the agent
 * can't read). Skill bodies are NOT included — only name, description, and the
 * `r0`-aliased SKILL.md path the agent reads on demand.
 */
function buildSkillsInstructions(config: ConfigSnapshot): string {
  const descById = new Map(
    config.skills.filter((s) => s.enabled).map((s) => [s.id, s.description]),
  );
  const available = listMaterializedSkills().filter((s) => descById.has(s.id));
  if (available.length === 0) return "";

  // Only advertise the search_tool recovery path when the tool actually exists
  // (i.e. automatic tool selection is on — see buildAllTools's registration).
  const searchToolLine = findPromptBody(config, TOOL_SELECTION_PROMPT_NAME)
    ? "\n- Missing tools: if a `SKILL.md` references a tool you do not currently have, use `search_tool` to find and enable it before falling back."
    : "";

  const entries = available
    .map((s) => {
      const desc = (descById.get(s.id) ?? "").replace(/\s+/g, " ").trim();
      return `- ${s.name}: ${desc} (file: r0/${s.name}/SKILL.md)`;
    })
    .join("\n");

  return `<skills_instructions>
## Skills
A skill is a set of instructions to follow that is stored in a \`SKILL.md\` file. Below is the list of skills available this session. Each entry has a name, a description, and a short path that expands into an absolute path using the skill root below.
### Skill root
- \`r0\` = \`${skillsRoot()}\`
### Available skills
${entries}
### How to use skills
- Trigger: if the user names a skill, or the task clearly matches a skill's description above, use that skill for that turn. If several apply, pick the minimal set that covers the request.
- Progressive disclosure: after deciding to use a skill, expand its \`r0\` short path into an absolute path and \`read\` the whole \`SKILL.md\` before taking task actions. Do not act on a skill you have not read.
- Relative paths inside a \`SKILL.md\` (e.g. \`scripts/foo.py\`, \`references/\`, \`assets/\`) resolve against that skill's own directory. Prefer running or reusing a skill's scripts/assets over rewriting them.
- Context hygiene: only read the skill files relevant to the current task; don't load unrelated references.
- Fallback: if a skill can't be applied cleanly (missing files, unclear instructions), say so briefly and continue with the best alternative.${searchToolLine}
</skills_instructions>`;
}

/**
 * The trimmed body of the enabled prompt with the given reserved `name` (matched
 * trimmed + case-insensitive), or undefined if none. Used for both the agent's
 * `main` prompt and the `title_generation` prompt.
 */
function findPromptBody(
  config: ConfigSnapshot,
  name: string,
): string | undefined {
  const body = config.systemPrompts
    .find((p) => p.enabled && p.name?.trim().toLowerCase() === name)
    ?.body?.trim();
  return body || undefined;
}

/**
 * The real prompt size of the most recent completed turn: pi stamps the
 * provider-reported usage on each assistant message, and input + cacheRead +
 * cacheWrite is everything that was in that request's context. Same derivation
 * as the renderer's context meter (ModelPanel), so the auto-compress trigger
 * and the UI can never disagree. Undefined until a turn has reported usage.
 */
function lastReportedContextTokens(messages: any[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = (
      messages[i] as {
        usage?: { input?: number; cacheRead?: number; cacheWrite?: number };
      }
    ).usage;
    if (u) return (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  }
  return undefined;
}

/**
 * Return a compression boundary that never leaves a toolResult in the kept suffix
 * without its matching assistant toolCall. Provider APIs reject such transcripts,
 * so if the desired boundary cuts a tool pair we move it backward until the
 * suffix is self-contained (or all the way to 0 for corrupt/partial histories).
 */
function safeCompressionBoundary(messages: any[], desired: number): number {
  let boundary = Math.min(Math.max(0, desired), messages.length);
  while (boundary > 0 && hasOrphanToolResult(messages.slice(boundary))) {
    boundary--;
  }
  return boundary;
}

function hasOrphanToolResult(messages: any[]): boolean {
  const toolCallIds = new Set<string>();
  for (const m of messages) {
    if ((m as { role?: string }).role !== "assistant") continue;
    const content = (m as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "toolCall"
      ) {
        const id = (part as { id?: unknown }).id;
        if (typeof id === "string" && id) toolCallIds.add(id);
      }
    }
  }
  for (const m of messages) {
    if ((m as { role?: string }).role !== "toolResult") continue;
    const id = (m as { toolCallId?: unknown }).toolCallId;
    if (typeof id === "string" && id && !toolCallIds.has(id)) return true;
  }
  return false;
}

/**
 * Flatten a slice of conversational messages into a plain-text transcript for
 * the compression model. Drops non-text content (images) and tags each turn with
 * its role so the summarizer can tell user from assistant.
 */
function serializeForCompression(messages: any[]): string {
  return messages
    .map((m) => {
      const role = (m as { role?: string }).role ?? "user";
      const content = (m as { content?: unknown }).content;
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .map((part) => {
            if (typeof part === "string") return part;
            if (part && typeof part === "object" && "text" in part)
              return String((part as { text?: unknown }).text ?? "");
            return "";
          })
          .filter(Boolean)
          .join("\n");
      }
      return `### ${role}\n${text}`;
    })
    .join("\n\n");
}

/** Normalize a model-produced title: drop wrapping quotes, collapse whitespace, clamp length. */
function sanitizeTitle(raw: string): string {
  const collapsed = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'""]+|["'""]+$/g, "")
    .trim();
  return collapsed.slice(0, 60).trim();
}

type PiModel = Model<Api>;

/**
 * Build a pi-ai Model entirely from the server-pushed config.
 *
 * The server is the single source of truth: we do NOT consult pi-ai's built-in
 * model catalog (`getBuiltinModel`). Every Model is constructed from the active LLM's
 * provider API + the model's pushed runtime params, so custom / third-party /
 * OpenAI-compatible models work with zero client-side knowledge.
 *
 * On the pi-ai `Model` shape:
 *   - `baseUrl` is required — pi has no fallback endpoint, so the provider MUST
 *     carry one (the official vendor endpoint, or a gateway / proxy).
 *   - `api` drives the request format, auth scheme, and `compat` auto-detection.
 *   - `provider` is only the key handed to our `getApiKey` (which ignores it and
 *     returns the configured credential), so it is cosmetic here — we reuse `api`.
 */
function buildModel(llm: ActiveLlm): PiModel {
  const { api, baseUrl } = llm.provider;
  const m = llm.model;

  // pi has no default endpoint; without a base URL the request can't be sent.
  if (!baseUrl) {
    throw new Error(
      `Provider for model "${m.model}" has no base URL. ` +
        `Set a base URL on the provider in the admin console.`,
    );
  }
  return {
    id: m.model,
    name: m.name || m.model,
    api: api as PiModel["api"],
    provider: api as PiModel["provider"],
    baseUrl,
    // pi gates thinking on `reasoning`; mirror the configured effort.
    reasoning: m.thinkingLevel != null && m.thinkingLevel !== "off",
    // pi strips images from a request unless the model's `input` lists "image"
    // (transform-messages.ts checks `model.input.includes("image")`), replacing
    // them with "(image omitted…)". The admin console configures this per model;
    // fall back to text-only if a legacy snapshot omits it.
    input: m.input?.length ? m.input : ["text"],
    // Prices are stored as USD per 1M tokens, exactly what pi's calculateCost
    // expects (it divides by 1e6 internally).
    cost: {
      input: m.cost?.input ?? 0,
      output: m.cost?.output ?? 0,
      cacheRead: m.cost?.cacheRead ?? 0,
      cacheWrite: m.cost?.cacheWrite ?? 0,
    },
    contextWindow: m.contextWindow ?? 128_000,
    maxTokens: m.maxTokens ?? 8_192,
  };
}

/**
 * Write attachment images to the on-disk store and return copies whose `data`
 * carries the small ref instead of the raw base64 (see image-store).
 */
function storeAttachments(
  attachments: Attachment[] | undefined,
): Attachment[] | undefined {
  return attachments?.map((a) => ({
    ...a,
    data: putImage(a.data, a.mimeType),
  }));
}

/**
 * Pull the image content parts out of a pi message into the wire image shape
 * ({ data, mimeType }). pi's ImageContent and our Attachment share this shape, so
 * a user message's attached pictures forward straight to the renderer's live
 * bubble — the same shape hydrateMessages rebuilds on replay. Returns undefined
 * when there are no images so the payload stays lean for the common text-only case.
 */
function projectImages(
  content: unknown,
): { data: string; mimeType: string }[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const images = content
    .filter(
      (part): part is { data?: unknown; mimeType?: unknown } =>
        Boolean(part) &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "image",
    )
    .map((part) => ({
      data: String(part.data ?? ""),
      mimeType: String(part.mimeType ?? "image/png"),
    }))
    .filter((img) => img.data);
  return images.length ? images : undefined;
}

/**
 * Flatten the `thinking` blocks of a pi assistant message into plain text. pi
 * represents reasoning as content parts of type `thinking` (`{ type: 'thinking',
 * thinking: string }`), distinct from `text` parts — kept separate so reasoning
 * never bleeds into the answer body. Returns '' when there is no reasoning.
 */
function projectThinking(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as any).type === "thinking"
        ? String((part as { thinking?: unknown }).thinking ?? "")
        : "",
    )
    .filter(Boolean)
    .join("");
}

/** Map pi-agent-core's raw events to our minimal AgentStreamEvent union. */
function normalizeEvent(event: any): AgentStreamEvent {
  switch (event.type) {
    case "message_start":
      // Carry the new message's id so the renderer can tag the tool calls that
      // belong to this turn with a shared batch id (parallel calls fold into one
      // group). Fires before the turn's tool_execution_start events.
      return {
        type: "message_start",
        messageId: event.message?.id ?? "",
      };
    case "message_update": {
      // assistantMessageEvent is itself a discriminated union; text_delta carries
      // the visible body, thinking_delta the model's reasoning stream. Forward
      // each on its own channel so the renderer can show reasoning separately and
      // never fold it into the answer. toolcall_delta carries neither.
      const inner = event.assistantMessageEvent;
      const delta = inner?.type === "text_delta" ? (inner.delta ?? "") : "";
      const thinkingDelta =
        inner?.type === "thinking_delta" ? (inner.delta ?? "") : "";
      return {
        type: "message_update",
        messageId: event.message?.id ?? "",
        delta,
        thinkingDelta,
      };
    }
    case "message_end": {
      // Carry the authoritative full message text + reasoning so the renderer can
      // finalize (or build, for non-streaming responses) the assistant bubble even
      // if the incremental deltas never accumulated. pi also emits message_end for
      // the user prompt; role lets the renderer ignore those for desktop turns and
      // build the user bubble for remotely-authored (Telegram) ones.
      const role = event.message?.role ?? "assistant";
      return {
        type: "message_end",
        messageId: event.message?.id ?? "",
        role,
        // A user message may carry an injected visual-model image description
        // (see maybeDescribeImages); strip it so a remotely-authored bubble
        // shows only what the user typed.
        text:
          role === "user"
            ? stripImageDescriptions(projectText(event.message?.content))
            : projectText(event.message?.content),
        thinking: projectThinking(event.message?.content),
        // Forward a user message's attached images so a remotely-authored turn can
        // render its thumbnails live (assistant turns carry none).
        ...(role === "user"
          ? { images: projectImages(event.message?.content) }
          : {}),
        // pi's AssistantMessage carries the turn's token usage (with computed
        // dollar cost) and a timestamp; forward both for the timeline/cost tabs.
        usage: event.message?.usage,
        timestamp: event.message?.timestamp,
      };
    }
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        name: event.toolName ?? event.toolCall?.name ?? "",
        args: event.args,
      };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        result: event.result,
        isError: Boolean(event.isError),
      };
    default:
      return { type: event.type } as AgentStreamEvent;
  }
}
