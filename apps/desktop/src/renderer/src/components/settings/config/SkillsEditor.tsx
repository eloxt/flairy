import { useTranslation } from 'react-i18next'
import { IconTrash } from '@tabler/icons-react'
import type { SkillConfig, SkillFile } from '@flairy/shared'
import { Button } from '@/components/ui/button'
import { AddButton, Field, ItemCard, SwitchRow, TextAreaField, TextField } from './primitives'

let counter = 0
function newId(prefix: string): string {
  counter += 1
  return `local-${prefix}-${Date.now()}-${counter}`
}

function blankSkill(): SkillConfig {
  return {
    id: newId('skill'),
    name: '',
    description: '',
    metadata: {},
    extraFrontmatter: {},
    allowedTools: '',
    skillMdBody: '',
    enabled: true,
    fileCount: 0,
    createdAt: '',
    updatedAt: '',
    files: []
  }
}

function blankFile(): SkillFile {
  return {
    id: newId('file'),
    skillId: '',
    path: '',
    sourceType: 'text',
    content: '',
    mimeType: 'text/plain',
    fileSizeBytes: 0,
    createdAt: '',
    updatedAt: ''
  }
}

export function SkillsEditor({
  value,
  onChange
}: {
  value: SkillConfig[]
  onChange: (next: SkillConfig[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const update = (i: number, patch: Partial<SkillConfig>): void =>
    onChange(value.map((s, idx) => (idx === i ? { ...s, ...patch } : s)))

  return (
    <div className="space-y-4">
      {value.length === 0 && (
        <p className="text-[12px] text-muted-foreground">{t('settings.config.skillsEmpty')}</p>
      )}
      {value.map((skill, i) => (
        <ItemCard
          key={skill.id}
          title={skill.name || t('settings.config.skillsAdd')}
          onRemove={() => onChange(value.filter((_, idx) => idx !== i))}
        >
          <SwitchRow
            label={t('settings.config.enabled')}
            checked={skill.enabled}
            onChange={(enabled) => update(i, { enabled })}
          />
          <TextField
            label={t('settings.config.name')}
            value={skill.name}
            onChange={(name) => update(i, { name })}
          />
          <TextField
            label={t('settings.config.skillDescription')}
            value={skill.description}
            onChange={(description) => update(i, { description })}
          />
          <TextField
            label={t('settings.config.allowedTools')}
            value={skill.allowedTools ?? ''}
            onChange={(allowedTools) => update(i, { allowedTools })}
          />
          <TextAreaField
            label={t('settings.config.skillBody')}
            value={skill.skillMdBody}
            rows={8}
            mono
            onChange={(skillMdBody) => update(i, { skillMdBody })}
          />
          <FilesEditor files={skill.files} onChange={(files) => update(i, { files })} />
        </ItemCard>
      ))}
      <AddButton label={t('settings.config.skillsAdd')} onClick={() => onChange([...value, blankSkill()])} />
    </div>
  )
}

function FilesEditor({
  files,
  onChange
}: {
  files: SkillFile[]
  onChange: (next: SkillFile[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const update = (i: number, patch: Partial<SkillFile>): void =>
    onChange(files.map((f, idx) => (idx === i ? { ...f, ...patch } : f)))

  return (
    <Field label={t('settings.config.skillFiles')}>
      <div className="space-y-2">
        {files.map((file, i) => (
          <div key={file.id} className="space-y-2 rounded-md border border-border/50 p-2">
            <div className="flex items-center gap-2">
              <TextField
                label={t('settings.config.skillFilePath')}
                value={file.path}
                onChange={(path) => update(i, { path })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="mt-5 size-7 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => onChange(files.filter((_, idx) => idx !== i))}
              >
                <IconTrash className="size-3.5" />
              </Button>
            </div>
            <TextAreaField
              label={t('settings.config.skillFileContent')}
              value={file.content ?? ''}
              rows={3}
              mono
              onChange={(content) => update(i, { content, sourceType: 'text' })}
            />
          </div>
        ))}
        <AddButton label={t('settings.config.skillAddFile')} onClick={() => onChange([...files, blankFile()])} />
      </div>
    </Field>
  )
}
