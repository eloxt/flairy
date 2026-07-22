import { useTranslation } from 'react-i18next'
import type { McpServerConfig, McpTransport } from '@flairy/shared'
import {
  AddButton,
  ItemCard,
  KeyValueEditor,
  SelectField,
  SwitchRow,
  TextAreaField,
  TextField
} from './primitives'

type TransportKind = McpTransport['kind']

let counter = 0
function newId(): string {
  counter += 1
  return `local-mcp-${Date.now()}-${counter}`
}

function blankServer(): McpServerConfig {
  return {
    id: newId(),
    name: '',
    transport: { kind: 'stdio', command: '', args: [] },
    allowedTools: [],
    enabled: true
  }
}

export function McpEditor({
  value,
  onChange
}: {
  value: McpServerConfig[]
  onChange: (next: McpServerConfig[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const update = (i: number, patch: Partial<McpServerConfig>): void =>
    onChange(value.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))

  return (
    <div className="space-y-4">
      {value.length === 0 && (
        <p className="text-[12px] text-muted-foreground">{t('settings.advanced.mcpEmpty')}</p>
      )}
      {value.map((server, i) => (
        <ItemCard
          key={server.id}
          title={server.name || t('settings.advanced.mcpAddServer')}
          onRemove={() => onChange(value.filter((_, idx) => idx !== i))}
        >
          <SwitchRow
            label={t('settings.advanced.enabled')}
            checked={server.enabled}
            onChange={(enabled) => update(i, { enabled })}
          />
          <TextField
            label={t('settings.advanced.name')}
            value={server.name}
            onChange={(name) => update(i, { name })}
          />
          <SelectField
            label={t('settings.advanced.transportKind')}
            value={server.transport.kind}
            options={[
              { value: 'stdio', label: 'stdio' },
              { value: 'sse', label: 'sse' },
              { value: 'http', label: 'http' }
            ]}
            onChange={(kind: TransportKind) => update(i, { transport: switchTransport(server.transport, kind) })}
          />
          <TransportFields transport={server.transport} onChange={(transport) => update(i, { transport })} />
          <TextAreaField
            label={t('settings.advanced.allowedTools')}
            value={server.allowedTools.join('\n')}
            rows={2}
            onChange={(text) =>
              update(i, { allowedTools: text.split('\n').map((s) => s.trim()).filter(Boolean) })
            }
          />
        </ItemCard>
      ))}
      <AddButton label={t('settings.advanced.mcpAddServer')} onClick={() => onChange([...value, blankServer()])} />
    </div>
  )
}

/** Convert a transport to a different kind, preserving what carries over. */
function switchTransport(prev: McpTransport, kind: TransportKind): McpTransport {
  if (kind === prev.kind) return prev
  if (kind === 'stdio') return { kind: 'stdio', command: '', args: [] }
  const url = prev.kind === 'stdio' ? '' : prev.url
  return { kind, url, headers: prev.kind === 'stdio' ? undefined : prev.headers }
}

function TransportFields({
  transport,
  onChange
}: {
  transport: McpTransport
  onChange: (next: McpTransport) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  if (transport.kind === 'stdio') {
    return (
      <>
        <TextField
          label={t('settings.advanced.command')}
          value={transport.command}
          onChange={(command) => onChange({ ...transport, command })}
        />
        <TextAreaField
          label={t('settings.advanced.args')}
          value={(transport.args ?? []).join('\n')}
          rows={2}
          onChange={(text) =>
            onChange({ ...transport, args: text.split('\n').map((s) => s).filter((s) => s.length > 0) })
          }
        />
        <KeyValueEditor
          label={t('settings.advanced.env')}
          entries={transport.env ?? {}}
          onChange={(env) => onChange({ ...transport, env })}
          addLabel={t('settings.advanced.addPair')}
          keyLabel={t('settings.advanced.key')}
          valueLabel={t('settings.advanced.value')}
          secretValues
        />
      </>
    )
  }
  return (
    <>
      <TextField
        label={t('settings.advanced.url')}
        value={transport.url}
        onChange={(url) => onChange({ ...transport, url })}
      />
      <KeyValueEditor
        label={t('settings.advanced.headers')}
        entries={transport.headers ?? {}}
        onChange={(headers) => onChange({ ...transport, headers })}
        addLabel={t('settings.advanced.addPair')}
        keyLabel={t('settings.advanced.key')}
        valueLabel={t('settings.advanced.value')}
        secretValues
      />
    </>
  )
}
