import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { IconArrowUp, IconHandLoveYou, IconSparkles, IconSquare } from '@tabler/icons-react'
import { useChat } from '@/store/chat-store'
import { useAuth } from '@/store/auth-store'
import { MessageList } from '@/components/chat/MessageList'
import { QuestionCard } from '@/components/chat/QuestionCard'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Native Liquid Glass mode: main appends `?glass=1` when the OS provides the
 * material (macOS — a real NSGlassEffectView sits BEHIND this page, corners
 * rounded and shadow cast natively). The renderer then paints no surface of
 * its own. Without it (Windows), the renderer paints the translucent tint +
 * CSS shadow inside a 24px transparent gutter.
 */
const GLASS_NATIVE = new URLSearchParams(window.location.search).has('glass')

/**
 * Window heights driven from the renderer (main clamps them to the display).
 * Collapsed = the capsule input row; expanded = input + streaming reply area.
 * CSS mode INCLUDES the 2×24px shadow gutter; native glass mode is exact.
 * Keep in sync with the LAUNCHER_* constants in `src/main/windows.ts`.
 */
const COLLAPSED_HEIGHT = GLASS_NATIVE ? 64 : 112
const EXPANDED_HEIGHT = GLASS_NATIVE ? 460 : 508

/**
 * The liquid-glass surface (Spotlight-esque): a translucent tint that lets the
 * desktop show through (a transparent Electron window can't blur what's behind
 * it, so the tint carries the look — same approach as the main window's
 * frosted rails), a hairline ring, a top inner highlight for the "glass" edge,
 * and a soft drop shadow whose falloff fades out inside the 24px gutter.
 */
const GLASS =
  'ring-1 ring-black/10 ' +
  'shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_10px_22px_-6px_rgba(0,0,0,0.28),0_2px_6px_rgba(0,0,0,0.12)] ' +
  'dark:ring-white/15 ' +
  'dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.10),0_10px_22px_-6px_rgba(0,0,0,0.55),0_2px_6px_rgba(0,0,0,0.30)]'

/** Collapsed capsule: properly glassy — only the input sits on it. */
const GLASS_TINT_CAPSULE = 'bg-white/85 dark:bg-neutral-900/85'

/** One key cap in a Raycast-style shortcut chip (⌘ / N / ⏎). */
function Key({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <kbd className="flex h-5 min-w-5 items-center justify-center rounded-[5px] bg-black/[0.06] px-1 font-sans text-[11px] font-medium text-muted-foreground dark:bg-white/10">
      {children}
    </kbd>
  )
}

/** One segment of the bottom action pill: label + its shortcut key caps. */
function PillAction({
  label,
  keys,
  onClick,
  disabled
}: {
  label: string
  keys: string[]
  onClick: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-[13px] font-medium text-foreground/85 transition-colors hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"
    >
      {label}
      <span className="flex items-center gap-0.5">
        {keys.map((k) => (
          <Key key={k}>{k}</Key>
        ))}
      </span>
    </button>
  )
}
/**
 * Expanded panel: fully opaque. Without real backdrop blur, sharp desktop
 * content ghosts through any translucency and fights the thread text for
 * legibility (the transparent-window compositor renders high-alpha tints far
 * more see-through than the same CSS on an opaque window) — reading the reply
 * wins over the glass effect here.
 */
const GLASS_TINT_PANEL = 'bg-white dark:bg-neutral-900'

/**
 * The quick-launcher (Spotlight-style) window: one input box summoned by a
 * global shortcut. Sending expands the card in place and streams the reply —
 * a full lightweight chat (follow-ups included) reusing the window-local
 * `useChat` store, which lazily creates a normal synced chat session (no
 * workspace) on the first send. A re-summon soon after hiding continues the
 * previous quick chat (main sends LauncherShown with `reset: false`); after
 * the keep window it starts fresh automatically, and the footer's new-chat
 * button (or ⌘/Ctrl+N) resets explicitly. Superseded conversations live on as
 * regular chats, reachable from the main window — or directly via the
 * "Open in main window" handoff button.
 */
export function LauncherApp(): React.JSX.Element {
  const { t } = useTranslation()
  const phase = useAuth((s) => s.phase)
  const checkStatus = useAuth((s) => s.checkStatus)
  const init = useChat((s) => s.init)
  const newChat = useChat((s) => s.newChat)
  const send = useChat((s) => s.send)
  const abort = useChat((s) => s.abort)
  const running = useChat((s) => s.running)
  // Boolean selector, NOT the messages array: the array changes reference on
  // every streamed token and would re-render this whole root (MessageList
  // subscribes to the store itself).
  const expanded = useChat((s) => s.messages.length > 0)
  const sessionId = useChat((s) => s.sessionId)
  const question = useChat((s) => s.questionQueue[0])
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  // Follow the signed-in state (login/logout can happen from any window).
  useEffect(() => {
    void checkStatus()
    return window.api.onAuthChanged(() => void checkStatus())
  }, [checkStatus])

  // Subscribe to the agent event stream (broadcast to every window; this
  // store only folds events for sessions it holds a runtime for).
  useEffect(() => init(), [init])

  // On summon: main decides whether the previous quick chat is still fresh
  // (`reset: false` → keep it, just put the caret back) or aged out (`reset:
  // true` → clear to a blank conversation). A superseded chat keeps streaming
  // in its background runtime and stays reachable from the main window.
  // Either way, reconcile the window height from the renderer's actual state —
  // the resize effect below only fires on CHANGES, so a summon that lands
  // mid-desync (e.g. across an HMR remount) would otherwise stick wrong.
  useEffect(() => {
    return window.api.onLauncherShown(({ reset }) => {
      if (reset) {
        void newChat()
        setText('')
      }
      const hasMessages = useChat.getState().messages.length > 0 && !reset
      void window.api.resizeLauncher(hasMessages ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT)
      taRef.current?.focus()
    })
  }, [newChat])

  // The window's height follows the content state: grow when the first
  // message lands, collapse back when a summon resets to a blank chat.
  useEffect(() => {
    void window.api.resizeLauncher(expanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT)
  }, [expanded])

  // Esc dismisses the launcher — unless a CJK IME composition is in flight
  // (then Esc cancels the composition, not the window). ⌘/Ctrl+N starts a
  // fresh conversation and ⌘/Ctrl+⏎ hands off to the main window (both
  // mirrored as the bottom action pill).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.isComposing) {
        void window.api.hideLauncher()
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        void newChat()
        setText('')
        taRef.current?.focus()
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        const sid = useChat.getState().sessionId
        if (sid) void window.api.openLauncherSessionInMain(sid)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newChat])

  const submit = (): void => {
    if (!text.trim() || phase !== 'authed') return
    void send(text)
    setText('')
  }

  // Hand off to the main window ('' when signed out: just brings it forward).
  const openInMain = (): void => {
    void window.api.openLauncherSessionInMain(sessionId ?? '')
  }

  // Explicit fresh conversation (footer button / ⌘N). The old chat lives on
  // as a regular session in the main window's sidebar.
  const startNewChat = (): void => {
    void newChat()
    setText('')
    taRef.current?.focus()
  }

  return (
    // Native glass: the card IS the window (the OS rounds + shadows it).
    // CSS mode: a transparent 24px gutter hosts the CSS shadow's falloff.
    <div className={cn('flex h-screen w-screen flex-col', !GLASS_NATIVE && 'p-6')}>
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-hidden',
          GLASS_NATIVE
            ? // Clip content to the native glass view's 32px corner radius;
              // the material behind carries all surface styling.
              'rounded-[32px]'
            : cn(
                GLASS,
                // Collapsed = a Spotlight capsule; expanded = a tall panel.
                expanded
                  ? cn('rounded-[26px]', GLASS_TINT_PANEL)
                  : cn('rounded-full', GLASS_TINT_CAPSULE)
              )
        )}
      >
        {phase === 'anon' ? (
          // Signed out: one plain-language line + a way into the main app.
          <div className="flex flex-1 items-center gap-3 px-6">
            <IconSparkles className="size-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-base text-muted-foreground">
              {t('launcher.signedOutHint')}
            </span>
            <Button size="sm" onClick={openInMain}>
              {t('launcher.openApp')}
            </Button>
          </div>
        ) : (
          (() => {
            // Shared Spotlight-scale input: big leading icon, large text,
            // single line (long text scrolls within). Rendered flat in the
            // collapsed capsule, and inside a floating glass block once the
            // conversation is going.
            const inputRow = (
              <>
                <IconHandLoveYou className="size-5 shrink-0 text-muted-foreground" />
                <textarea
                  ref={taRef}
                  autoFocus
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    // Ignore Enter while a CJK IME is composing (it confirms
                    // the candidate text, not the message). keyCode 229 covers
                    // browsers that don't set isComposing on the Enter keydown.
                    // ⌘/Ctrl+Enter falls through to the window handler (open
                    // in main window), so plain Enter alone submits.
                    if (e.nativeEvent.isComposing || e.keyCode === 229) return
                    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
                      e.preventDefault()
                      submit()
                    }
                  }}
                  placeholder={t('launcher.placeholder')}
                  rows={1}
                  className="h-8 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent font-medium text-[19px] leading-8 tracking-[-0.01em] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
                />
                {running ? (
                  <button
                    type="button"
                    onClick={abort}
                    aria-label={t('launcher.stop')}
                    title={t('launcher.stop')}
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-80"
                  >
                    <IconSquare className="size-3 fill-current" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={submit}
                    disabled={!text.trim()}
                    aria-label={t('launcher.send')}
                    title={t('launcher.send')}
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90',
                      // Spotlight shows nothing until you type — fade the send
                      // affordance out entirely while the input is empty.
                      text.trim() ? 'opacity-100' : 'pointer-events-none opacity-0'
                    )}
                  >
                    <IconArrowUp className="size-4" />
                  </button>
                )}
              </>
            )

            if (!expanded) {
              // Collapsed capsule: just the input row.
              return <div className="flex h-16 shrink-0 items-center gap-3.5 px-6">{inputRow}</div>
            }

            const mod = window.api.platform === 'darwin' ? '⌘' : 'Ctrl'
            return (
              // Expanded: the thread fills the whole panel; the input and the
              // action pill float over it, Raycast-style.
              <div className="relative min-h-0 flex-1">
                <MessageList />
                {/* Floating translucent input block. backdrop-blur works here
                    (unlike against the desktop): it blurs the thread content
                    scrolling beneath — same-page compositing. */}
                <div className="absolute inset-x-4 bottom-16">
                  {/* The `ask` tool's question card docks above the input. */}
                  {question && (
                    <div
                      key={question.questionId}
                      className="animate-in fade-in slide-in-from-bottom-2 mb-2 rounded-2xl bg-white/85 p-3 ring-1 ring-black/10 backdrop-blur-xl duration-300 dark:bg-neutral-800/85 dark:ring-white/10"
                    >
                      <QuestionCard payload={question} />
                    </div>
                  )}
                  {/* backdrop-blur can't render in this transparent window
                      (see windows.ts) — the tint alone carries legibility. */}
                  <div className="flex h-14 items-center gap-3.5 rounded-2xl bg-white/95 px-5 shadow-[0_8px_24px_rgba(0,0,0,0.14)] ring-1 ring-black/10 backdrop-blur-2xl dark:bg-neutral-800/95 dark:ring-white/10">
                    {inputRow}
                  </div>
                </div>
                {/* Bottom action pills — translucent, blurring the thread
                    beneath: new chat on the left, handoff on the right. */}
                <div className="absolute bottom-3 left-4 flex items-center rounded-[14px] bg-white/90 px-1 py-1 shadow-[0_6px_16px_rgba(0,0,0,0.12)] ring-1 ring-black/10 backdrop-blur-xl dark:bg-neutral-800/90 dark:ring-white/10">
                  <PillAction label={t('launcher.newChat')} keys={[mod, 'N']} onClick={startNewChat} />
                </div>
                <div className="absolute right-4 bottom-3 flex items-center rounded-[14px] bg-white/90 px-1 py-1 shadow-[0_6px_16px_rgba(0,0,0,0.12)] ring-1 ring-black/10 backdrop-blur-xl dark:bg-neutral-800/90 dark:ring-white/10">
                  <PillAction
                    label={t('launcher.openInMain')}
                    keys={[mod, '⏎']}
                    onClick={openInMain}
                    disabled={!sessionId}
                  />
                </div>
              </div>
            )
          })()
        )}
      </div>
    </div>
  )
}
