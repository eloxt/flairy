import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * Edits a Record<string, string> (env vars / headers) as a list of key/value
 * rows. Empty-keyed rows are dropped on serialization by the caller via toRecord.
 */
export interface KvRow {
  key: string
  value: string
}

export function recordToRows(record: Record<string, string> | undefined): KvRow[] {
  if (!record) return []
  return Object.entries(record).map(([key, value]) => ({ key, value }))
}

export function rowsToRecord(rows: KvRow[]): Record<string, string> | undefined {
  const entries = rows
    .map((r) => [r.key.trim(), r.value] as const)
    .filter(([k]) => k.length > 0)
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries)
}

export function KeyValueEditor({
  label,
  rows,
  onChange
}: {
  label: string
  rows: KvRow[]
  onChange: (rows: KvRow[]) => void
}): React.JSX.Element {
  function update(index: number, patch: Partial<KvRow>): void {
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }
  function remove(index: number): void {
    onChange(rows.filter((_, i) => i !== index))
  }
  function add(): void {
    onChange([...rows, { key: '', value: '' }])
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <Button type="button" variant="outline" size="sm" onClick={add}>
          <Plus className="size-3.5" />
          Add
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">None.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input
                placeholder="key"
                value={row.key}
                onChange={(e) => update(i, { key: e.target.value })}
              />
              <Input
                placeholder="value"
                value={row.value}
                onChange={(e) => update(i, { value: e.target.value })}
              />
              <Button type="button" variant="ghost" size="icon" onClick={() => remove(i)}>
                <X className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
