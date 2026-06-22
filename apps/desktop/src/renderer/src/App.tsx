import { useEffect } from "react";
import { useChat } from "@/store/chat-store";
import { useAuth } from "@/store/auth-store";
import { AppSidebar } from "@/components/AppSidebar";
import { MessageList } from "@/components/chat/MessageList";
import { Composer } from "@/components/chat/Composer";
import { AuthScreen } from "@/components/auth/AuthScreen";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";

/**
 * Auth gate. The client is unusable until signed in: we restore any persisted
 * session on launch, show the auth screen while anonymous, and only mount the
 * app shell (with its agent/session wiring) once authenticated. We also follow
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
  return <AppShell />;
}

/** Brief launch placeholder while we check the persisted session. */
function Splash(): React.JSX.Element {
  return <div className="h-screen w-screen bg-background" />;
}

/** The authenticated app: sidebar + chat. Mounted only when signed in. */
function AppShell(): React.JSX.Element {
  const { messages, init, loadSessions, openSession, newChat } = useChat();

  // Subscribe to the main-process event stream, then ensure a session exists.
  useEffect(() => {
    const dispose = init();
    void (async () => {
      const sessions = await loadSessions();
      if (sessions[0]) await openSession(sessions[0]);
      else await newChat();
    })();
    return dispose;
  }, [init, loadSessions, openSession, newChat]);

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset className="relative z-10 min-w-0 bg-transparent">
        <ChatHeader />
        <div className="relative flex-1 overflow-hidden">
          <MessageList messages={messages} />
          <Composer />
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}

/** Header lives inside the provider so it can clear the traffic lights when collapsed. */
function ChatHeader(): React.JSX.Element {
  const { state, isMobile } = useSidebar();
  const collapsed = state === "collapsed";

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
        collapsed || isMobile ? "pl-20" : "pl-3",
      )}
    >
      <SidebarTrigger className="app-no-drag -ml-0.5 text-muted-foreground hover:text-foreground" />
      <div className="flex min-w-0 flex-1 items-baseline gap-2 leading-none">
        <span className="truncate text-[0.9rem] font-semibold tracking-tight">
          {title}
        </span>
      </div>
    </header>
  );
}
