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
    SidebarInput,
    SidebarMenu,
    SidebarMenuAction,
    SidebarMenuButton,
    SidebarMenuItem,
} from "@/components/ui/sidebar";
import { useChat } from "@/store/chat-store";
import type { SessionMeta } from "@shared/ipc";
import { CircleX, Plus, Search, Settings, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Left navigation: New Chat, Search, then the session history.
 * Search toggles an inline input that filters the history by title.
 */
export function AppSidebar(): React.JSX.Element {
  const { t } = useTranslation();
  const { sessions, sessionId, newChat } = useChat();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, query]);

  return (
    <Sidebar className="border-r border-sidebar-border">
      <SidebarHeader className="app-drag gap-2 px-3 pt-11 pb-2">
        <SidebarMenu className="gap-0.5">
          <SidebarMenuItem>
            <SidebarMenuButton
              className="app-no-drag h-9 rounded-lg border border-border bg-card font-medium hover:bg-accent"
              onClick={() => void newChat()}
            >
              <Plus className="size-4" />
              <span>{t('chat.newChat')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              className="app-no-drag h-9 rounded-lg text-muted-foreground"
              isActive={searching}
              onClick={() => {
                setSearching((v) => !v);
                setQuery("");
              }}
            >
              {searching ? (
                <X className="size-4" />
              ) : (
                <Search className="size-4" />
              )}
              <span>{searching ? t('chat.closeSearch') : t('chat.search')}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>

        {searching && (
          <SidebarInput
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('chat.searchPlaceholder')}
            className="app-no-drag mt-1 rounded-lg"
          />
        )}
      </SidebarHeader>

      <SidebarContent className="px-1">
        <SidebarGroup>
          <SidebarGroupLabel className="eyebrow px-2">
            {t('chat.history')}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {visible.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  {query ? t('chat.noMatchingChats') : t('chat.chatsWillAppearHere')}
                </p>
              ) : (
                visible.map((s) => (
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
 * One history row. Hover/focus reveals a ⋯ menu (rename / delete). Renaming
 * swaps the title for an inline input; deleting asks for confirmation first.
 */
function SessionRow({
  s,
  active,
}: {
  s: SessionMeta;
  active: boolean;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { openSession, deleteSession } = useChat();
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Enter and blur both fire commit(); this guards against the double-run.


  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        onClick={() => void openSession(s)}
        className="group/item rounded-lg"
      >
        <span className="truncate text-[0.8125rem]">
          {s.title || t('chat.untitled')}
        </span>
      </SidebarMenuButton>

      <SidebarMenuAction
        showOnHover
        onClick={(e) => e.stopPropagation()}
      >
        <CircleX onClick={() => setConfirmDelete(true)}/>
      </SidebarMenuAction>

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
