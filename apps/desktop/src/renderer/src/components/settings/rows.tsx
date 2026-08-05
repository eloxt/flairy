import { cn } from '@/lib/utils'

/**
 * Native-settings primitives shared by the Settings sections (macOS System
 * Settings style: inset hairline groups of label/control rows).
 */

/** Inset list box: rounded hairline card, rows separated by hairlines. */
export function Group({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        // Hairline edge + faint lift in one box-shadow (the `.hairline` utility
        // and a Tailwind shadow-* would overwrite each other).
        'divide-y divide-border/60 overflow-hidden rounded-[10px] bg-card shadow-[inset_0_0_0_0.5px_var(--border),0_1px_2px_rgb(0_0_0/0.04)]',
        className
      )}
    >
      {children}
    </div>
  )
}

/** Tiny uppercase label above a group. */
export function GroupLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="eyebrow mx-0.5 mt-6 mb-2 first:mt-0">{children}</div>
}

/** One setting: label + optional description left, the control in place right. */
export function Row({
  label,
  description,
  children
}: {
  label: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-h-[46px] items-center gap-4 px-3.5 py-2">
      <div className="min-w-0 flex-1 py-0.5">
        <div className="text-[13px] leading-tight">{label}</div>
        {description && (
          <div className="mt-0.5 max-w-[46ch] text-[11.5px] leading-snug text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

/** Right-aligned read-only value in a Row. */
export function RowValue({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="text-[13px] break-all text-muted-foreground">{children}</span>
}

/** Full-width tappable row (sign out, clear all). */
export function RowButton({
  danger,
  onClick,
  children
}: {
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex min-h-11 w-full items-center px-3.5 py-2 text-left text-[13px] transition-colors hover:bg-accent',
        danger && 'text-destructive'
      )}
    >
      {children}
    </button>
  )
}

/** Centered muted placeholder inside a Group (loading / empty states). */
export function EmptyRow({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="px-3.5 py-6 text-center text-[12.5px] text-muted-foreground">{children}</div>
  )
}

/** Introductory paragraph above a group. */
export function Lede({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="mb-3 max-w-[52ch] text-[12.5px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}

/** Footnote below a group. */
export function Caption({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="mx-0.5 mt-2 max-w-[56ch] text-[11.5px] leading-relaxed text-muted-foreground">
      {children}
    </p>
  )
}

/** Connection state dot: green = live, gray = off/paused. */
export function StatusDot({ ok }: { ok: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        ok ? 'bg-emerald-500 ring-[3px] ring-emerald-500/20' : 'bg-muted-foreground/50'
      )}
    />
  )
}

/** macOS-style segmented control (muted track, raised thumb). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  ariaLabel?: string
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="flex shrink-0 gap-px rounded-[7px] bg-muted p-0.5"
    >
      {options.map(({ value: v, label }) => (
        <button
          key={v}
          type="button"
          aria-pressed={v === value}
          onClick={() => onChange(v)}
          className={cn(
            'rounded-[5.5px] px-3 py-1 text-xs transition-colors',
            v === value
              ? 'bg-background font-medium text-foreground shadow-sm dark:bg-[oklch(0.32_0_0)]'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
