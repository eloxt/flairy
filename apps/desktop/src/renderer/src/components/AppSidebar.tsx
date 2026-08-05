import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuAction,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarMenuSub,
} from "@/components/ui/sidebar";
import { useChat } from "@/store/chat-store";
import { cn } from "@/lib/utils";
import type { SessionMeta, SocketConnectionStatus } from "@shared/ipc";
import { IconFolder, IconLoader2, IconPlus, IconSearch, IconSend, IconSettings, IconEdit, IconTrash, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, useLocation, useNavigate } from "react-router";

interface WorkspaceGroup {
  path: string;
  label: string;
  sessions: SessionMeta[];
}

function normalizeWorkspace(path: string): string {
  return path.replace(/\/+$/, "") || path;
}

function workspaceLabel(path: string): string {
  const normalized = normalizeWorkspace(path);
  return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

function groupSessions(sessions: SessionMeta[]): {
  projects: WorkspaceGroup[];
  chats: SessionMeta[];
} {
  const workspaces = new Map<string, WorkspaceGroup>();
  const chats: SessionMeta[] = [];
  for (const session of sessions) {
    if (!session.workspacePath) {
      chats.push(session);
      continue;
    }
    const path = normalizeWorkspace(session.workspacePath);
    const group = workspaces.get(path) ?? { path, label: workspaceLabel(path), sessions: [] };
    group.sessions.push(session);
    workspaces.set(path, group);
  }
  return {
    projects: [...workspaces.values()].sort(
      (a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0)
    ),
    chats
  };
}

// Reveal a section's action only while that section's own header row is
// hovered. SidebarMenuAction's built-in `showOnHover` keys off
// group/menu-item, which sits on the <li> wrapping the collapsible content
// too — so hovering a session row revealed its project's and the Projects
// header's buttons as well. Section scopes group/row to the header row alone.
const rowHoverAction =
  "group-focus-within/row:opacity-100 group-hover/row:opacity-100 aria-expanded:opacity-100 md:opacity-0";

type SidebarTab = "projects" | "chats";

// Each tab's list scrolls on its own; the shared track only slides.
const panelClass =
  "h-full w-full shrink-0 overflow-y-auto overscroll-contain no-scrollbar scroll-fade-y px-2 py-1.5 md:px-0";

/**
 * Left navigation: New Chat, Search (its own page at /search), then the session
 * history. Selecting a chat navigates back to the chat route.
 */
export function AppSidebar(): React.JSX.Element {
  const { t } = useTranslation();
  // Individual selectors — a bare `useChat()` would re-render the whole
  // sidebar on every streamed token (the store's foreground mirror changes
  // per token). `sessions`/`sessionId` only change on real session events.
  const sessions = useChat((s) => s.sessions);
  const sessionId = useChat((s) => s.sessionId);
  const newChat = useChat((s) => s.newChat);
  const openSession = useChat((s) => s.openSession);
  const deleteSession = useChat((s) => s.deleteSession);
  const loadRecentDirs = useChat((s) => s.loadRecentDirs);
  const navigate = useNavigate();
  const onSearch = useLocation().pathname === "/search";
  // Only macOS has traffic lights to clear; Windows/Linux need no top inset.
  const isMac = window.api.platform === "darwin";
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [socketStatus, setSocketStatus] = useState<SocketConnectionStatus>("disconnected");
  const [tab, setTab] = useState<SidebarTab>("chats");
  const pendingCwd = useChat((s) => s.pendingCwd);
  const hasSelection = selectedIds.size > 0;
  const grouped = groupSessions(sessions);

  // "Current project" for the header button on the Projects tab: the active
  // session's folder, else a just-picked pending folder, else the most
  // recently used project (grouped.projects is sorted by activity).
  const activeWorkspace = sessions.find((s) => s.id === sessionId)?.workspacePath ?? null;
  const currentProject = activeWorkspace ?? pendingCwd ?? grouped.projects[0]?.path ?? null;

  // Follow the active session onto its own tab so the highlighted row is never
  // stranded on the hidden panel. Keyed off sessionId transitions only —
  // `sessions` churns during streaming (updatedAt bumps) and must not snap the
  // tab back while the user is browsing the other panel.
  const prevSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || prevSessionRef.current === sessionId) return;
    prevSessionRef.current = sessionId;
    const current = sessions.find((s) => s.id === sessionId);
    if (current) setTab(current.workspacePath ? "projects" : "chats");
  }, [sessionId, sessions]);

  useEffect(() => {
    void window.api.getSocketStatus().then(setSocketStatus);
    return window.api.onSocketStatusChanged(setSocketStatus);
  }, []);

  useEffect(() => {
    setSelectedIds((cur) => {
      const liveIds = new Set(sessions.map((s) => s.id));
      const next = new Set([...cur].filter((id) => liveIds.has(id)));
      return next.size === cur.size ? cur : next;
    });
  }, [sessions]);

  useEffect(() => {
    if (selecting || selectedIds.size === 0) return;
    setSelectedIds(new Set());
  }, [selecting, selectedIds.size]);

  const enterSelectionMode = (initialId: string): void => {
    setSelecting(true);
    setSelectedIds(new Set([initialId]));
  };

  const exitSelectionMode = (): void => {
    setSelecting(false);
    setConfirmBulkDelete(false);
    setSelectedIds(new Set());
  };

  const toggleSelected = (id: string): void => {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // "Add project": pick a folder and create its first session EAGERLY (unlike
  // plain chats, which stay lazy until the first message) so the folder shows
  // up in the sidebar immediately instead of only after the first conversation.
  // Adding a project is a deliberate act, so one empty starter session is fine.
  // This is still the ONLY way to start a project: the composer no longer
  // offers a folder picker for plain chats.
  const addProject = async (): Promise<void> => {
    const dir = await window.api.pickDirectory();
    if (!dir) return; // user cancelled
    setTab("projects");
    const meta = await window.api.createSession({ cwd: dir, workspacePath: dir });
    await openSession(meta);
    void loadRecentDirs(); // main recorded the pick
    navigate("/");
  };

  const deleteSelectedSessions = async (): Promise<void> => {
    const ids = [...selectedIds];
    setConfirmBulkDelete(false);
    exitSelectionMode();
    for (const id of ids) {
      await deleteSession(id);
    }
  };

  return (
    // Inset variant: the rail blends into the wrapper's bg-sidebar backdrop and
    // the chat surface floats as a rounded panel (SidebarInset) beside it.
    // The rail owns its whole horizontal gutter here, and it is deliberately
    // one-sided: SidebarInset already floats the panel 8px off the rail, so any
    // padding on the right would stack on top of that and rows would sit twice
    // as far from the panel as from the window edge. Left 8px + right 0 makes
    // both visual gaps 8px. Children run md:px-0 so they all share this one edge.
    //
    // Below md the rail becomes an overlay sheet, which drops this className and
    // has no padding of its own — hence the children's own px-2 under that
    // breakpoint, or the rows would sit flush against both sheet edges.
    <Sidebar variant="inset" className="pl-2 pr-0">
      <SidebarHeader className={cn("app-drag gap-2 px-2 pb-2 md:px-0", isMac ? "pt-11" : "pt-2")}>
        <SidebarMenu className="gap-0.5">
          {/* New chat follows the active tab: a plain chat on Chats, a chat
              in the current project on Projects. With no project to target it
              falls back to picking a project folder. */}
          <SidebarMenuItem>
            <SidebarMenuButton
              className="app-no-drag h-9 rounded-lg hover:bg-accent"
              onClick={() => {
                if (tab === "projects" && !currentProject) {
                  void addProject();
                  return;
                }
                void newChat(tab === "projects" ? currentProject ?? undefined : undefined);
                navigate("/");
              }}
            >
              {tab === "projects" && !currentProject
                ? <IconPlus className="size-4" />
                : <IconEdit className="size-4" />}
              <span>
                {tab === "projects" && !currentProject
                  ? t('chat.addProject')
                  : t('chat.newChat')}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<NavLink to="/search" />}
              isActive={onSearch}
              className="app-no-drag h-9 rounded-lg cursor-default"
            >
              <IconSearch className="size-4" />
              <span>{t('chat.search')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      {/* overflow-hidden: the content column no longer scrolls itself — each
          tab panel owns its scroll so the sliding track never drags the other
          panel's scroll position along. */}
      <SidebarContent className="overflow-hidden px-0">
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Segmented control (matches the rail's rounded frosted style — the
              ui Tabs underline read too web-like here). The thumb is exactly
              one cell wide, so translate-x-full lands it on the second cell.
              mx-2/md:mx-0: the rail's gutter lives on Sidebar; below md the
              overlay sheet needs its own inset. */}
          <div
            role="tablist"
            className="app-no-drag relative mx-2 grid h-8 shrink-0 grid-cols-2 rounded-lg bg-sidebar-accent p-[3px] md:mx-0"
          >
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-y-[3px] left-[3px] w-[calc(50%-3px)] rounded-md border border-transparent bg-background shadow-sm transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] dark:border-input dark:bg-input/30",
                tab === "projects" && "translate-x-full",
              )}
            />
            {(["chats", "projects"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={cn(
                  "relative cursor-default rounded-md text-[0.8125rem] font-medium transition-colors outline-none select-none",
                  tab === value
                    ? "text-foreground"
                    : "text-foreground/60 hover:text-foreground dark:text-muted-foreground dark:hover:text-foreground",
                )}
                onClick={() => setTab(value)}
              >
                {value === "chats" ? t('chat.chats') : t('chat.projects')}
              </button>
            ))}
          </div>

          {selecting && (
            <div className="flex items-center justify-end gap-1.5 px-2 pt-1.5 md:px-0">
              <button
                type="button"
                className="app-no-drag inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                aria-label={t('chat.deleteSelected')}
                disabled={!hasSelection}
                onClick={() => setConfirmBulkDelete(true)}
              >
                <IconTrash className="size-3.5" />
              </button>
              <button
                type="button"
                className="app-no-drag inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label={t('chat.cancel')}
                onClick={exitSelectionMode}
              >
                <IconX className="size-3.5" />
              </button>
            </div>
          )}

          {/* Both panels stay mounted side by side; the track slides one panel
              width per tab. `inert` keeps the off-screen panel out of focus
              order and hit testing. */}
          <div className="min-h-0 flex-1 overflow-hidden">
            <div
              className={cn(
                "flex h-full transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]",
                tab === "projects" && "-translate-x-full",
              )}
            >
              <div className={panelClass} inert={tab !== "chats"}>
                {grouped.chats.length === 0 ? (
                  <p className="px-2 py-2 text-xs text-muted-foreground">
                    {t('chat.chatsWillAppearHere')}
                  </p>
                ) : (
                  <SidebarMenu className="gap-0.5">
                    {grouped.chats.map((s) => (
                      <SessionRow
                        key={s.id}
                        s={s}
                        active={s.id === sessionId}
                        selecting={selecting}
                        selected={selectedIds.has(s.id)}
                        onEnterSelectionMode={enterSelectionMode}
                        onToggleSelected={toggleSelected}
                      />
                    ))}
                  </SidebarMenu>
                )}
              </div>
              <div className={panelClass} inert={tab !== "projects"}>
                <SidebarMenu className="gap-0.5">
                  {/* The only way to add a project folder (the header button
                      targets the current project once one exists). */}
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      className="app-no-drag h-8 rounded-lg text-muted-foreground hover:text-foreground"
                      onClick={() => void addProject()}
                    >
                      <IconPlus className="size-4" />
                      <span>{t('chat.addProject')}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  {grouped.projects.map((group) => (
                      <Section
                        key={group.path}
                        label={group.label}
                        icon={IconFolder}
                        title={group.path}
                        triggerClassName="text-muted-foreground/90"
                        action={
                          <SidebarMenuAction
                            className={rowHoverAction}
                            title={t('chat.newInProject', { project: group.label })}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              void newChat(group.path);
                              navigate("/");
                            }}
                          >
                            <IconEdit className="size-3.5! text-sidebar-foreground"/>
                          </SidebarMenuAction>
                        }
                      >
                        {/* Keep the left indent + guide line but let rows
                            stretch to the sidebar's right edge (the default
                            mr-3.5/pr-2.5 leaves a dead gutter on the right). */}
                        <SidebarMenuSub className="mr-0 pr-0">
                          {group.sessions.map((s) => (
                            <SessionRow
                              key={s.id}
                              s={s}
                              active={s.id === sessionId}
                              selecting={selecting}
                              selected={selectedIds.has(s.id)}
                              onEnterSelectionMode={enterSelectionMode}
                              onToggleSelected={toggleSelected}
                            />
                          ))}
                        </SidebarMenuSub>
                      </Section>
                  ))}
                </SidebarMenu>
                {grouped.projects.length === 0 && (
                  <p className="px-2 py-2 text-xs text-muted-foreground">
                    {t('chat.noProjects')}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </SidebarContent>

      <SidebarFooter className="p-2 md:p-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="app-no-drag relative h-9 rounded-lg pr-8 text-muted-foreground"
              onClick={() => void window.api.openSettings()}
            >
              <IconSettings className="size-4" />
              <span className="min-w-0 flex-1 truncate">{t('common.settings')}</span>
              <i
                aria-hidden="true"
                className={cn(
                  "absolute right-2 top-1/2 size-2 -translate-y-1/2 rounded-full",
                  socketStatus === "connecting" && "bg-amber-500",
                  socketStatus === "disconnected" && "bg-destructive",
                )}
              />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <AlertDialog open={confirmBulkDelete} onOpenChange={setConfirmBulkDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('chat.deleteSelectedTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('chat.deleteSelectedDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('chat.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void deleteSelectedSessions()}>
              {t('chat.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Sidebar>
  );
}

function Section({
  label,
  icon: Icon,
  title,
  triggerClassName,
  action,
  children,
}: {
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  title?: string;
  triggerClassName?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  // When an action (e.g. the "+" new-session button) pins to the row's far
  // right, the chevron hugs the label instead of being pushed to the edge.
  const hugText = !!action;
  return (
    <Collapsible defaultOpen>
      <SidebarMenuItem>
        {/* group/row wraps the header row ONLY — the <li>'s own
            group/menu-item also covers CollapsibleContent, so keying the
            action off it lit up every ancestor's button whenever a nested
            session row was hovered. `relative` keeps the absolutely
            positioned action anchored to this row. */}
        <div className="group/row relative">
          <CollapsibleTrigger
            render={
              <SidebarMenuButton
                size="sm"
                title={title}
                className={cn("group/collapsible", triggerClassName)}
              />
            }
          >
            {Icon && <Icon className="shrink-0 opacity-80" />}
            <span className={cn("min-w-0 truncate", !hugText && "flex-1")}>{label}</span>
          </CollapsibleTrigger>
          {action}
        </div>
        <CollapsibleContent>{children}</CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

/**
 * One history row. Right-clicking opens the OS-native context menu (Rename /
 * Delete). Rename swaps the title for an inline input; Delete asks for
 * confirmation first.
 */
function SessionRow({
  s,
  active,
  selecting,
  selected,
  onEnterSelectionMode,
  onToggleSelected,
}: {
  s: SessionMeta;
  active: boolean;
  selecting: boolean;
  selected: boolean;
  onEnterSelectionMode: (id: string) => void;
  onToggleSelected: (id: string) => void;
}): React.JSX.Element {
  const { t } = useTranslation();
  // Stable function refs via selectors — a bare `useChat()` here would
  // subscribe the row to the whole store and defeat the `running` selector
  // below (every streamed token would re-render every visible row).
  const openSession = useChat((st) => st.openSession);
  const deleteSession = useChat((st) => st.deleteSession);
  const renameSession = useChat((st) => st.renameSession);
  // Subscribe to just this row's running flag (a primitive) so the indicator
  // toggles without re-rendering the whole sidebar on every streamed token.
  const running = useChat((st) => st.runningSessions.includes(s.id));
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const commitRename = (value: string): void => {
    setRenaming(false);
    const trimmed = value.trim();
    if (trimmed && trimmed !== s.title) void renameSession(s.id, trimmed);
  };

  return (
    <SidebarMenuItem>
      {renaming ? (
        <input
          autoFocus
          defaultValue={s.title}
          aria-label={t("chat.rename")}
          className="h-8 w-full rounded-lg bg-accent px-2 text-[0.8125rem] outline-none ring-1 ring-ring"
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => commitRename(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename(e.currentTarget.value);
            else if (e.key === "Escape") setRenaming(false);
          }}
        />
      ) : (
        <SidebarMenuButton
          render={selecting ? <div role="button" tabIndex={0} /> : undefined}
          isActive={selecting ? selected : active}
          onClick={() => {
            if (selecting) {
              onToggleSelected(s.id);
              return;
            }
            void openSession(s);
            navigate("/");
          }}
          onKeyDown={(e) => {
            if (!selecting) return;
            if (e.key !== "Enter" && e.key !== " ") return;
            e.preventDefault();
            onToggleSelected(s.id);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            void window.api.showSessionMenu().then((action) => {
              if (action === "delete") setConfirmDelete(true);
              else if (action === "rename") setRenaming(true);
              else if (action === "select") onEnterSelectionMode(s.id);
            });
          }}
          className="group/item rounded-lg pr-2!"
        >
          {selecting && (
            <Checkbox
              checked={selected}
              aria-label={s.title || t('chat.untitled')}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              onCheckedChange={() => onToggleSelected(s.id)}
            />
          )}
          <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
            {s.title || t('chat.untitled')}
          </span>
          {s.fromTelegram && (
            <span
              className="shrink-0 text-muted-foreground"
              aria-label={t('chat.fromTelegram')}
              title={t('chat.fromTelegram')}
            >
              <IconSend className="size-3" />
            </span>
          )}
          {running && (
            <span className="ml-auto flex shrink-0" aria-label={t('chat.running')} title={t('chat.running')}>
              <IconLoader2 className="size-3.5 animate-spin text-muted-foreground" />
            </span>
          )}
        </SidebarMenuButton>
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('chat.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('chat.deleteDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('chat.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void deleteSession(s.id)}>
              {t('chat.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarMenuItem>
  );
}
