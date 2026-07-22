import { Trash2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'

/**
 * Small form primitives shared by the Advanced-settings local-config editors.
 * Deliberately plain (label + control stacked) — this is a power-user surface,
 * denser than the macOS-style rows used elsewhere in Settings.
 */

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] font-medium text-foreground/80">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  )
}

export function TextField({
  label,
  hint,
  value,
  onChange,
  placeholder,
  type = 'text'
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
}): React.JSX.Element {
  return (
    <Field label={label} hint={hint}>
      <Input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-[13px]"
      />
    </Field>
  )
}

export function SecretField({
  label,
  hint,
  value,
  onChange
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
}): React.JSX.Element {
  return <TextField label={label} hint={hint} value={value} onChange={onChange} type="password" />
}

export function NumberField({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string
  value: number | undefined
  onChange: (v: number | undefined) => void
  placeholder?: string
}): React.JSX.Element {
  return (
    <Field label={label}>
      <Input
        type="number"
        value={value ?? ''}
        placeholder={placeholder}
        onChange={(e) => {
          const n = e.target.value === '' ? undefined : Number(e.target.value)
          onChange(n != null && Number.isFinite(n) ? n : undefined)
        }}
        className="h-8 text-[13px]"
      />
    </Field>
  )
}

export function TextAreaField({
  label,
  hint,
  value,
  onChange,
  rows = 4,
  mono
}: {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  rows?: number
  mono?: boolean
}): React.JSX.Element {
  return (
    <Field label={label} hint={hint}>
      <textarea
        value={value}
        rows={rows}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'w-full rounded-md border border-input bg-transparent px-3 py-2 text-[13px] shadow-xs outline-none',
          'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          mono && 'font-mono text-[12px]'
        )}
      />
    </Field>
  )
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}): React.JSX.Element {
  return (
    <Field label={label}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-[13px] shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

export function SwitchRow({
  label,
  checked,
  onChange
}: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-[12px] font-medium text-foreground/80">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  )
}

/** A bordered card wrapping one list item (an MCP server, a skill, …). */
export function ItemCard({
  title,
  onRemove,
  children
}: {
  title?: React.ReactNode
  onRemove?: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-3 rounded-lg border border-border/60 bg-card/40 p-3">
      {(title || onRemove) && (
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 truncate text-[12px] font-semibold">{title}</div>
          {onRemove && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={onRemove}
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      )}
      {children}
    </div>
  )
}

export function AddButton({
  label,
  onClick
}: {
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onClick}>
      <Plus className="size-3.5" />
      {label}
    </Button>
  )
}

/** Editor for a Record<string,string> map (MCP env / headers). */
export function KeyValueEditor({
  label,
  hint,
  entries,
  onChange,
  addLabel,
  keyLabel,
  valueLabel,
  secretValues
}: {
  label: string
  hint?: string
  entries: Record<string, string>
  onChange: (next: Record<string, string>) => void
  addLabel: string
  keyLabel: string
  valueLabel: string
  secretValues?: boolean
}): React.JSX.Element {
  const rows = Object.entries(entries)
  const setRow = (index: number, key: string, value: string): void => {
    const next: Record<string, string> = {}
    rows.forEach(([k, v], i) => {
      const nk = i === index ? key : k
      next[nk] = i === index ? value : v
    })
    onChange(next)
  }
  const removeRow = (index: number): void => {
    onChange(Object.fromEntries(rows.filter((_, i) => i !== index)))
  }
  return (
    <Field label={label} hint={hint}>
      <div className="space-y-2">
        {rows.map(([k, v], i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={k}
              placeholder={keyLabel}
              onChange={(e) => setRow(i, e.target.value, v)}
              className="h-8 flex-1 text-[13px]"
            />
            <Input
              value={v}
              type={secretValues ? 'password' : 'text'}
              placeholder={valueLabel}
              onChange={(e) => setRow(i, k, e.target.value)}
              className="h-8 flex-1 text-[13px]"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => removeRow(i)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
        <AddButton label={addLabel} onClick={() => onChange({ ...entries, '': '' })} />
      </div>
    </Field>
  )
}
