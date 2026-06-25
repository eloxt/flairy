import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { getModel, streamSimple } from "@earendil-works/pi-ai";
import {
  MAIN_PROMPT_NAME,
  TITLE_GENERATION_PROMPT_NAME,
  type ActiveLlm,
  type ConfigSnapshot,
  type Memory,
  type SyncMessage,
} from "@flairy/shared";
import { platform } from "node:os";
import {
  IPC,
  type AgentStreamEvent,
  type Attachment,
  type PermissionMode,
} from "@shared/ipc";
import { createTools, isReadOnlyTool } from "./tools";
import { createAskTool } from "./tools/ask";
import { createMemoryTool } from "./tools/memory";
import { createWebSearchTool, resolveExaService } from "./tools/web-search";
import { createWebFetchTool } from "./tools/web-fetch";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { McpManager } from "./mcp";
import { approvals } from "./approvals";
import { questions } from "./questions";
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

const BASE_SYSTEM_PROMPT = "You are Flairy, a helpful desktop coding agent.";

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
   * Tool names the user chose "Allow for this session". In-memory only and
   * scoped to this AgentService (one per session), so it's discarded when the
   * session ends — exactly "remember for this session, never persisted".
   */
  private sessionAllowed = new Set<string>();
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
   * Resolved model for the server-assigned `tool` role, or undefined when no tool
   * model is assigned. Delivered + resolved but NOT yet wired into the loop — a
   * stub for a future auxiliary-call feature. See the constructor.
   */
  private toolModel: ReturnType<typeof getModel> | undefined;

  constructor(opts: {
    sessionId: string;
    cwd: string;
    server: ServerClient;
    mcp: McpManager;
    messages?: unknown[];
  }) {
    const { sessionId, cwd, server, mcp } = opts;
    this.sessionId = sessionId;
    this.server = server;
    this.mcp = mcp;
    this.cwd = cwd;

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
        // "Full access" auto-approves everything, including mutating/MCP tools.
        if (this.permissionMode === "full") return undefined;
        if (isReadOnlyTool(name)) return undefined;
        if (this.sessionAllowed.has(name)) return undefined;

        const decision = await approvals.request({
          sessionId,
          toolName: name,
          args,
          reason: `Agent wants to run "${name}"`,
        });
        if (!decision.approved)
          return { block: true, reason: "User denied the action" };
        if (decision.scope === "session") this.sessionAllowed.add(name);
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
      if (event.type === "agent_start") this.running = true;
      if (event.type === "agent_end") this.running = false;
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
      createAskTool(this.sessionId),
      createMemoryTool(this.sessionId, (m) => this.persistMemory(m)),
    ];
    // Offer web_search only when an Exa service is configured + enabled, so the
    // model never sees a tool it can't actually use. Resolved fresh at execute
    // time from the latest server config (key never captured here).
    if (resolveExaService(this.server.getConfig())) {
      tools.push(createWebSearchTool(() => resolveExaService(this.server.getConfig())));
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
    // Resolve the live main window at send time — never a captured reference —
    // so events still reach the renderer after a close→reopen on macOS.
    getMainWindow()?.webContents.send(IPC.AgentEvent, { sessionId, event });
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
  async submit(text: string, attachments?: Attachment[]): Promise<void> {
    if (this.running) {
      // Inject as steering. Skip a truly empty submit (no text and no images) so we
      // don't push a blank user message into the running turn.
      if (text.trim() || attachments?.length) this.steer(text, attachments);
      return;
    }
    await this.prompt(text, attachments);
  }

  async prompt(text: string, attachments?: Attachment[]): Promise<void> {
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
      await this.agent.prompt(text, attachments as any);
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

  steer(text: string, attachments?: Attachment[]): void {
    // pi's ImageContent and our Attachment are the same shape ({ type: 'image',
    // data, mimeType }), so images drop straight into the user message's content
    // array next to the text part — the same array agent.prompt() builds for an
    // image prompt. With no attachments, keep the plain-string content form.
    const content =
      attachments && attachments.length > 0
        ? [{ type: "text", text }, ...attachments]
        : text;
    this.agent.steer({
      role: "user",
      content,
      timestamp: Date.now(),
    } as any);
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
    // Aborting the run won't settle a blocked `ask` Promise on its own, so
    // cancel any open question for this session — otherwise the turn hangs.
    questions.rejectSession(this.sessionId);
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
    // Settle any question still open for this session so its blocked Promise
    // resolves and no registry entries leak.
    questions.rejectSession(this.sessionId);
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
  const prompt = injectContext(base, config, cwd);
  // Append web-search citation guidance only when the tool is actually available,
  // so a config without web search doesn't carry dead instructions. Kept out of
  // the admin-editable prompt body (no placeholder needed) since it's tied to a
  // built-in capability, not to admin copy.
  return resolveExaService(config) ? `${prompt}\n\n${WEB_SEARCH_INSTRUCTIONS}` : prompt;
}

/**
 * How the agent should use `web_search` and cite its results. The renderer turns
 * the bracketed `[n]` markers into citation chips + a Sources list, resolving
 * each number against that search's results — so the numbers MUST match what the
 * tool returned, and numbering is per-search (restarts at 1 each call).
 */
const WEB_SEARCH_INSTRUCTIONS = `<web_search>
You can search the live web with the \`web_search\` tool. Use it whenever the answer depends on current events, recent facts, prices, releases, or anything you're not confident is up to date.

CITING SOURCES — REQUIRED. Whenever your answer uses information from web_search results, you MUST add inline citation markers using the id of each result you used. This is not optional — write the literal characters \`[1]\`, \`[2]\`, etc. directly in your prose, immediately after the sentence or fact each one supports. Example:

  GTA 6 will cost $79.99 for the standard edition[1], with an Ultimate Edition at $99.99[2][3].

Rules:
- Use the exact number shown for each result in the tool output (the leading \`[1]\`, \`[2]\`, …). Numbering restarts at 1 for each separate search.
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
 * `{{os}}` / `{{date}}` / `{{skill}}` / `{{language}}` / `{{cwd}}` in the prompt;
 * unknown placeholders are left untouched.
 */
function injectContext(
  prompt: string,
  config: ConfigSnapshot,
  cwd: string,
): string {
  const values: Record<string, string> = {
    os: osName(),
    date: new Date().toISOString().slice(0, 10),
    skill: buildSkillsInstructions(config),
    memory: buildMemoryBlock(),
    language: uiLanguage(),
    cwd,
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
    case "message_end":
      // Carry the authoritative full message text + reasoning so the renderer can
      // finalize (or build, for non-streaming responses) the assistant bubble even
      // if the incremental deltas never accumulated. pi also emits message_end for
      // the user prompt, so role lets the renderer ignore those.
      return {
        type: "message_end",
        messageId: event.message?.id ?? "",
        role: event.message?.role ?? "assistant",
        text: projectText(event.message?.content),
        thinking: projectThinking(event.message?.content),
        // pi's AssistantMessage carries the turn's token usage (with computed
        // dollar cost) and a timestamp; forward both for the timeline/cost tabs.
        usage: event.message?.usage,
        timestamp: event.message?.timestamp,
      };
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
