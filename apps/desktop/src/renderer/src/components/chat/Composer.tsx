import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconArrowUp, IconCheck, IconChevronDown, IconFolder, IconPaperclip, IconPlus, IconSend, IconShieldExclamation, IconShieldCheck, IconSquare, IconAlertTriangle, IconX } from "@tabler/icons-react";
import type { Attachment, PermissionMode } from "@shared/ipc";
import type { TodoItem } from "@shared/todo";
import { cn } from "@/lib/utils";
import { useChat, selectCwd, selectProjectWorkspace } from "@/store/chat-store";
import { useFileMention, FileMentionPopup } from "./file-mention";
import { useImageInputSupport } from "@/hooks/use-image-input-supported";
import { useMainModel } from "@/hooks/use-main-model";
import { ApprovalCard } from "./ApprovalCard";
import { QuestionCard } from "./QuestionCard";
import { TodoList } from "./TodoList";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { ModelHoverCardBody } from "./ModelHoverCard";

/** A picked image plus the metadata the composer shows in its preview card. */
interface PendingAttachment {
  attachment: Attachment;
  name: string;
  size: number;
}

/** Read an image File into the wire Attachment shape (raw base64, no prefix). */
function readAsAttachment(file: File, fallbackName?: string): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // strip the "data:<mime>;base64," prefix → raw base64
      const data = result.slice(result.indexOf(",") + 1);
      resolve({
        attachment: { type: "image", data, mimeType: file.type },
        name: file.name || fallbackName || "image",
        size: file.size,
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Format a byte count the way file managers do (e.g. "170.1 kB"). */
function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Human label for the working-directory button (i18n key for "home" resolved at call site). */
function cwdLabel(cwd: string | undefined): string | null {
  if (!cwd || cwd === "~") return null;
  const trimmed = cwd.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/** Strip trailing slashes so a raw session cwd matches a normalized recent path. */
function normalizeDir(path: string): string {
  return path.replace(/\/+$/, "") || path;
}

/**
 * The current plan: the most recent todo-bearing message's list (`todo_write`
 * rewrites the whole plan each call). Visibility follows the plan's lifecycle,
 * not the raw `running` flag:
 *
 * - Written THIS round (no user message after it): shown while the run is live,
 *   and it lingers after the run ends (`planAfterglow`) — as "done" or "paused"
 *   — until the user sends the next message. Reopening an old session doesn't
 *   resurrect it: afterglow is per-runtime and never persisted.
 * - Written LAST round and unfinished: shown only while a follow-up run is
 *   actually in flight (the agent may be continuing it). Once that run ends
 *   without touching it, the plan is abandoned and stays gone.
 * - Anything older (two or more user messages back) never resurfaces.
 *
 * Returns the todos array by reference — it lives on a settled tool-result
 * message, so the selector stays referentially stable across streamed tokens
 * and doesn't re-render the composer per token.
 */
function selectLiveTodos(s: {
  messages: { role: string; todos?: TodoItem[] }[];
  running: boolean;
  planAfterglow: boolean;
}): TodoItem[] | null {
  let roundsBack = 0;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const m = s.messages[i];
    if (m.todos?.length) {
      if (roundsBack === 0) {
        return s.running || s.planAfterglow ? m.todos : null;
      }
      // Previous round: only a live continuation of unfinished business shows.
      if (!s.running || m.todos.every((t) => t.status === "completed")) {
        return null;
      }
      return m.todos;
    }
    if (m.role === "user" && ++roundsBack >= 2) return null;
  }
  return null;
}

/**
 * The agent's plan, docked at the top of the composer shell while the run is
 * live (progress belongs next to where the user is watching/typing, not in a
 * side panel). The plan is a working artifact of the run: when the turn ends
 * the card leaves with it, and the thread just keeps its quiet "updated the
 * plan" tool rows.
 */
function LivePlanCard({
  todos,
  running,
}: {
  todos: TodoItem[];
  running: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  // Temporarily fold the plan away so the conversation behind it is readable.
  const [collapsed, setCollapsed] = useState(false);
  const done = todos.filter((x) => x.status === "completed").length;
  return (
    <div className="rounded-t-2xl [corner-shape:squircle] px-4 pb-2.5 pt-3">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        aria-label={collapsed ? t("common.expand") : t("common.collapse")}
        className="flex w-full items-baseline gap-2 text-xs text-muted-foreground"
      >
        <span className="font-medium text-foreground">{t("composer.plan")}</span>
        {/* Post-run status: the card lingers after the run ends, so say why. */}
        {!running && (
          <span>{done === todos.length ? t("composer.planDone") : t("composer.planPaused")}</span>
        )}
        <div className="flex-1" />
        <span className="tabular-nums">
          {done}/{todos.length}
        </span>
        <IconChevronDown
          className={cn(
            "size-3.5 self-center transition-transform duration-200",
            collapsed && "rotate-180",
          )}
          strokeWidth={2}
        />
      </button>
      {/* Grid 0fr↔1fr fold: the list stays mounted and glides shut. */}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
          collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
        )}
        inert={collapsed}
        aria-hidden={collapsed}
      >
        <div className="min-h-0 overflow-hidden">
          <TodoList todos={todos} className="mt-2 gap-1 [&_li]:text-xs [&_li]:leading-normal" />
        </div>
      </div>
    </div>
  );
}

export function Composer(): React.JSX.Element {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Individual selectors: a bare `useChat()` subscribes to the whole store and
  // re-renders the composer (textarea included) on every streamed token. The
  // function refs are stable; `running`/`permissionMode`/`recentDirs` only
  // change on real state transitions.
  const send = useChat((s) => s.send);
  const abort = useChat((s) => s.abort);
  const running = useChat((s) => s.running);
  const permissionMode = useChat((s) => s.permissionMode);
  const setPermissionMode = useChat((s) => s.setPermissionMode);
  const setWorkingDirectory = useChat((s) => s.setWorkingDirectory);
  const recentDirs = useChat((s) => s.recentDirs);
  const loadRecentDirs = useChat((s) => s.loadRecentDirs);
  const chooseWorkingDirectory = useChat((s) => s.chooseWorkingDirectory);
  const removeRecentDir = useChat((s) => s.removeRecentDir);

  // The directory in effect (open session's, or the pending pick on home).
  const cwd = useChat(selectCwd) ?? undefined;

  // Telegram-created sessions are read-only on desktop (driven only from Telegram).
  const readOnly = useChat((s) => !!s.sessions.find((x) => x.id === s.sessionId)?.fromTelegram);

  // A session's workspace is fixed once set: show it, but don't offer the picker.
  const workspaceLocked = useChat(
    (s) => !!s.sessions.find((x) => x.id === s.sessionId)?.workspacePath,
  );

  // The workspace + permission row belongs to projects only. A plain chat has no
  // folder and no file/shell tools, so both controls are noise there — projects
  // are started from the sidebar's Projects "+" instead. On the home screen a
  // pending folder pick means the next message opens a project session.
  const isProject = useChat((s) => (s.sessionId ? false : !!s.pendingCwd)) || workspaceLocked;

  // Root for `@` file mentions: the session's workspace, or on the home screen
  // the pending pick (fs:list-files accepts it — every pick lands in recents).
  const mentionRoot = useChat((s) =>
    s.sessionId ? selectProjectWorkspace(s) : s.pendingCwd,
  );

  // Interaction cards docked in the composer shell: the pending `ask` question
  // and tool approval (each the head of its queue) and the live plan while a
  // run is in flight.
  const question = useChat((s) => s.questionQueue[0]);
  const approval = useChat((s) => s.approvalQueue[0]);
  const approvalsQueued = useChat((s) => s.approvalQueue.length - 1);
  const liveTodos = useChat(selectLiveTodos);
  const showPlan = !!liveTodos;

  // Publish the composer's live height so the message list can reserve matching
  // bottom space and never let content hide behind the floating composer.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const publish = (): void => {
      document.documentElement.style.setProperty(
        "--composer-h",
        `${el.offsetHeight}px`,
      );
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Grow the textarea with content up to a ceiling, then scroll.
  const autosize = (el: HTMLTextAreaElement): void => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  };

  // `@` file mentions (workspace sessions only — mentionRoot is null in chats).
  const mention = useFileMention({
    root: mentionRoot,
    taRef,
    onApplyText: (next) => {
      setText(next);
      // The controlled value lands on the next commit; size to it then.
      requestAnimationFrame(() => {
        if (taRef.current) autosize(taRef.current);
      });
    },
  });

  const submit = (): void => {
    if (!canSend) return;
    const wire = attachments.map((a) => a.attachment);
    // Carry the "model can't read these images" verdict captured now, so the sent
    // bubble can show it after the composer (and its banner) clears.
    void send(text, wire.length ? wire : undefined, { imagesIgnored });
    setText("");
    setAttachments([]);
    mention.close();
    // Reset the auto-grown height after sending.
    if (taRef.current) taRef.current.style.height = "auto";
  };

  const onPickFiles = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const files = Array.from(e.target.files ?? []);
    // Reset so picking the same file again still fires onChange.
    e.target.value = "";
    if (files.length === 0) return;
    // Await every read before adding chips so submit can't race ahead.
    const next = await Promise.all(files.map((f) => readAsAttachment(f)));
    setAttachments((a) => [...a, ...next]);
  };

  // Pull image files out of a clipboard paste and add them as attachments.
  const onPaste = async (
    e: React.ClipboardEvent<HTMLTextAreaElement>,
  ): Promise<void> => {
    const images = Array.from(e.clipboardData.files).filter((f) =>
      f.type.startsWith("image/"),
    );
    if (images.length === 0) return;
    // Keep the pasted image out of the text box (it would insert nothing useful).
    e.preventDefault();
    // Clipboard images come without a filename; synthesize one per image.
    const next = await Promise.all(
      images.map((f, i) =>
        readAsAttachment(
          f,
          `pasted-image-${i + 1}.${f.type.split("/")[1] || "png"}`,
        ),
      ),
    );
    setAttachments((a) => [...a, ...next]);
  };

  // Text or images. Valid both for an idle prompt and a steer into a running
  // turn — a steer carries images too (AgentService.steer), so the rule is the same.
  const canSend = text.trim().length > 0 || attachments.length > 0;

  // The active config's image capability (server-driven). When the main model
  // can't take images we still let the user attach + send, but warn: with a
  // visual model assigned the pictures are described by it (lossy), and with
  // none they're dropped from the request — otherwise they'd silently vanish
  // or degrade with no explanation.
  const imageSupport = useImageInputSupport();
  const { current: mainModel, options: modelOptions, preferredId, setPreferred } = useMainModel();
  const imageSupported = imageSupport !== "unsupported";
  const imagesIgnored = attachments.length > 0 && imageSupport === "unsupported";
  const imagesExtracted = attachments.length > 0 && imageSupport === "extract";

  // Read-only Telegram session: show a notice instead of the input. rootRef stays
  // so the message list still reserves matching bottom space.
  if (readOnly) {
    return (
      <div ref={rootRef} className="pointer-events-none absolute bottom-0 left-0 right-0 pt-10">
        <div className="pointer-events-auto mx-auto w-full max-w-(--composer-width) px-6">
          <div className="bg-linear-to-t from-background via-background to-transparent pb-5">
            <div className="flex items-center justify-center gap-2 rounded-2xl [corner-shape:squircle] border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
              <IconSend className="size-4 shrink-0" />
              <span>{t('composer.telegramReadOnly')}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="pointer-events-none absolute bottom-0 left-0 right-0 pt-10"
    >
      <div className="pointer-events-auto mx-auto w-full max-w-(--composer-width) px-6">
        <div className="bg-linear-to-t from-background via-background to-transparent pb-5">
          <div className="relative rounded-2xl [corner-shape:squircle] border border-border bg-muted">
            {/* `@` file suggestions, floating above the shell (absolute, so the
                published --composer-h never includes it). */}
            <FileMentionPopup mention={mention} />
            {/* Interaction cards slide out of the shell above the input: plan
                progress on top, the question card below it (closer to the input,
                waiting on the user's next action). Question keyed per request so
                a new ask resets the card's answer state. */}
            {showPlan && (
              <div className="animate-in fade-in slide-in-from-bottom-2 duration-300">
                <LivePlanCard todos={liveTodos} running={running} />
              </div>
            )}
            {question && (
              <div
                key={question.questionId}
                className="animate-in fade-in slide-in-from-bottom-2 duration-300"
              >
                <QuestionCard payload={question} />
              </div>
            )}
            {/* Approval queue: the head renders, the rest wait behind the count
                hint; keying by approvalId resets the Details toggle per call. */}
            {approval && (
              <div
                key={approval.approvalId}
                className="animate-in fade-in slide-in-from-bottom-2 duration-300"
              >
                <ApprovalCard payload={approval} queuedCount={approvalsQueued} />
              </div>
            )}
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 p-1.5">
                {attachments.map((a, i) => (
                  <div
                    key={i}
                    className="group/att relative flex items-center gap-2.5 rounded-2xl [corner-shape:squircle] border border-border bg-card p-1.5 pr-8"
                  >
                    <img
                      src={`data:${a.attachment.mimeType};base64,${a.attachment.data}`}
                      alt={a.name}
                      className="size-11 shrink-0 rounded-2xl [corner-shape:squircle] object-cover"
                    />
                    <div className="min-w-0 pr-1">
                      <div className="max-w-40 truncate text-xs font-medium text-foreground">
                        {a.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {formatBytes(a.size)}
                      </div>
                    </div>
                    <button
                      onClick={() =>
                        setAttachments((prev) =>
                          prev.filter((_, j) => j !== i),
                        )
                      }
                      aria-label={t('composer.removeAttachment')}
                      className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-xl [corner-shape:squircle] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <IconX className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {imagesIgnored && (
              <div className="mx-2 mb-1.5 flex items-start gap-2 rounded-2xl [corner-shape:squircle] bg-destructive/10 px-3 py-2 text-xs leading-snug text-destructive">
                <IconAlertTriangle className="mt-px size-3.5 shrink-0" />
                <span>{t("composer.imagesIgnored")}</span>
              </div>
            )}

            {imagesExtracted && (
              <div className="mx-2 mb-1.5 flex items-start gap-2 rounded-2xl [corner-shape:squircle] bg-amber-500/10 px-3 py-2 text-xs leading-snug text-amber-600 dark:text-amber-500">
                <IconAlertTriangle className="mt-px size-3.5 shrink-0" />
                <span>{t("composer.imagesExtracted")}</span>
              </div>
            )}

            <div className="group relative -m-px flex flex-col rounded-2xl [corner-shape:squircle] border border-foreground/15 bg-background shadow-xs transition-colors focus-within:border-foreground/25">
            <textarea
              ref={taRef}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                autosize(e.currentTarget);
              }}
              onKeyDown={(e) => {
                // Ignore Enter while a CJK IME is composing (it confirms the
                // candidate text, not the message). keyCode 229 covers browsers
                // that don't set isComposing on the Enter keydown.
                if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                // The open mention popup owns arrows/Enter/Tab/Escape.
                if (mention.onKeyDown(e)) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              // Fires on every caret move (typing included) — the one hook
              // point that keeps the `@` token tracking the live cursor.
              onSelect={mention.refresh}
              onBlur={mention.close}
              onPaste={(e) => void onPaste(e)}
              placeholder={t('composer.placeholder')}
              rows={1}
              className="block max-h-50 w-full resize-none bg-transparent px-4 py-3.5 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/70 focus:outline-none"
            />

            <div className="flex items-center gap-1 px-2 pb-2">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={onPickFiles}
              />

              {/* Add attachment */}
              <Tooltip>
                <TooltipTrigger
                  onClick={() => fileRef.current?.click()}
                  aria-label={t('composer.addImage')}
                  className="flex size-8 items-center justify-center rounded-2xl [corner-shape:squircle] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <IconPaperclip className="size-4" />
                </TooltipTrigger>
                <TooltipContent>
                  {imageSupported
                    ? t('composer.addImage')
                    : t('composer.imageUnsupported')}
                </TooltipContent>
              </Tooltip>

              {/* Main-model picker: only when the admin flagged candidate
                  models (hidden in local mode / before the first snapshot). */}
              {modelOptions.length > 0 && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    openOnHover
                    aria-label={t('composer.model')}
                    className="flex h-8 items-center gap-1.5 rounded-2xl [corner-shape:squircle] px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <span className="max-w-36 truncate">
                      {mainModel?.model.name ?? t('composer.modelDefault')}
                    </span>
                    <IconChevronDown className="size-3 opacity-60" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-72">
                    <DropdownMenuRadioGroup
                      value={preferredId ?? "default"}
                      onValueChange={(v) => setPreferred(v === "default" ? null : v)}
                    >
                      <DropdownMenuRadioItem
                        closeOnClick
                        value="default"
                        className="items-start gap-2.5 py-2"
                      >
                        <div className="flex flex-col gap-0.5">
                          <span className="font-medium text-foreground">
                            {t('composer.modelDefault')}
                          </span>
                          <span className="text-xs leading-snug text-muted-foreground">
                            {t('composer.modelDefaultDescription')}
                          </span>
                        </div>
                      </DropdownMenuRadioItem>
                      <DropdownMenuSeparator />
                      {modelOptions.map((o) => (
                        // Hovering a candidate opens a details card beside the
                        // menu (context window, prices, models.dev facts).
                        <HoverCard key={o.model.id}>
                          {/* delay/closeDelay live on the Trigger in base-ui,
                              same as the Menu hover props. */}
                          <HoverCardTrigger
                            delay={300}
                            closeDelay={100}
                            render={
                              <DropdownMenuRadioItem
                                closeOnClick
                                value={o.model.id}
                                className="items-start gap-2.5 py-2"
                              >
                                <div className="flex flex-col gap-0.5">
                                  <span className="font-medium text-foreground">
                                    {o.model.name}
                                  </span>
                                </div>
                              </DropdownMenuRadioItem>
                            }
                          />
                          <HoverCardContent
                            side="right"
                            align="start"
                            sideOffset={10}
                            className="w-64"
                          >
                            <ModelHoverCardBody option={o} />
                          </HoverCardContent>
                        </HoverCard>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}

              <div className="flex-1" />

              {running && !canSend ? (
                // Running with an empty composer → Stop. Add text or an image and
                // the button becomes Send again, routing the content to the running
                // turn as a steering message (main decides; see AgentService.submit).
                <button
                  onClick={abort}
                  aria-label={t('composer.stop')}
                  className="flex size-9 items-center justify-center rounded-2xl [corner-shape:squircle] bg-secondary text-secondary-foreground transition-colors hover:bg-accent active:translate-y-px"
                >
                  <IconSquare className="size-3.5 fill-current" strokeWidth={0} />
                </button>
              ) : (
                <button
                  onClick={submit}
                  disabled={!canSend}
                  aria-label={running ? t('composer.steer') : t('composer.send')}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-2xl [corner-shape:squircle] transition-all active:translate-y-px",
                    canSend
                      ? "bg-primary text-primary-foreground hover:opacity-90"
                      : "cursor-not-allowed bg-muted text-muted-foreground",
                  )}
                >
                  <IconArrowUp className="size-4" strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>

          {isProject && (
          <div className="flex items-center gap-1 px-2 py-1.5">
            {/* Working directory: hover to open recents, or add another. Fixed
                once the session has a workspace — render a static label then. */}
            {workspaceLocked ? (
              <div
                aria-label={t('composer.workingDirectory')}
                title={t('composer.workspaceLockedTitle', { path: cwd ?? "~" })}
                className="flex h-8 items-center gap-1.5 rounded-2xl [corner-shape:squircle] px-2 text-xs text-muted-foreground"
              >
                <IconFolder className="size-4" />
                <span className="max-w-32 truncate">{cwdLabel(cwd) ?? t('composer.home')}</span>
              </div>
            ) : (
            <DropdownMenu
              onOpenChange={(open) => {
                if (open) void loadRecentDirs();
              }}
            >
              <DropdownMenuTrigger
                openOnHover
                aria-label={t('composer.workingDirectory')}
                title={t('composer.workingDirectoryTitle', { path: cwd ?? "~" })}
                className="flex h-8 items-center gap-1.5 rounded-2xl [corner-shape:squircle] px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <IconFolder className="size-4" />
                <span className="max-w-32 truncate">{cwdLabel(cwd) ?? t('composer.home')}</span>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-56">
                {recentDirs.length > 0 && (
                  <>
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{t('composer.recent')}</DropdownMenuLabel>
                      {recentDirs.map((dir) => (
                        <DropdownMenuItem
                          key={dir}
                          title={t('composer.recentDirTitle', { path: dir })}
                          onClick={() => void chooseWorkingDirectory(dir)}
                          onContextMenu={(e) => {
                            // Right-click pops the OS-native menu; only remove
                            // this recent directory if the user picks "remove".
                            e.preventDefault();
                            void window.api.showRecentDirMenu().then((action) => {
                              if (action === "remove") void removeRecentDir(dir);
                            });
                          }}
                          className="items-start gap-2"
                        >
                          <IconCheck
                            className={cn(
                              "mt-0.5 size-4 shrink-0",
                              normalizeDir(dir) === normalizeDir(cwd ?? "")
                                ? "opacity-100"
                                : "opacity-0",
                            )}
                          />
                          <div className="flex min-w-0 flex-col">
                            <span className="truncate">{cwdLabel(dir)}</span>
                            <span className="truncate text-xs text-muted-foreground">
                              {dir}
                            </span>
                          </div>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={() => void setWorkingDirectory()}>
                  <IconPlus className="size-4" />
                  {t('composer.addAnotherDirectory')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            )}

            {/* Tool permission */}
            <DropdownMenu>
              <DropdownMenuTrigger
                openOnHover
                aria-label={t('composer.toolPermission')}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-2xl [corner-shape:squircle] px-2 text-xs transition-colors hover:bg-accent",
                  permissionMode === "full"
                    ? "text-destructive hover:text-destructive"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {permissionMode === "full" ? (
                  <IconShieldExclamation className="size-4" />
                ) : (
                  <IconShieldCheck className="size-4" />
                )}
                <span>
                  {permissionMode === "full" ? t('composer.fullAccess') : t('composer.askForApproval')}
                </span>
                <IconChevronDown className="size-3 opacity-60" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                <DropdownMenuRadioGroup
                  value={permissionMode}
                  onValueChange={(v) => setPermissionMode(v as PermissionMode)}
                >
                  <DropdownMenuRadioItem
                    closeOnClick
                    value="ask"
                    className="items-start gap-2.5 py-2"
                  >
                    <IconShieldCheck className="mt-0.5 size-4 text-muted-foreground" />
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-foreground">
                        {t('composer.askForApproval')}
                      </span>
                      <span className="text-xs leading-snug text-muted-foreground">
                        {t('composer.askDescription')}
                      </span>
                    </div>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem
                    closeOnClick
                    value="full"
                    className="items-start gap-2.5 py-2"
                  >
                    <IconShieldExclamation className="mt-0.5 size-4 text-destructive" />
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-destructive">
                        {t('composer.fullAccess')}
                      </span>
                      <span className="text-xs leading-snug text-muted-foreground">
                        {t('composer.fullDescription')}
                      </span>
                    </div>
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
