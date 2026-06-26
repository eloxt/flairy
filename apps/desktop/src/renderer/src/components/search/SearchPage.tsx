import { Input } from "@/components/ui/input";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { useChat } from "@/store/chat-store";
import type { SearchHit } from "@shared/ipc";
import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";

/** Control-char sentinels wrapping matched spans in a snippet (see db.searchMessages). */
const MARK_START = String.fromCharCode(2);
const MARK_END = String.fromCharCode(3);

/**
 * Render a snippet, turning the control-char-delimited matched spans into <mark>
 * highlights. Everything outside the markers is a plain string child (React
 * escapes it), so message bodies containing `<`, `>`, `&`, or a literal `<mark>`
 * render safely.
 */
function renderSnippet(snippet: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let rest = snippet;
  let k = 0;
  while (rest.length) {
    const start = rest.indexOf(MARK_START);
    if (start < 0) {
      nodes.push(rest);
      break;
    }
    if (start > 0) nodes.push(rest.slice(0, start));
    const end = rest.indexOf(MARK_END, start + 1);
    if (end < 0) {
      nodes.push(rest.slice(start + 1));
      break;
    }
    nodes.push(
      <mark key={k++} className="rounded-sm bg-primary/20 text-foreground">
        {rest.slice(start + 1, end)}
      </mark>,
    );
    rest = rest.slice(end + 1);
  }
  return nodes;
}

/**
 * Full-page full-text search over chats and message content. Reached at /search.
 * Typing runs a debounced query against the main process; clicking a hit opens
 * that session and jumps to the matching message turn.
 */
export function SearchPage(): React.JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { state, isMobile } = useSidebar();
  const collapsed = state === "collapsed";
  const openSession = useChat((s) => s.openSession);
  const sessions = useChat((s) => s.sessions);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  // Monotonic token: ignore a slow earlier response that resolves after a newer one.
  const reqId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      return;
    }
    const id = ++reqId.current;
    const timer = setTimeout(() => {
      void window.api.searchMessages({ query: q }).then((results) => {
        if (id === reqId.current) setHits(results);
      });
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  const pick = async (hit: SearchHit): Promise<void> => {
    const meta = sessions.find((s) => s.id === hit.sessionId);
    if (!meta) return;
    await openSession(meta, hit.msgIndex);
    navigate("/");
  };

  const showResults = query.trim().length > 0;

  return (
    // Opaque surface filling SidebarInset (a flex-1 flex-col): paints over the
    // window vibrancy and casts the same hairline seam shadow onto the sidebar as
    // the chat column. Header and search box stay shrink-0/pinned while only the
    // results region scrolls, so the title bar never scrolls with the content.
    <div className="relative z-10 flex flex-1 flex-col bg-background shadow-[-4px_0_12px_-8px_var(--rail-shadow)]">
      <header
        className={cn(
          "app-drag flex h-12 shrink-0 items-center gap-2.5 border-b border-border/70 pr-4",
          !isMobile ? "transition-[padding] duration-200 ease-linear" : "",
          collapsed || isMobile ? "pl-20" : "pl-3",
        )}
      >
        <SidebarTrigger className="app-no-drag -ml-0.5 text-muted-foreground hover:text-foreground" />
        <span className="truncate text-[0.9rem] font-semibold tracking-tight">
          {t("chat.searchTitle")}
        </span>
      </header>

      {/* Search box pinned below the header, above the scrolling results. */}
      <div className="shrink-0 border-b border-border/70 px-3 py-3">
        <div className="relative mx-auto w-full max-w-2xl">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") navigate("/");
            }}
            placeholder={t("chat.searchPlaceholder")}
            className="h-10 pl-9"
          />
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <div className="absolute inset-0 overflow-y-auto px-3 py-3">
          <div className="mx-auto w-full max-w-2xl">
            {!showResults ? (
              <p className="px-2 py-10 text-center text-sm text-muted-foreground">
                {t("chat.searchEmptyHint")}
              </p>
            ) : hits.length === 0 ? (
              <p className="px-2 py-10 text-center text-sm text-muted-foreground">
                {t("chat.noResults")}
              </p>
            ) : (
              <>
                <p className="eyebrow px-2 pb-2 text-muted-foreground">
                  {t("chat.resultCount", { count: hits.length })}
                </p>
                <ul className="flex flex-col gap-1">
                  {hits.map((hit, i) => (
                    <li key={`${hit.sessionId}-${hit.msgIndex}-${i}`}>
                      <button
                        type="button"
                        onClick={() => void pick(hit)}
                        className="flex w-full flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent"
                      >
                        <span className="truncate text-xs font-medium text-muted-foreground">
                          {hit.sessionTitle || t("chat.untitled")}
                        </span>
                        <span className="line-clamp-2 text-sm leading-relaxed text-foreground">
                          {renderSnippet(hit.snippet)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
