import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Folder,
  Paperclip,
  Plus,
  Send,
  ShieldAlert,
  ShieldCheck,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Attachment, PermissionMode } from "@shared/ipc";
import { cn } from "@/lib/utils";
import { useChat, selectCwd } from "@/store/chat-store";
import { useImageInputSupported } from "@/hooks/use-image-input-supported";
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

export function Composer(): React.JSX.Element {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const {
    send,
    abort,
    running,
    permissionMode,
    setPermissionMode,
    setWorkingDirectory,
    recentDirs,
    loadRecentDirs,
    chooseWorkingDirectory,
    removeRecentDir,
  } = useChat();

  // The directory in effect (open session's, or the pending pick on home).
  const cwd = useChat(selectCwd) ?? undefined;

  // Telegram-created sessions are read-only on desktop (driven only from Telegram).
  const readOnly = useChat((s) => !!s.sessions.find((x) => x.id === s.sessionId)?.fromTelegram);

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

  const submit = (): void => {
    if (!canSend) return;
    const wire = attachments.map((a) => a.attachment);
    // Carry the "model can't read these images" verdict captured now, so the sent
    // bubble can show it after the composer (and its banner) clears.
    void send(text, wire.length ? wire : undefined, { imagesIgnored });
    setText("");
    setAttachments([]);
    // Reset the auto-grown height after sending.
    if (taRef.current) taRef.current.style.height = "auto";
  };

  // Grow the textarea with content up to a ceiling, then scroll.
  const autosize = (el: HTMLTextAreaElement): void => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
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

  // The active model's image capability (server-driven). When it can't take
  // images we still let the user attach + send, but warn that pi will drop the
  // pictures before the request — otherwise they'd vanish with no explanation.
  const imageSupported = useImageInputSupported();
  const imagesIgnored = attachments.length > 0 && !imageSupported;

  // Read-only Telegram session: show a notice instead of the input. rootRef stays
  // so the message list still reserves matching bottom space.
  if (readOnly) {
    return (
      <div ref={rootRef} className="pointer-events-none absolute bottom-0 left-0 right-0 pt-10">
        <div className="pointer-events-auto mx-auto w-full max-w-200 px-6">
          <div className="bg-linear-to-t from-background via-background to-transparent pb-5">
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-border bg-card px-4 py-3 text-sm text-muted-foreground">
              <Send className="size-4 shrink-0" />
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
      <div className="pointer-events-auto mx-auto w-full max-w-200 px-6">
        <div className="bg-linear-to-t from-background via-background to-transparent pb-5">
          <div className="group relative flex flex-col rounded-2xl border border-border bg-card transition-colors focus-within:border-foreground/25">
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3 pt-3">
                {attachments.map((a, i) => (
                  <div
                    key={i}
                    className="group/att relative flex items-center gap-2.5 rounded-xl border border-border bg-muted/50 p-1.5 pr-8"
                  >
                    <img
                      src={`data:${a.attachment.mimeType};base64,${a.attachment.data}`}
                      alt={a.name}
                      className="size-11 shrink-0 rounded-lg object-cover"
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
                      className="absolute right-1.5 top-1/2 flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {imagesIgnored && (
              <div className="mx-3 mt-3 flex items-start gap-2 rounded-xl bg-destructive/10 px-3 py-2 text-xs leading-snug text-destructive">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                <span>{t("composer.imagesIgnored")}</span>
              </div>
            )}

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
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
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
                  className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Paperclip className="size-4" />
                </TooltipTrigger>
                <TooltipContent>
                  {imageSupported
                    ? t('composer.addImage')
                    : t('composer.imageUnsupported')}
                </TooltipContent>
              </Tooltip>

              {/* Working directory: hover to open recents, or add another */}
              <DropdownMenu
                onOpenChange={(open) => {
                  if (open) void loadRecentDirs();
                }}
              >
                <DropdownMenuTrigger
                  openOnHover
                  aria-label={t('composer.workingDirectory')}
                  title={t('composer.workingDirectoryTitle', { path: cwd ?? "~" })}
                  className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <Folder className="size-4" />
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
                            <Check
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
                    <Plus className="size-4" />
                    {t('composer.addAnotherDirectory')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Tool permission */}
              <DropdownMenu>
                <DropdownMenuTrigger
                  openOnHover
                  aria-label={t('composer.toolPermission')}
                  className={cn(
                    "flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs transition-colors hover:bg-accent",
                    permissionMode === "full"
                      ? "text-destructive hover:text-destructive"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {permissionMode === "full" ? (
                    <ShieldAlert className="size-4" />
                  ) : (
                    <ShieldCheck className="size-4" />
                  )}
                  <span>
                    {permissionMode === "full" ? t('composer.fullAccess') : t('composer.askForApproval')}
                  </span>
                  <ChevronDown className="size-3 opacity-60" />
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
                      <ShieldCheck className="mt-0.5 size-4 text-muted-foreground" />
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
                      <ShieldAlert className="mt-0.5 size-4 text-destructive" />
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

              <div className="flex-1" />

              {running && !canSend ? (
                // Running with an empty composer → Stop. Add text or an image and
                // the button becomes Send again, routing the content to the running
                // turn as a steering message (main decides; see AgentService.submit).
                <button
                  onClick={abort}
                  aria-label={t('composer.stop')}
                  className="flex size-9 items-center justify-center rounded-xl bg-secondary text-secondary-foreground transition-colors hover:bg-accent active:translate-y-px"
                >
                  <Square className="size-3.5 fill-current" strokeWidth={0} />
                </button>
              ) : (
                <button
                  onClick={submit}
                  disabled={!canSend}
                  aria-label={running ? t('composer.steer') : t('composer.send')}
                  className={cn(
                    "flex size-9 items-center justify-center rounded-xl transition-all active:translate-y-px",
                    canSend
                      ? "bg-primary text-primary-foreground hover:opacity-90"
                      : "cursor-not-allowed bg-muted text-muted-foreground",
                  )}
                >
                  <ArrowUp className="size-4" strokeWidth={2.5} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
