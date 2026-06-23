import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import { lazy, Suspense, type ComponentProps } from 'react'
import { CodeEditor, type CompletionItem } from '@/components/ui/codeEditor'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { cn } from '@/lib/utils'
import type { SkillFileEntry } from '@/lib/types/skills'
import {
  AlertTriangle,
  Braces,
  Check,
  Copy,
  Eye,
  FileText,
  Loader2,
  Plus,
  Save,
  Table2,
  X
} from 'lucide-react'
import { useState } from 'react'
import { type SkillFormReturn, composeFrontmatter } from './helpers'
import { FormSection, RailRow } from './shared'
import { FilePreviewPane } from './filePreview'
import { FileManagerSection } from './fileManagerView'
import { MetadataTableEditor } from './metadataEditorTableView'

const LazyMarkdown = lazy(() =>
  import('@/components/ui/markdown').then((m) => ({ default: m.Markdown }))
)
const Markdown = (props: ComponentProps<typeof LazyMarkdown>): React.JSX.Element => (
  <Suspense fallback={null}>
    <LazyMarkdown {...props} />
  </Suspense>
)

type DetailsPane = 'details' | 'metadata' | 'frontmatter'

/** The non-file sections of a skill, shown as rows in the left navigator. */
const SKILL_PANES: { key: DetailsPane; label: string; icon: typeof FileText }[] = [
  { key: 'details', label: 'Details', icon: FileText },
  { key: 'metadata', label: 'Metadata', icon: Table2 },
  { key: 'frontmatter', label: 'Extra frontmatter', icon: Braces }
]

export function SkillEditView({
  form,
  skillId,
  onSave,
  onCancel,
  isSaving,
  mode = 'edit'
}: {
  form: SkillFormReturn
  skillId?: string
  onSave: () => void
  onCancel: () => void
  isSaving: boolean
  mode?: 'edit' | 'create'
}): React.JSX.Element {
  const isCreate = mode === 'create'
  const [bodyTab, setBodyTab] = useState<'edit' | 'preview'>('edit')
  const [showPreviewDialog, setShowPreviewDialog] = useState(false)
  const [selectedFileIndex, setSelectedFileIndex] = useState<number | null>(null)
  const [selectedDetailsPane, setSelectedDetailsPane] = useState<
    'details' | 'metadata' | 'frontmatter' | null
  >('details')
  const selectedFile =
    selectedFileIndex != null ? (form.files[selectedFileIndex] ?? null) : null

  const { copy: copyPreviewContent, copied: copiedPreviewContent } = useCopyToClipboard({
    successMessage: 'Copied raw SKILL.md',
    errorMessage: 'Failed to copy raw SKILL.md'
  })

  const previewContent =
    composeFrontmatter({
      name: form.name,
      description: form.description,
      license: form.license,
      compatibility: form.compatibility,
      allowed_tools: form.allowedTools,
      extra_frontmatter_json: form.extraFrontmatterJson,
      metadata_json: form.metadataJson
    }) +
    '\n\n' +
    form.skillMdBody

  const filePathCompletions = buildFilePathCompletions(form.files)

  const descriptionLength = form.description.length
  let descriptionLimitColor = 'text-muted-foreground'
  if (descriptionLength > 1024) {
    descriptionLimitColor = 'text-destructive'
  } else if (descriptionLength > 900) {
    descriptionLimitColor = 'text-foreground font-medium'
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {isCreate && (
        <div className="shrink-0 border-b px-4 py-4">
          <FormSection title="Name">
            <Input
              value={form.name}
              onChange={(e) => {
                form.setName(e.target.value)
                form.validateField('name', e.target.value)
              }}
              placeholder="my-skill-name"
              className={cn('font-mono', form.errors.name && 'border-destructive')}
            />
            {form.errors.name && (
              <p className="text-destructive text-xs" role="alert">
                {form.errors.name}
              </p>
            )}
            <p className="text-muted-foreground text-xs">
              Lowercase letters, numbers, and hyphens only.{' '}
              <span className="font-medium text-foreground">Cannot be changed after creation.</span>
            </p>
          </FormSection>
        </div>
      )}

      {/* Files + SKILL.md two-pane workspace */}
      <div className="min-h-0 flex-1 px-4 pt-4 pb-2">
        <div className="flex h-full min-h-0 gap-3">
          {/* Left: one unified navigator — frontmatter sections + files. */}
          <div className="bg-card flex min-h-0 w-64 shrink-0 flex-col overflow-hidden rounded-lg border hairline">
            <div className="shrink-0 p-2">
              <div className="eyebrow px-2 pt-1 pb-1.5">Skill</div>
              <div className="flex flex-col gap-0.5">
                {SKILL_PANES.map(({ key, label, icon: Icon }) => (
                  <RailRow
                    key={key}
                    icon={Icon}
                    label={label}
                    active={selectedDetailsPane === key}
                    onClick={() => {
                      setSelectedDetailsPane(key)
                      setSelectedFileIndex(null)
                    }}
                  />
                ))}
              </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col border-t">
              <div className="eyebrow shrink-0 px-4 pt-3 pb-1.5">Files</div>
              <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
                <FileManagerSection
                  files={form.files}
                  onAddFile={form.addFile}
                  onRemoveFile={form.removeFile}
                  onUpdateFile={form.updateFile}
                  readOnly={false}
                  selectedIndex={selectedDetailsPane == null ? selectedFileIndex : null}
                  onSelectFile={(index) => {
                    setSelectedDetailsPane(null)
                    setSelectedFileIndex(index)
                  }}
                  bodySelected={selectedFile == null && selectedDetailsPane == null}
                  hasBodyError={!form.skillMdBody.trim()}
                  onSelectBody={() => {
                    setSelectedDetailsPane(null)
                    setSelectedFileIndex(null)
                  }}
                />
              </ScrollArea>
            </div>
          </div>

          {/* Right: editor for the selected item */}
          <div className="flex min-h-0 grow flex-col overflow-auto">
            {selectedDetailsPane === 'details' ? (
              <DetailsEditorPane
                form={form}
                descriptionLength={descriptionLength}
                descriptionLimitColor={descriptionLimitColor}
              />
            ) : selectedDetailsPane === 'metadata' ? (
              <MetadataEditorPane form={form} />
            ) : selectedDetailsPane === 'frontmatter' ? (
              <ExtraFrontmatterEditorPane form={form} />
            ) : selectedFile ? (
              <FilePreviewPane
                key={selectedFile.path}
                file={selectedFile}
                skillId={skillId ?? ''}
                mode="edit"
                onFileUpdate={(updates) => {
                  if (selectedFileIndex == null) return
                  form.updateFile(selectedFileIndex, updates)
                }}
              />
            ) : (
              <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border hairline">
                <div
                  className="flex h-10 shrink-0 items-center gap-2 border-b px-2"
                  role="tablist"
                  aria-label="Body editor tabs"
                >
                  <span className="eyebrow px-1">SKILL.md</span>
                  <div className="flex items-center gap-0.5">
                    {(['edit', 'preview'] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        className={cn(
                          'cursor-pointer rounded-md px-2.5 py-1 text-xs capitalize transition-colors',
                          bodyTab === tab
                            ? 'bg-accent font-medium text-accent-foreground'
                            : 'text-muted-foreground hover:text-foreground'
                        )}
                        onClick={() => setBodyTab(tab)}
                        role="tab"
                        aria-selected={bodyTab === tab}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>
                  <span className="text-muted-foreground ml-auto pr-1 text-xs">
                    Use <code className="font-mono">@</code> to reference files
                  </span>
                </div>
                <div className="min-h-0 grow overflow-y-auto">
                  {bodyTab === 'edit' ? (
                    <CodeEditor
                      className="z-0 w-full"
                      code={form.skillMdBody}
                      lang="markdown"
                      onChange={(value: string) => form.setSkillMdBody(value)}
                      height="100%"
                      wrap
                      customCompletions={filePathCompletions}
                      options={{
                        showVerticalScrollbar: true,
                        scrollBeyondLastLine: false,
                        lineNumbers: 'on',
                        alwaysConsumeMouseWheel: false,
                        quickSuggestions: false
                      }}
                    />
                  ) : (
                    <div className="p-4">
                      <Markdown content={form.skillMdBody || ''} className="text-sm" />
                    </div>
                  )}
                </div>
                {(form.errors.skill_md_body || form.bodyWarning) && (
                  <div className="shrink-0 border-t px-3 py-1.5">
                    {form.errors.skill_md_body && (
                      <p className="text-destructive text-xs" role="alert">
                        {form.errors.skill_md_body}
                      </p>
                    )}
                    {form.bodyWarning && (
                      <p
                        className="text-muted-foreground flex items-center gap-1.5 text-xs"
                        role="status"
                      >
                        <AlertTriangle className="size-3.5 shrink-0" />
                        {form.bodyWarning}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="bg-card flex shrink-0 items-center justify-end gap-2 border-t px-4 py-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          className="text-muted-foreground hover:bg-transparent hover:text-destructive"
        >
          Cancel
        </Button>
        <Button variant="outline" size="sm" onClick={() => setShowPreviewDialog(true)}>
          <Eye className="h-3.5 w-3.5" />
          Preview Raw SKILL.md
        </Button>
        <Button size="sm" onClick={onSave} disabled={isSaving || form.hasErrors}>
          {isSaving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : isCreate ? (
            <Plus className="h-3.5 w-3.5" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {isSaving ? (isCreate ? 'Creating...' : 'Saving...') : isCreate ? 'Create Skill' : 'Save'}
        </Button>
      </div>

      {/* Preview SKILL.md Dialog */}
      <Dialog open={showPreviewDialog} onOpenChange={setShowPreviewDialog}>
        <DialogContent
          showCloseButton={false}
          className="border-0 p-0 shadow-none sm:w-4/5 sm:max-w-4xl md:w-1/2 md:max-w-3xl"
        >
          <DialogHeader className="sr-only">
            <DialogTitle>SKILL.md Preview</DialogTitle>
          </DialogHeader>
          <div className="bg-muted relative overflow-hidden rounded-sm border shadow-lg">
            <div className="absolute top-3 right-3 z-10 flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="bg-background/70 text-muted-foreground hover:bg-background/90 hover:text-foreground h-8 w-8 rounded-sm"
                onClick={() => void copyPreviewContent(previewContent)}
                aria-label={copiedPreviewContent ? 'Raw SKILL.md copied' : 'Copy raw SKILL.md'}
              >
                {copiedPreviewContent ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </Button>
              <DialogClose className="text-muted-foreground hover:bg-background/80 hover:text-foreground cursor-pointer rounded-sm p-1.5 transition-colors">
                <X className="h-4 w-4" />
                <span className="sr-only">Close</span>
              </DialogClose>
            </div>
            <ScrollArea className="h-dvh">
              <pre className="bg-muted min-h-96 p-5 pr-24 font-mono text-xs leading-5 whitespace-pre-wrap">
                {previewContent}
              </pre>
            </ScrollArea>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Build autocomplete items for referencing skill files with @[name](path) syntax. */
function buildFilePathCompletions(files: SkillFileEntry[]): CompletionItem[] {
  const completions: CompletionItem[] = []
  const folderPaths = new Set<string>()

  for (const file of files) {
    if (!file.path) continue
    const pathParts = file.path.split('/').filter(Boolean)
    const fileName = pathParts.at(-1) ?? file.path
    const rootRelativePath = `./${file.path}`

    for (let i = 0; i < pathParts.length - 1; i++) {
      folderPaths.add(pathParts.slice(0, i + 1).join('/'))
    }

    completions.push({
      label: fileName,
      insertText: `@[${fileName}](${rootRelativePath})`,
      type: 'object' as const,
      description: rootRelativePath,
      documentation: `Full path: ${rootRelativePath}`
    })
  }

  for (const folderPath of folderPaths) {
    const folderName = folderPath.split('/').filter(Boolean).pop() ?? folderPath
    const rootRelativePath = `./${folderPath}/`
    completions.push({
      label: folderName,
      insertText: `@[${folderName}](${rootRelativePath})`,
      type: 'folder' as const,
      description: rootRelativePath,
      documentation: `Full path: ${rootRelativePath}`
    })
  }

  return completions.sort((a, b) => a.description?.localeCompare(b.description ?? '') ?? 0)
}

function DetailsEditorPane({
  form,
  descriptionLength,
  descriptionLimitColor
}: {
  form: SkillFormReturn
  descriptionLength: number
  descriptionLimitColor: string
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-9 shrink-0 items-center gap-2 px-1">
        <span className="eyebrow">Details</span>
        <span className="text-muted-foreground text-xs">
          Edit the skill description and spec fields
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1 rounded-lg border hairline">
        <div className="flex flex-col gap-8 p-4">
          <FormSection title="Description">
            <div className="flex flex-col gap-2">
              <Textarea
                value={form.description}
                onChange={(e) => {
                  form.setDescription(e.target.value)
                  form.validateField('description', e.target.value)
                }}
                placeholder="What does this skill do?"
                rows={3}
                className={form.errors.description ? 'border-destructive' : undefined}
              />
              <div className="flex justify-between">
                <span className={`text-xs tabular-nums transition-colors ${descriptionLimitColor}`}>
                  {descriptionLength}/1024
                </span>
                {form.errors.description ? (
                  <p className="text-destructive text-xs" role="alert">
                    {form.errors.description}
                  </p>
                ) : (
                  <span />
                )}
              </div>
            </div>
          </FormSection>

          <FormSection title="Spec Fields">
            <div className="grid grid-cols-3 gap-4">
              <div className="flex flex-col gap-1.5">
                <Label className="text-muted-foreground text-xs">License</Label>
                <Input
                  value={form.license}
                  onChange={(e) => form.setLicense(e.target.value)}
                  placeholder="MIT (optional)"
                  className="text-sm"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-muted-foreground text-xs">Compatibility</Label>
                <Input
                  value={form.compatibility}
                  onChange={(e) => form.setCompatibility(e.target.value)}
                  placeholder="Claude Code, Codex (optional)"
                  className="text-sm"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-muted-foreground text-xs">Allowed Tools</Label>
                <Input
                  value={form.allowedTools}
                  onChange={(e) => form.setAllowedTools(e.target.value)}
                  placeholder="Bash Read Grep (optional)"
                  className="text-sm"
                />
              </div>
            </div>
          </FormSection>
        </div>
      </ScrollArea>
    </div>
  )
}

function MetadataEditorPane({ form }: { form: SkillFormReturn }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-9 shrink-0 items-center gap-2 px-1">
        <span className="eyebrow">Metadata</span>
        <span className="text-muted-foreground text-xs">
          Flat key-value pairs nested under <code className="font-mono">metadata:</code> in SKILL.md
        </span>
      </div>
      <ScrollArea className="min-h-0 flex-1 rounded-lg border hairline">
        <div className="p-3">
          <MetadataTableEditor
            metadataJson={form.metadataJson}
            onChange={(json) => {
              form.setMetadataJson(json)
              form.validateField('metadata', json)
            }}
            error={form.errors.metadata}
          />
        </div>
      </ScrollArea>
    </div>
  )
}

function ExtraFrontmatterEditorPane({ form }: { form: SkillFormReturn }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex h-9 shrink-0 items-center gap-2 px-1">
        <span className="eyebrow">Extra Frontmatter</span>
        <span className="text-muted-foreground text-xs">
          Valid JSON merged into the SKILL.md YAML frontmatter
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 rounded-lg border hairline p-3">
        <div className="min-h-0 flex-1 overflow-hidden">
          <CodeEditor
            className="z-0 w-full"
            code={form.extraFrontmatterJson}
            lang="json"
            onChange={(value: string) => {
              form.setExtraFrontmatterJson(value)
              form.validateField('extra_frontmatter', value)
            }}
            height="100%"
            wrap
            options={{
              showVerticalScrollbar: true,
              scrollBeyondLastLine: false,
              lineNumbers: 'on',
              alwaysConsumeMouseWheel: false
            }}
          />
        </div>
        {form.errors.extra_frontmatter && (
          <p className="text-destructive shrink-0 text-xs" role="alert">
            {form.errors.extra_frontmatter}
          </p>
        )}
      </div>
    </div>
  )
}
