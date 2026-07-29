import { useEffect } from "react";
import { createHashRouter, RouterProvider, Outlet, useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import type { ChatWidth, SessionMeta } from "@shared/ipc";
import { IconLayoutSidebarRight } from "@tabler/icons-react";
import { useChat } from "@/store/chat-store";
import { useAuth } from "@/store/auth-store";
import { useUi } from "@/store/ui-store";
import { AppSidebar } from "@/components/AppSidebar";
import { ProgressiveBlur } from "@/components/ProgressiveBlur";
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

  // Chat width preference lives on <html> as `data-chat-width`, which selects
  // the `--chat-width` CSS variable the chat containers cap themselves to.
  // Applied here (not in ChatView) so it's set once and follows live changes
  // made from the Settings window.
  useEffect(() => {
    const apply = (w: ChatWidth): void => {
      document.documentElement.dataset.chatWidth = w;
    };
    void window.api.getChatWidth().then(apply);
    return window.api.onChatWidthChanged(apply);
  }, []);

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
  // Individual selectors (all stable function refs): a bare `useChat()`
  // subscribes to the WHOLE store and re-renders this layout — sidebar and
  // page included — on every streamed token.
  const init = useChat((s) => s.init);
  const loadSessions = useChat((s) => s.loadSessions);
  const newChat = useChat((s) => s.newChat);
  const navigate = useNavigate();

  useEffect(() => {
    const dispose = init();
    // The quick launcher handing its conversation off to this window: make sure
    // the session is in the sidebar list, then open it. A cold open seeds from
    // the live agent state (loadSessionLive), so a mid-stream handoff renders
    // live and keeps streaming via the broadcast agent events.
    const openFromLauncher = (meta: SessionMeta): void => {
      useChat.setState((s) =>
        s.sessions.some((x) => x.id === meta.id)
          ? {}
          : { sessions: [meta, ...s.sessions] },
      );
      void useChat.getState().openSession(meta);
    };
    const offLauncher = window.api.onLauncherOpenSession(openFromLauncher);
    // Clicking a scheduled-run notification: same handoff shape — ensure the
    // session is listed, then open it on the chat page (wherever we were).
    const offSchedule = window.api.onScheduleOpenSession((meta) => {
      openFromLauncher(meta);
      navigate("/");
    });
    void (async () => {
      // Load the session list to populate the sidebar, but always land on the
      // blank "new conversation" page instead of auto-opening the latest chat.
      await loadSessions();
      await newChat();
      // A handoff made while no main window was alive: consume it (take-once)
      // AFTER the initial newChat so the handed-off session stays in front.
      const pending = await window.api.takePendingLauncherSession();
      if (pending) openFromLauncher(pending);
    })();
    return () => {
      offLauncher();
      offSchedule();
      dispose();
    };
  }, [init, loadSessions, newChat, navigate]);

  return (
    <SidebarProvider>
      <AppSidebar />
      {/* Deliberately a plain rounded corner, NOT [corner-shape:squircle]: in
          Chromium a corner-shape clipping ancestor stops descendant mask-image
          from confining backdrop-filter, which collapses the header's
          ProgressiveBlur ramp into one flat milky band with a hard edge. At 16px
          the two silhouettes are near-identical anyway. */}
      <SidebarInset className="relative z-10 min-w-0 overflow-hidden ring-1 ring-sidebar-border rounded-lg! m-2!">
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}

/**
 * The chat page: header + thread + composer, with the slide-out details panel.
 * Deliberately subscribes to NOTHING that changes per streamed token — the
 * `messages` array lives inside MessageList's own subscription. Subscribing to
 * it here would rebuild ChatHeader/Composer/RightPanel (all unmemoized
 * children) on every delta.
 */
function ChatView(): React.JSX.Element {
  return (
    // A flex row: the chat column fills the space and the details drawer sits to
    // its right, reaching the very top like the left sidebar (header is inside
    // the chat column only). The inset SidebarInset panel carries the elevation
    // (rounded corners + shadow), so no seam shadow is needed here; the row stays
    // transparent — the chat column and right panel each paint their own surface.
    <div className="relative z-10 flex flex-1 overflow-hidden">
      <div
        data-chat-column
        className="relative z-10 flex min-w-0 flex-1 flex-col bg-background"
      >
        {/* The header floats over the thread (like the composer at the bottom):
            messages scroll underneath it, fading out through its blur gradient. */}
        <div className="relative flex-1 overflow-hidden">
          <ChatHeader />
          <MessageList />
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
        "app-drag absolute inset-x-0 top-0 z-20 flex h-12 items-center gap-2.5 pr-4",
        !isMobile ? "transition-[padding] duration-200 ease-linear" : "",
        isMac && (collapsed || isMobile) ? "pl-20" : "pl-3",
      )}
    >
      {/* No divider: a progressive blur (stacked backdrop-filter layers, blur
          ramping up toward the top) plus a soft tint for text contrast.
          right-2.5 keeps it off the viewport's 10px scrollbar gutter (classic,
          not overlay — content never paints there, so no seam) so the thumb
          isn't blurred when it sits near the top. */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 right-2.5 top-0 -bottom-8 -z-10"
      >
        <ProgressiveBlur
          direction="top"
          // 5 layers × 1.4px ≈ the old 8-layer 7px max, at ~60% of the
          // per-frame backdrop-filter cost.
          blurIntensity={1.4}
          className="absolute inset-0"
        />
        <div className="absolute inset-0 bg-linear-to-b from-background/90 via-background/40 to-transparent" />
      </div>
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
        <IconLayoutSidebarRight className="size-4" />
      </button>
    </header>
  );
}
