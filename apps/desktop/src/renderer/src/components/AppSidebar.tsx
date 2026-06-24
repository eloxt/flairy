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
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useChat } from "@/store/chat-store";
import type { SessionMeta } from "@shared/ipc";
import { LoaderCircle, Plus, Search, Settings } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { NavLink, useLocation, useNavigate } from "react-router";

/**
 * Left navigation: New Chat, Search (its own page at /search), then the session
 * history. Selecting a chat navigates back to the chat route.
 */
export function AppSidebar(): React.JSX.Element {
  const { t } = useTranslation();
  const { sessions, sessionId, newChat } = useChat();
  const navigate = useNavigate();
  const onSearch = useLocation().pathname === "/search";

  return (
    <Sidebar className="border-r border-sidebar-border">
      <SidebarHeader className="app-drag gap-2 px-3 pt-11 pb-2">
        <SidebarMenu className="gap-0.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              className="app-no-drag h-9 rounded-lg border border-border bg-card font-medium hover:bg-accent"
              onClick={() => {
                void newChat();
                navigate("/");
              }}
            >
              <Plus className="size-4" />
              <span>{t('chat.newChat')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              render={<NavLink to="/search" />}
              isActive={onSearch}
              className="app-no-drag h-9 rounded-lg text-muted-foreground"
            >
              <Search className="size-4" />
              <span>{t('chat.search')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="px-1">
        <SidebarGroup>
          <SidebarGroupLabel className="eyebrow px-2">
            {t('chat.history')}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {sessions.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  {t('chat.chatsWillAppearHere')}
                </p>
              ) : (
                sessions.map((s) => (
                  <SessionRow key={s.id} s={s} active={s.id === sessionId} />
                ))
              )}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="px-1 pb-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="app-no-drag h-9 rounded-lg text-muted-foreground"
              onClick={() => void window.api.openSettings()}
            >
              <Settings className="size-4" />
              <span>{t('common.settings')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
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
}: {
  s: SessionMeta;
  active: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { openSession, deleteSession, renameSession } = useChat();
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
          isActive={active}
          onClick={() => {
            void openSession(s);
            navigate("/");
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            void window.api.showSessionMenu().then((action) => {
              if (action === "delete") setConfirmDelete(true);
              else if (action === "rename") setRenaming(true);
            });
          }}
          className="group/item rounded-lg"
        >
          <span className="min-w-0 flex-1 truncate text-[0.8125rem]">
            {s.title || t('chat.untitled')}
          </span>
          {running && (
            <span className="ml-auto flex shrink-0" aria-label={t('chat.running')} title={t('chat.running')}>
              <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />
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
