import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { getModel, streamSimple } from "@earendil-works/pi-ai";
import {
  IMAGE_DESCRIPTION_PROMPT_NAME,
  MAIN_PROMPT_NAME,
  TITLE_GENERATION_PROMPT_NAME,
  type ActiveLlm,
  type ConfigSnapshot,
  type Memory,
  type SyncMessage,
} from "@flairy/shared";
import {
  encodeImageDescriptions,
  stripImageDescriptions,
} from "@shared/image-description";
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
import { createWebSearchTool, resolveExaService } from "./tools/web-search";
import { createWebFetchTool } from "./tools/web-fetch";
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
} from "../store/db";
import { getMainWindow, broadcast } from "../windows";
import { getLanguage } from "../locale";
import type { ServerClient } from "../sync/server-client";
import {
  DESKTOP_ORIGIN,
  type TurnOrigin,
  type AgentEventInternalEnvelope,
} from "./turn-origin";

const BASE_SYSTEM_PROMPT = "You are Flairy, a helpful desktop coding agent.";

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
  /**
   * Resolved model for the server-assigned `tool` role, or undefined when no tool
   * model is assigned. Delivered + resolved but NOT yet wired into the loop — a
   * stub for a future auxiliary-call feature. See the constructor.
   */
  private toolModel: ReturnType<typeof getModel> | undefined;
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

    const config = server.getConfig();
    if (!config || !config.llm.main) {
      // Mirrors the old "no key configured" guard: without a `main` role model we
      // have no model + no credential, so we can't run the agent yet.
      throw new Error(
        "No active model configured yet; sign in and wait for sync",
      );
    }
    const mainLlm = config.llm.main;

    // The `tool` role is delivered and resolved but has no consumer yet — kept as
    // a stub so a future auxiliary-call feature (e.g. a cheaper tool/summarizer
    // model) can pick it up without re-plumbing config. See getToolModel().
    this.toolModel = config.llm.tool ? buildModel(config.llm.tool) : undefined;

    this.agent = new Agent({
      // Credential is resolved per-request from the latest server config — never
      // embedded in the model object or sent to the renderer.
      getApiKey: () => server.getConfig()?.llm.main?.provider.credential,
      // Coalesce rapid steers: drain ALL queued steering messages together at the
      // next turn boundary instead of pi's default one-per-turn, which would
      // otherwise spread a quick burst of redirects across several turns.
      steeringMode: "all",
      initialState: {
        systemPrompt: buildSystemPrompt(config, cwd),
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
      // Only forward roles the LLM should see.
      convertToLlm: (messages: any[]) =>
        messages.filter((m) =>
          ["user", "assistant", "toolResult"].includes(m.role),
        ),
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

    // Forward every pi event to the renderer, tagged with sessionId.
    this.unsubscribe = this.agent.subscribe((event: any) => {
      // pi has no top-level "error" AgentEvent: a failed stream surfaces as an
      // inner assistantMessageEvent of type "error". Lift it to a visible error.
      const inner = event?.assistantMessageEvent;
      if (event.type === "message_update" && inner?.type === "error") {
        const msg =
          inner.error?.errorMessage ?? `LLM stream ${inner.reason ?? "error"}`;
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
        this.running = false;
        this.send(sessionId, {
          type: "error",
          message: endMsg.errorMessage ?? "LLM request failed",
        });
        return;
      }
      // Keep the run-state flag in lockstep with the lifecycle events the
      // renderer also keys off, so isRunning() matches what the UI shows.
      if (event.type === "agent_start") {
        this.running = true;
        // New turn: restart per-turn web-search citation numbering.
        this.searchIdOffset = 0;
      }
      if (event.type === "agent_end") {
        this.running = false;
        // The turn is over: drop any Telegram gate-escalation so the next
        // (possibly desktop-only) turn re-evaluates the gate from scratch.
        this.gatedByTelegram = false;
      }
      this.send(sessionId, normalizeEvent(event));
      // Persist on turn boundaries so a crash doesn't lose history.
      if (event.type === "turn_end" || event.type === "agent_end") {
        void this.persist();
      }
    });
  }

  /**
   * Assemble the agent's tool set: the local coding tools, the `ask` tool (which
   * needs `win` + `sessionId` to round-trip a question to the renderer), and the
   * live MCP tools. Used at all three injection points (constructor, MCP
   * tool-change rebuild, setCwd rebuild) so `ask` is always present.
   */
  private buildTools(cwd: string): AgentTool<any>[] {
    const tools: AgentTool<any>[] = [
      ...createTools(cwd),
      // Resolve origin + channel at CALL time (not here at build time) so an
      // `ask` routes to the front-end that authored the turn currently running.
      createAskTool(this.sessionId, () => ({
        origin: this.activeTurnOrigin,
        channel: this.resolveChannel(this.activeTurnOrigin),
      })),
      createMemoryTool(this.sessionId, (m) => this.persistMemory(m)),
      createTodoTool(),
    ];
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
          }
        )
      );
      tools.push(createWebFetchTool(() => resolveExaService(this.server.getConfig())));
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

  /** Snapshot messages to SQLite and mirror them to the server. */
  private async persist(): Promise<void> {
    // A terminal event can land after dispose() (session deleted); skip so we
    // don't re-insert a messages row for a session that's already gone.
    if (this.disposed) return;
    const messages = this.agent.state.messages;
    await saveMessages(this.sessionId, messages);
    this.syncToServer(messages);
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
    if (!meta) return;
    const synced = messages.map(toSyncMessage);
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
    // First user message in a fresh session → generate a title from it. Capture
    // "is first" BEFORE agent.prompt mutates state.messages, and fire it off
    // before the await so it runs in parallel with (never blocks) the turn.
    const isFirst = this.agent.state.messages.length === 0;
    if (isFirst && !this.titleGenerated && text.trim()) {
      void this.maybeGenerateTitle(text);
    }
    // Mark running up front so a session reopened before the first event still
    // reports as running; agent_start/agent_end keep it accurate thereafter.
    this.running = true;
    try {
      // With a text-only main model + an assigned `visual` model, extract a text
      // description of the images first and ride it on the same user message
      // (see maybeDescribeImages). Adds latency before the turn starts, but
      // that's inherent: the description must exist before the main model runs.
      const description = await this.maybeDescribeImages(attachments);
      if (description && attachments?.length) {
        await this.agent.prompt({
          role: "user",
          content: [
            { type: "text", text },
            ...attachments,
            { type: "text", text: encodeImageDescriptions(description) },
          ],
          timestamp: Date.now(),
        } as any);
      } else {
        await this.agent.prompt(text, attachments as any);
      }
    } catch (err) {
      this.running = false;
      // A rejected run (bad credential, provider/baseUrl, network) would
      // otherwise vanish silently — surface it as a visible error event.
      this.send(this.sessionId, {
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Generate a session title from the user's first message using the
   * server-delivered `title_generation` system prompt and the `tool`-role model
   * (falling back to `main`). Best-effort: any failure keeps the default title
   * and never surfaces a chat error. Runs in parallel with the agent turn.
   */
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
        { apiKey: llm.provider.credential, maxTokens: 64 },
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
        this.agent.steer({
          role: "user",
          content: [
            { type: "text", text },
            ...attachments,
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
        { apiKey: visual.provider.credential, maxTokens: 2048 },
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
   * The resolved `tool`-role model, if the server assigned one. Stub accessor: no
   * caller consumes it yet (see constructor). Exposed so a future auxiliary-call
   * feature can use a separate, server-configured model without re-plumbing.
   */
  getToolModel(): ReturnType<typeof getModel> | undefined {
    return this.toolModel;
  }

  /**
   * Rebind the working directory: rebuild the local tools against `cwd` and swap
   * them onto the live agent, preserving the MCP tools. Assigning `state.tools`
   * is the sanctioned pi-agent-core injection point (copy-on-assign semantics).
   * Also refresh the system prompt so its injected `{{cwd}}` stays accurate.
   */
  setCwd(cwd: string): void {
    this.cwd = cwd;
    this.agent.state.tools = this.buildTools(cwd);
    const config = this.server.getConfig();
    if (config) this.agent.state.systemPrompt = buildSystemPrompt(config, cwd);
  }

  abort(): void {
    this.running = false;
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
    this.agent.abort();
    // Settle any interaction still open for this session so its blocked Promise
    // resolves and no registry entries leak. Routed through the injected fan-out
    // so it covers approvals + questions (+ the Telegram channel later).
    this.onRejectInteractions(this.sessionId);
    this.unsubscribe?.();
    this.mcpUnsub?.();
  }
}

/**
 * Assemble the agent system prompt: the configured base prompt followed by a
 * `<skills_instructions>` block that ADVERTISES the available skills (name +
 * description + on-disk path) rather than inlining their bodies.
 *
 * The config snapshot only carries lightweight `SkillSummary` rows (no body),
 * and skills can be large — so instead of pasting every SKILL.md into the
 * prompt, we follow progressive disclosure: list each materialized skill and let
 * the model `read` the SKILL.md on demand when a task matches. The skills dir is
 * exposed to the read-only tools as an extra root (see tools/index.ts), so the
 * `r0`-aliased paths below are readable regardless of the session cwd.
 */
function buildSystemPrompt(config: ConfigSnapshot, cwd: string): string {
  // The reserved `main` prompt is the agent's base prompt; fall back to the
  // built-in default when it's absent or disabled. Runtime context (OS, date,
  // skills, language, cwd) is injected via placeholder substitution.
  const base = findPromptBody(config, MAIN_PROMPT_NAME) ?? BASE_SYSTEM_PROMPT;
  // Always append the todo guidance: `todo_write` is a built-in tool present in
  // every session (unlike web search), so the agent should know when to plan.
  let prompt = `${injectContext(base, config, cwd)}\n\n${TODO_INSTRUCTIONS}`;
  // Append web-search citation guidance only when the tool is actually available,
  // so a config without web search doesn't carry dead instructions. Kept out of
  // the admin-editable prompt body (no placeholder needed) since it's tied to a
  // built-in capability, not to admin copy.
  if (resolveExaService(config)) prompt = `${prompt}\n\n${WEB_SEARCH_INSTRUCTIONS}`;
  return prompt;
}

/**
 * How and when the agent should use `todo_write` to plan. The renderer turns the
 * latest call into an inline checklist + a Plan tab, so a good plan is also the
 * user's progress view. Tied to the built-in tool, not admin copy, so it lives
 * here rather than in the editable prompt body.
 */
const TODO_INSTRUCTIONS = `<task_planning>
For non-trivial, multi-step work, use the \`todo_write\` tool to plan and track your progress — it gives the user a live checklist of what you're doing.
- At the start of such a task, call \`todo_write\` with the full ordered list of steps (each \`status: "pending"\`).
- Pass the COMPLETE list every time you call it: it replaces the previous list, it does not append.
- Keep EXACTLY ONE item \`"in_progress"\` at a time, and flip an item to \`"completed"\` the moment it's done — before starting the next.
- Skip it entirely for trivial single-step requests, greetings, or pure questions; only plan when it genuinely helps.
</task_planning>`;

/**
 * How the agent should use `web_search` and cite its results. The renderer turns
 * the bracketed `[n]` markers into citation chips + a Sources list, resolving
 * each number against the turn's merged search results — so the numbers MUST
 * match what the tool returned. Ids are unique across a turn (a second search
 * continues numbering, it does not restart at 1).
 */
const WEB_SEARCH_INSTRUCTIONS = `<web_search>
You can search the live web with the \`web_search\` tool. Use it whenever the answer depends on current events, recent facts, prices, releases, or anything you're not confident is up to date.

CITING SOURCES — REQUIRED. Whenever your answer uses information from web_search results, you MUST add inline citation markers using the id of each result you used. This is not optional — write the literal characters \`[1]\`, \`[2]\`, etc. directly in your prose, immediately after the sentence or fact each one supports. Example:

  GTA 6 will cost $79.99 for the standard edition[1], with an Ultimate Edition at $99.99[2][3].

Rules:
- Use the exact number shown for each result in the tool output (the leading \`[1]\`, \`[2]\`, …). Ids stay unique across your whole reply: a later search keeps counting up (e.g. \`[11]\`, \`[12]\`), it does NOT restart at 1 — always cite the number actually shown.
- Place each marker right after the specific claim it backs — never collect them all at the end, and never invent a "Sources" section yourself (the app renders one).
- Combine markers like \`[1][2]\` when several results support the same point.
- Only cite numbers that actually appear in the results you received.
</web_search>`;

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
 * `{{os}}` / `{{date}}` / `{{skill}}` / `{{language}}` / `{{cwd}}` /
 * `{{model}}` / `{{version}}` in the prompt; unknown placeholders are left
 * untouched.
 */
function injectContext(
  prompt: string,
  config: ConfigSnapshot,
  cwd: string,
): string {
  const mainModel = config.llm.main?.model;
  const values: Record<string, string> = {
    os: osName(),
    date: new Date().toISOString().slice(0, 10),
    skill: buildSkillsInstructions(config),
    memory: buildMemoryBlock(),
    language: uiLanguage(),
    cwd,
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
- Fallback: if a skill can't be applied cleanly (missing files, unclear instructions), say so briefly and continue with the best alternative.
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
    .find((p) => p.enabled && p.name.trim().toLowerCase() === name)
    ?.body.trim();
  return body || undefined;
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

type PiModel = NonNullable<ReturnType<typeof getModel>>;

/**
 * Build a pi-ai Model entirely from the server-pushed config.
 *
 * The server is the single source of truth: we do NOT consult pi-ai's built-in
 * model registry (`getModel`). Every Model is constructed from the active LLM's
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

/** Map a pi-agent-core message to the wire SyncMessage shape. */
function toSyncMessage(raw: unknown): SyncMessage {
  const m = raw as {
    id?: string;
    role?: string;
    content?: unknown;
    timestamp?: number;
  };
  return {
    id: m.id ?? crypto.randomUUID(),
    role: normalizeRole(m.role),
    text: projectText(m.content),
    timestamp: m.timestamp ?? Date.now(),
    raw,
  };
}

/** Coerce a pi role into the SyncMessage role union (default: assistant). */
function normalizeRole(role: string | undefined): SyncMessage["role"] {
  if (role === "user" || role === "assistant" || role === "toolResult")
    return role;
  return "assistant";
}

/** Flatten pi message content into a plain-text projection for search/display. */
function projectText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
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
