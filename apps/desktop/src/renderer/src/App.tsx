import { useEffect } from "react";
import { createHashRouter, RouterProvider, Outlet } from "react-router";
import { useTranslation } from "react-i18next";
import { PanelRight } from "lucide-react";
import { useChat } from "@/store/chat-store";
import { useAuth } from "@/store/auth-store";
import { useUi } from "@/store/ui-store";
import { AppSidebar } from "@/components/AppSidebar";
import { MessageList } from "@/components/chat/MessageList";
import { Composer } from "@/components/chat/Composer";
import { RightPanel } from "@/components/chat/RightPanel";
import { SearchPage } from "@/components/search/SearchPage";
import { AuthScreen } from "@/components/auth/AuthScreen";
import { RouteError } from "@/components/RouteError";
import { UpdateBadge } from "@/components/UpdateBadge";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * Hash router (the renderer loads over file:// in production, where BrowserRouter's
 * clean paths break). The authed shell is the layout; pages mount in its Outlet.
 * New pages slot into `children`. Created once at module scope.
 */
const router = createHashRouter([
  {
    path: "/",
    element: <AppLayout />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <ChatView /> },
      { path: "search", element: <SearchPage /> },
    ],
  },
]);

/**
 * Auth gate. The client is unusable until signed in: we restore any persisted
 * session on launch, show the auth screen while anonymous, and only mount the
 * router (with its agent/session wiring) once authenticated. We also follow
 * cross-window auth changes so signing out from the Settings window re-gates.
 */
export default function App(): React.JSX.Element {
  const phase = useAuth((s) => s.phase);
  const checkStatus = useAuth((s) => s.checkStatus);

  useEffect(() => {
    void checkStatus();
    return window.api.onAuthChanged(() => void checkStatus());
  }, [checkStatus]);

  if (phase === "loading") return <Splash />;
  if (phase === "anon") return <AuthScreen />;
  return <RouterProvider router={router} />;
}

/** Brief launch placeholder while we check the persisted session. */
function Splash(): React.JSX.Element {
  return <div className="h-screen w-screen bg-background" />;
}

/**
 * The authenticated app shell: sidebar + the active page (Outlet). Mounted only
 * when signed in. The agent IPC subscription (init) lives here, NOT in ChatView,
 * so streaming keeps flowing into the store while the user is on another route.
 */
function AppLayout(): React.JSX.Element {
  const { init, loadSessions, newChat } = useChat();

  useEffect(() => {
    const dispose = init();
    void (async () => {
      // Load the session list to populate the sidebar, but always land on the
      // blank "new conversation" page instead of auto-opening the latest chat.
      await loadSessions();
      await newChat();
    })();
    return dispose;
  }, [init, loadSessions, newChat]);

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="relative z-10 min-w-0 bg-transparent">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}

/** The chat page: header + thread + composer, with the slide-out details panel. */
function ChatView(): React.JSX.Element {
  const messages = useChat((s) => s.messages);
  return (
    // A flex row: the chat column fills the space and the details drawer sits to
    // its right, reaching the very top like the left sidebar (header is inside
    // the chat column only).
    // The seam shadow lives on THIS overflow-hidden row, not the chat column: an
    // element's own box-shadow isn't clipped by its own overflow, but a child's
    // would be. z-10 keeps it above the fixed sidebar so the shadow lands on the
    // frosted rail. The right panel reveals vibrancy, so the row stays transparent
    // (no bg here) — only the chat column paints the opaque chat surface.
    <div className="relative z-10 flex flex-1 overflow-hidden shadow-[-4px_0_12px_-8px_var(--rail-shadow)]">
      <div className="relative z-10 flex min-w-0 flex-1 flex-col bg-background">
        <ChatHeader />
        <div className="relative flex-1 overflow-hidden">
          <MessageList messages={messages} />
          <Composer />
        </div>
      </div>
      <RightPanel />
    </div>
  );
}

/** Header lives inside the provider so it can clear the traffic lights when collapsed. */
function ChatHeader(): React.JSX.Element {
  const { t } = useTranslation();
  const { state, isMobile } = useSidebar();
  const collapsed = state === "collapsed";
  // Only macOS has traffic lights to clear; Windows/Linux need no left inset.
  const isMac = window.api.platform === "darwin";
  const rightOpen = useUi((s) => s.rightPanelOpen);
  const toggleRight = useUi((s) => s.toggleRightPanel);

  // Show the active session's title; fall back to the product name on the home
  // screen (no session) or for an untitled session.
  const title = useChat((s) => {
    const active = s.sessions.find((x) => x.id === s.sessionId);
    return active?.title?.trim() || "Flairy";
  });

  return (
    <header
      className={cn(
        "app-drag flex h-12 shrink-0 items-center gap-2.5 border-b border-border/70 pr-4",
        !isMobile ? "transition-[padding] duration-200 ease-linear" : "",
        isMac && (collapsed || isMobile) ? "pl-20" : "pl-3",
      )}
    >
      <SidebarTrigger className="app-no-drag -ml-0.5 text-muted-foreground hover:text-foreground" />
      <div className="flex min-w-0 flex-1 items-baseline gap-2 leading-none">
        <span className="truncate text-[0.9rem] font-semibold tracking-tight">
          {title}
        </span>
      </div>
      <UpdateBadge />
      <button
        type="button"
        onClick={toggleRight}
        aria-label={t("panel.toggle")}
        aria-pressed={rightOpen}
        title={t("panel.toggle")}
        className={cn(
          "app-no-drag flex size-7 items-center justify-center rounded-md transition-colors hover:bg-accent",
          "text-muted-foreground hover:text-foreground",
        )}
      >
        <PanelRight className="size-4" />
      </button>
    </header>
  );
}
