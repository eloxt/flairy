import { KeyValueEditor, recordToRows, rowsToRecord } from '@/components/KeyValueEditor'

// ---------- MetadataTableEditor ----------
// Edits the flat string→string metadata map. The form stores metadata as a
// JSON string; this component parses/serializes around the KeyValueEditor rows.

export function MetadataTableEditor({
  metadataJson,
  onChange,
  error
}: {
  metadataJson: string
  onChange: (json: string) => void
  error?: string
}): React.JSX.Element {
  let parsedValue: Record<string, string> = {}
  if (metadataJson.trim()) {
    try {
      const parsed = JSON.parse(metadataJson) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        parsedValue = Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).map(([key, value]) => [
            key,
            String(value ?? '')
          ])
        )
      }
    } catch {
      // Invalid JSON, fall back to empty.
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <KeyValueEditor
        label="Metadata"
        rows={recordToRows(parsedValue)}
        onChange={(rows) => {
          const record = rowsToRecord(rows)
          if (!record) {
            onChange('')
            return
          }
          onChange(JSON.stringify(record, null, 2))
        }}
      />
      {error && (
        <p className="text-destructive text-xs mt-1" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
