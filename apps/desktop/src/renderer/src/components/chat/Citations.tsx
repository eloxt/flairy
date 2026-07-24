import {
  createContext,
  isValidElement,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Globe } from "lucide-react";
import type { SearchImage, SearchSource } from "@shared/web-search";
import { getFaviconUrl } from "@/lib/favicon";
import { cn } from "@/lib/utils";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";

/**
 * The search sources an assistant message may cite. Provided by `AssistantRow`
 * (the sources of the search that preceded the answer) and read by the inline
 * {@link CitationChip} rendered inside the markdown, so a chip can resolve its
 * `[n]` to a source without threading props through Streamdown.
 */
const CitationsContext = createContext<SearchSource[]>([]);

export function CitationsProvider({
  sources,
  children,
}: {
  sources: SearchSource[];
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <CitationsContext.Provider value={sources}>
      {children}
    </CitationsContext.Provider>
  );
}

/** Open a source URL in the user's default browser via the main process. */
function openSource(url: string): void {
  void window.api.openExternal(url);
}

/**
 * Flatten a React children value (string | array | element | nested) to its
 * text. MUST recurse into elements: while a message streams, Streamdown's
 * entrance animation (a rehype pass) wraps every text run — including the
 * number inside our citation `<sup>` — in animated `<span>`s, so the chip's
 * children arrive as elements, not strings. Without unwrapping, every chip in
 * a streaming answer degrades to a plain superscript number.
 */
function childrenText(c: unknown): string {
  if (typeof c === "string" || typeof c === "number") return String(c);
  if (Array.isArray(c)) return c.map(childrenText).join("");
  if (isValidElement(c))
    return childrenText((c.props as { children?: unknown }).children);
  return "";
}

/**
 * A remark plugin that turns inline `[n]` markers in prose into `citation`
 * nodes, which Streamdown renders via the `citation` component override (see
 * {@link CitationChip}). Only bare `[number]` runs in plain text are touched;
 * inline code and code blocks are separate mdast node types and are left alone.
 * Hand-rolled (no `unist-util-visit` dependency): walk every node's children and
 * split text nodes that contain a marker.
 */
export function remarkCitations() {
  // Matches a bracketed group of one or more numbers: [1], [1,2], [1, 2, 3].
  // Each number becomes its own chip (the model is told it may write [1,2]).
  const CITE = /\[\s*(\d+(?:\s*,\s*\d+)*)\s*\]/g;
  type Node = {
    type: string;
    value?: string;
    url?: string;
    children?: Node[];
    data?: unknown;
  };

  const splitText = (value: string): Node[] => {
    const out: Node[] = [];
    let last = 0;
    let m: RegExpExecArray | null;
    CITE.lastIndex = 0;
    while ((m = CITE.exec(value))) {
      if (m.index > last)
        out.push({ type: "text", value: value.slice(last, m.index) });
      for (const num of m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)) {
        out.push({
          type: "citation",
          // Render as a STANDARD <sup> element (not a custom tag): react-markdown
          // only applies a `components` override for known elements, so a custom
          // <citation> tag would fall through and leak its children as plain text.
          // The number MUST ride as the text child — it's the only channel that
          // reaches the component. The data-attr below is belt-and-braces only:
          // Streamdown's sanitize pass strips unknown attributes, so it never
          // actually arrives in props (verified empirically against 2.5.0).
          data: { hName: "sup", hProperties: { "data-cite": num } },
          children: [{ type: "text", value: num }],
        });
      }
      last = m.index + m[0].length;
    }
    if (out.length === 0) return [{ type: "text", value }];
    if (last < value.length)
      out.push({ type: "text", value: value.slice(last) });
    return out;
  };

  const walk = (node: Node): void => {
    if (!node.children || node.children.length === 0) return;
    const next: Node[] = [];
    for (const child of node.children) {
      if (
        child.type === "text" &&
        typeof child.value === "string" &&
        child.value.includes("[")
      ) {
        next.push(...splitText(child.value));
      } else if (
        child.type === "image" &&
        typeof child.url === "string" &&
        /^#i\d+$/.test(child.url)
      ) {
        // `![alt](#i3)` — a search-image embed. Streamdown's rehype-harden pass
        // BLOCKS fragment-only URLs on images (it allows them on links only,
        // even under the "*" wildcard), so the node would be replaced before our
        // `img` override ever ran. Path-relative URLs DO pass the wildcard —
        // rewrite `#i3` → `/i3` here at the remark stage, upstream of harden.
        // The model-facing format stays `#i<id>`; CitationImage accepts both.
        child.url = `/${child.url.slice(1)}`;
        next.push(child);
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  };

  return (tree: unknown): void => walk(tree as Node);
}

/**
 * One inline citation chip. Resolves its `[n]` against the message's source
 * registry (context). If the number doesn't match a real source — e.g. a stray
 * `[1]` in ordinary prose — it falls back to rendering the literal text, so the
 * transform is invisible when it's not actually a citation.
 */
// Props typed `any`: Streamdown's Components type for a known tag (`sup`) is an
// intersection no concrete props type satisfies — `any` is the standard
// react-markdown override pattern.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function CitationChip(props: any): React.JSX.Element {
  const sources = useContext(CitationsContext);
  // The number lives in the rendered children (possibly wrapped in animation
  // spans — childrenText unwraps those). The data-attr read is a fallback that
  // today never fires: Streamdown's sanitizer strips unknown attributes.
  const raw = (
    childrenText(props.children) || String(props["data-cite"] ?? "")
  ).trim();
  const n = Number(raw);
  // A non-numeric <sup> is a genuine superscript, not a citation — pass it
  // through unchanged (this component is registered for the whole <sup> tag).
  if (!raw || !Number.isInteger(n))
    return <sup>{props.children as ReactNode}</sup>;
  const source = sources.find((s) => s.i === n);
  if (!source) return <>[{raw}]</>;
  return (
    <HoverCard>
      <HoverCardTrigger
        render={<button type="button" />}
        onClick={() => openSource(source.url)}
        title={source.title}
        delay={200}
        closeDelay={200}
        className="mx-0.5 inline-flex h-[1.1rem] min-w-[1.1rem] translate-y-[-0.3em] items-center justify-center rounded-full bg-muted px-1 align-baseline text-[0.65rem] font-medium leading-none text-muted-foreground no-underline transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        {source.i}
      </HoverCardTrigger>
      <HoverCardContent>
        <SourceCardBody source={source} onOpen={() => openSource(source.url)} />
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * Favicon image with a graceful fallback to a generic globe icon — both when no
 * URL is derivable and when the derived `/favicon.ico` fails to load (sites
 * that only declare their icon via `<link rel>` 404 the conventional path).
 */
function Favicon({
  source,
  className,
}: {
  source: SearchSource;
  className?: string;
}): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  const url = getFaviconUrl(source.favicon, source.url);
  if (!url || failed)
    return <Globe className={cn("text-muted-foreground", className)} />;
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      className={cn("rounded-[3px] object-contain", className)}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * `![alt](#i12)` — the only image reference the chat markdown will render. The
 * remark pass rewrites `#i12` → `/i12` to get past rehype-harden (which blocks
 * fragment URLs on images), so match both spellings here.
 */
const IMAGE_REF = /^[#/]i(\d+)$/;

/**
 * Override for every `<img>` in assistant markdown. The model embeds search
 * images as `![alt](#i<id>)`; the id is resolved against the message's source
 * registry, which doubles as the URL allowlist — anything else (a hallucinated
 * id, an arbitrary external URL, an injection-planted tracking pixel) never
 * loads and degrades to its alt text.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function CitationImage(props: any): React.JSX.Element | null {
  const sources = useContext(CitationsContext);
  const src = typeof props.src === "string" ? props.src : "";
  const m = IMAGE_REF.exec(src);
  const image = m
    ? sources
        .flatMap((s) => s.images ?? [])
        .find((i) => i.id === Number(m[1]))
    : undefined;
  if (!image) {
    const alt = typeof props.alt === "string" ? props.alt.trim() : "";
    return alt ? <span className="text-muted-foreground">{alt}</span> : null;
  }
  return <EmbeddedImage image={image} />;
}

/**
 * A registry-backed inline image in the answer body. Zero footprint until it
 * actually loads and gone entirely on error, so a dead link never leaves a
 * broken-image band in the prose. Click opens the image in the browser.
 */
function EmbeddedImage({ image }: { image: SearchImage }): React.JSX.Element | null {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={image.url}
      alt={image.alt ?? ""}
      title={image.alt}
      loading="lazy"
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
      onClick={() => openSource(image.url)}
      className={cn(
        "block cursor-pointer object-contain",
        loaded
          ? "my-2 max-h-72 max-w-full rounded-lg border border-border/60"
          : "h-0 w-0",
      )}
    />
  );
}

/**
 * Page preview image at the top of the hover card. Renders nothing until the
 * image has actually loaded (and nothing at all on error), so a dead or slow
 * URL never leaves a blank band above the text.
 */
function SourceImage({ source }: { source: SearchSource }): React.JSX.Element | null {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!source.image || failed) return null;
  return (
    <img
      src={source.image}
      alt=""
      loading="lazy"
      className={cn(
        "object-cover",
        // Bleed through HoverCardContent's p-2.5 so the image is flush with the
        // card's top and side edges; only pull the margins once loaded, or the
        // h-0 placeholder would shift the text content up by the padding.
        loaded
          ? "-mx-2.5 -mt-2.5 max-h-32 w-[calc(100%+1.25rem)] max-w-none rounded-t-lg"
          : "h-0 w-full",
      )}
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
    />
  );
}

/** The card body shown on hover: preview image, domain row, title, snippet. */
function SourceCardBody({
  source,
  onOpen,
}: {
  source: SearchSource;
  onOpen: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col items-start gap-1 text-left"
    >
      <SourceImage source={source} />
      <span className="flex w-full items-center gap-1.5 text-xs text-muted-foreground">
        <Favicon source={source} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">{source.domain}</span>
      </span>
      <span className="line-clamp-2 w-full wrap-break-word text-sm font-medium leading-snug text-foreground">
        {source.title}
      </span>
      {source.snippet && (
        <span className="line-clamp-3 w-full wrap-break-word text-xs leading-relaxed text-muted-foreground">
          {source.snippet}
        </span>
      )}
    </button>
  );
}

/**
 * The "Sources" list rendered beneath an assistant answer that used web search:
 * a numbered, clickable index of every result the answer drew on. Mirrors the
 * inline chips' source registry.
 */
export function SourcesList({
  sources,
}: {
  sources: SearchSource[];
}): React.JSX.Element | null {
  const { t } = useTranslation();
  // Collapsed by default — the answer carries itself; the source index is there
  // to expand on demand, not to crowd the thread. Mirrors the tool-row pattern.
  const [open, setOpen] = useState(false);
  if (sources.length === 0) return null;
  // Order by citation number, not arrival order: parallel searches get their id
  // blocks in fetch-resolution order, but the registry accumulates them in
  // tool-call order, so a slower first search lands its higher ids ahead of a
  // faster later one (e.g. 9,10,…,1,2). Sort a copy for display — ids are unique,
  // so this is purely cosmetic and doesn't touch chip resolution (which is by id).
  // Every id keeps its own row (no URL dedupe), so any number a chip shows can
  // be found in this list — even when two searches returned the same page.
  const ordered = [...sources].sort((a, b) => a.i - b.i);
  return (
    <div className="mt-3 border-t border-border/60 pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
            open && "rotate-90",
          )}
          strokeWidth={2}
        />
        <span>
          {t("citations.sources")} · {sources.length}
        </span>
      </button>
      {/* grid-cols-1 forces the track to minmax(0,1fr) so it can't grow past
          the column; min-w-0 on each row lets it shrink below its content's
          min-content width, which is what lets the title actually truncate. */}
      {open && (
        <div className="mt-1 grid grid-cols-1 gap-1">
          {ordered.map((s) => (
            <button
              key={s.i}
              type="button"
              onClick={() => openSource(s.url)}
              title={s.url}
              className="group flex w-full min-w-0 max-w-2xl items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/50"
            >
              <span className="inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-muted px-1 text-[0.65rem] font-medium tabular-nums text-muted-foreground">
                {s.i}
              </span>
              <Favicon source={s} className="size-3.5 shrink-0" />
              <span className="max-w-3xl shrink-0 truncate text-xs text-muted-foreground">
                {s.domain}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-foreground/80 group-hover:text-foreground">
                {s.title}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
