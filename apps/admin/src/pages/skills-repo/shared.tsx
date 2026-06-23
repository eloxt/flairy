import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { lazy, Suspense, type ComponentProps } from 'react'
import { Tree, type BaseNodeData, type TreeNode } from '@/components/ui/tree-view'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { fetchSkillFileObjectUrl } from '@/api/client'
import type { SkillFileEntry } from '@/lib/types/skills'
import { cn } from '@/lib/utils'
import {
  Check,
  Bot,
  BookOpen,
  Braces,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ArrowLeft,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  Hammer,
  MoreHorizontal,
  Scale,
  Table2,
  X
} from 'lucide-react'
import { useState, useMemo } from 'react'
import { formatYamlRecord } from './helpers'
import { FilePreviewPane } from './filePreview'

const LazyMarkdown = lazy(() =>
  import('@/components/ui/markdown').then((m) => ({ default: m.Markdown }))
)
const Markdown = (props: ComponentProps<typeof LazyMarkdown>): React.JSX.Element => (
  <Suspense fallback={null}>
    <LazyMarkdown {...props} />
  </Suspense>
)

// Sentinel used as the "selected file" value for the SKILL.md body node.
export const SKILLMD_KEY = '__skillmd__'

/**
 * One row in a skill's left navigator. Shared by the read-only detail view and
 * the editor so both rails look identical. Active state mirrors the app sidebar.
 */
export function RailRow({
  icon: Icon,
  label,
  active,
  onClick
}: {
  icon: typeof FileText
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors',
        active
          ? 'bg-accent text-accent-foreground font-medium'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
    </button>
  )
}

// ---------- HeaderMetaItem ----------

export function HeaderMetaItem({
  label,
  value,
  missingText,
  icon: Icon
}: {
  label: string
  value?: string
  missingText: string
  icon: typeof Scale
}): React.JSX.Element {
  const hasValue = Boolean(value?.trim())

  const pill = (
    <div
      className={cn(
        'inline-flex max-w-full items-center gap-1.5 rounded-sm border bg-muted/20 px-2.5 py-1 text-xs',
        !hasValue && 'text-muted-foreground'
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className={cn('truncate', hasValue && 'font-mono')}>{hasValue ? value : missingText}</span>
    </div>
  )

  if (!hasValue) return pill

  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>{pill}</TooltipTrigger>
      <TooltipContent className="px-2 py-1 text-xs">{label}</TooltipContent>
    </Tooltip>
  )
}

// ---------- SkillHeader ----------

export function SkillHeader({
  name,
  description,
  license,
  compatibility,
  allowedTools,
  composedSkillMd,
  decorators,
  actions,
  onBack,
  sticky = true
}: {
  name: string
  description: string
  license?: string
  compatibility?: string
  allowedTools?: string
  composedSkillMd?: string
  decorators?: React.ReactNode
  actions?: React.ReactNode
  onBack?: () => void
  sticky?: boolean
}): React.JSX.Element {
  const [showRawDialog, setShowRawDialog] = useState(false)
  const { copy: copyRawSkillMd, copied: copiedRawSkillMd } = useCopyToClipboard({
    successMessage: 'Copied raw SKILL.md',
    errorMessage: 'Failed to copy raw SKILL.md'
  })

  return (
    <>
      <div
        className={cn(
          'flex flex-col items-start gap-2 w-full',
          sticky && 'sticky top-0 z-30 py-4'
        )}
      >
        <div className="flex w-full flex-row items-center gap-2">
          <div className="flex flex-row items-center gap-2 align-middle">
            {onBack && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 shrink-0 p-0"
                onClick={onBack}
                aria-label="Go back"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight">{name}</h2>
            {composedSkillMd && (
              <Button
                variant="link"
                size="sm"
                className="h-auto shrink-0 px-1 py-0 text-xs"
                onClick={() => setShowRawDialog(true)}
              >
                View raw SKILL.md
              </Button>
            )}
          </div>
          <div className="ml-auto flex flex-row items-center align-middle">
            {decorators}
            {actions && (
              <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>
            )}
          </div>
        </div>
      </div>
      <div className="w-full">
        <p className="text-muted-foreground max-w-3xl text-xs">{description}</p>
        <TooltipProvider>
          <div className="mt-3 flex flex-wrap items-center gap-2 pb-2">
            <HeaderMetaItem label="License" value={license} missingText="No license defined" icon={Scale} />
            <HeaderMetaItem
              label="Compatibility"
              value={compatibility}
              missingText="No compatibility defined"
              icon={Bot}
            />
            <HeaderMetaItem
              label="Allowed tools"
              value={allowedTools}
              missingText="No allowed tools defined"
              icon={Hammer}
            />
          </div>
        </TooltipProvider>
      </div>
      {composedSkillMd && (
        <Dialog open={showRawDialog} onOpenChange={setShowRawDialog}>
          <DialogContent
            showCloseButton={false}
            className="w-full max-w-full border-0 p-0 sm:w-4/5 sm:max-w-4xl md:w-1/2 md:max-w-3xl"
          >
            <DialogHeader className="sr-only">
              <DialogTitle>Raw SKILL.md</DialogTitle>
            </DialogHeader>
            <div className="bg-muted relative overflow-hidden rounded-sm border shadow-lg">
              <div className="absolute top-3 right-3 z-10 flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="bg-background/70 text-muted-foreground hover:bg-background/90 hover:text-foreground h-8 w-8 rounded-sm"
                  onClick={() => void copyRawSkillMd(composedSkillMd)}
                  aria-label={copiedRawSkillMd ? 'Raw SKILL.md copied' : 'Copy raw SKILL.md'}
                >
                  {copiedRawSkillMd ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
                <DialogClose className="text-muted-foreground hover:bg-background/80 hover:text-foreground cursor-pointer rounded-sm p-1.5 transition-colors">
                  <X className="h-4 w-4" />
                  <span className="sr-only">Close</span>
                </DialogClose>
              </div>
              <ScrollArea className="h-screen">
                <pre className="bg-muted min-h-96 p-5 pr-24 font-mono text-xs leading-5 whitespace-pre-wrap">
                  {composedSkillMd}
                </pre>
              </ScrollArea>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

export function FormSection({
  title,
  children,
  className,
  optional,
  helperText
}: {
  title: string
  children: React.ReactNode
  className?: string
  optional?: boolean
  helperText?: React.ReactNode
}): React.JSX.Element {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <div className="flex items-baseline gap-2 pb-1">
        <h2 className="text-foreground text-base font-semibold tracking-tight">{title}</h2>
        {optional && <span className="text-muted-foreground text-xs">optional</span>}
        {helperText && <span className="text-muted-foreground text-xs">{helperText}</span>}
      </div>
      {children}
    </section>
  )
}

// ---------- ReadOnlyYamlBlock ----------
export function ReadOnlyYamlBlock({
  title,
  value,
  className
}: {
  title: string
  value: Record<string, unknown>
  className?: string
}): React.JSX.Element {
  const yaml = formatYamlRecord(value)

  return (
    <FormSection title={title} className={cn('flex flex-1 flex-col', className)}>
      <div className="bg-muted/10 flex-1 overflow-y-auto rounded-lg border hairline p-3">
        <Markdown content={`\`\`\`yaml\n${yaml}\n\`\`\``} />
      </div>
    </FormSection>
  )
}

// ---------- ReadOnlyMetadataTable ----------
export function ReadOnlyMetadataTable({
  value,
  className
}: {
  value: Record<string, unknown>
  className?: string
}): React.JSX.Element {
  const entries = Object.entries(value)

  return (
    <FormSection title="Metadata" className={cn('flex flex-1 flex-col', className)}>
      <div className="flex flex-1 flex-col rounded-lg border hairline">
        <div className="bg-muted/30 sticky top-0 z-10 grid grid-cols-2 border-b px-3 py-2 text-sm font-medium">
          <span>Key</span>
          <span>Value</span>
        </div>
        <div className="text-muted-foreground flex-1 divide-y overflow-y-auto">
          {entries.map(([key, item]) => (
            <div key={key} className="grid grid-cols-2 gap-3 px-3 py-2.5 text-sm">
              <p className="min-w-0 truncate font-mono text-xs">{key}</p>
              <p className="min-w-0 font-mono text-xs leading-5 break-words">{String(item)}</p>
            </div>
          ))}
        </div>
      </div>
    </FormSection>
  )
}

// ---------- ReadOnlySkillBody ----------

export function ReadOnlySkillBody({ body }: { body: string }): React.JSX.Element {
  const [externalLink, setExternalLink] = useState<{ href: string; label: string } | null>(null)

  const markdownComponents = {
    a: ({ href, children, ...props }: React.ComponentProps<'a'>) => {
      const isExternal = Boolean(href && /^https?:\/\//i.test(href))
      const label = typeof children === 'string' ? children : href || 'external link'

      if (!isExternal || !href) {
        return (
          <a href={href} {...props}>
            {children}
          </a>
        )
      }

      return (
        <a
          href={href}
          {...props}
          onClick={(event) => {
            props.onClick?.(event)
            if (event.defaultPrevented) return
            event.preventDefault()
            setExternalLink({ href, label })
          }}
        >
          {children}
        </a>
      )
    }
  }

  return (
    <FormSection title="SKILL.md Body" className="flex min-h-0 flex-1 flex-col">
      <Tabs defaultValue="rendered" className="flex min-h-0 w-full flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border hairline">
          <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5">
            <TabsList className="bg-muted h-8 shadow-sm backdrop-blur">
              <TabsTrigger value="rendered" className="h-6 px-2.5 text-xs">
                Rendered
              </TabsTrigger>
              <TabsTrigger value="raw" className="h-6 px-2.5 text-xs">
                Raw
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent value="rendered" className="m-0 flex-1 overflow-y-auto">
            <div className="min-w-0 p-4">
              <Markdown
                content={body || ''}
                className="max-w-full text-sm break-words"
                components={markdownComponents}
              />
            </div>
          </TabsContent>
          <TabsContent value="raw" className="m-0 flex-1 overflow-y-auto">
            <pre className="min-h-full p-4 font-mono text-xs leading-5 whitespace-pre-wrap">
              {body || '(empty)'}
            </pre>
          </TabsContent>
        </div>
      </Tabs>

      <Dialog open={externalLink != null} onOpenChange={(open) => !open && setExternalLink(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open external link?</DialogTitle>
            <DialogDescription>This link opens in a new browser tab.</DialogDescription>
          </DialogHeader>
          <div className="bg-muted/40 min-w-0 rounded-sm border px-3 py-2">
            <p className="truncate text-sm font-medium">{externalLink?.label}</p>
            <p className="text-muted-foreground truncate font-mono text-xs">{externalLink?.href}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExternalLink(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (!externalLink) return
                window.open(externalLink.href, '_blank', 'noopener,noreferrer')
                setExternalLink(null)
              }}
            >
              <ExternalLink className="h-4 w-4" />
              Open link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </FormSection>
  )
}

// ---------- ReadOnlyFileTree ----------

interface FileTreeNodeData extends BaseNodeData {
  type: 'root' | 'folder' | 'file' | 'skillmd'
  mimeType?: string
  sourceType?: string
  fileSizeBytes?: number
  path?: string
  childCount?: number
}

function downloadTextAsFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function fileNameFromPath(filePath: string): string {
  return filePath.split('/').filter(Boolean).pop() || filePath
}

function TreeRowChevron({
  hasChildren,
  isExpanded
}: {
  hasChildren: boolean
  isExpanded: boolean
}): React.JSX.Element {
  if (!hasChildren) return <span className="w-3.5 shrink-0" />
  if (isExpanded) return <ChevronDown className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
  return <ChevronRight className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
}

function TreeRowIcon({
  isSkillMd,
  isFile,
  isFolder,
  isExpanded
}: {
  isSkillMd: boolean
  isFile: boolean
  isFolder: boolean
  isExpanded: boolean
}): React.JSX.Element | null {
  if (isSkillMd) return <BookOpen className="text-muted-foreground h-4 w-4 shrink-0" />
  if (isFile) return <FileText className="text-muted-foreground h-4 w-4 shrink-0" />
  if (isFolder && isExpanded) return <FolderOpen className="text-muted-foreground h-4 w-4 shrink-0" />
  if (isFolder) return <Folder className="text-muted-foreground h-4 w-4 shrink-0" />
  return null
}

export function ReadOnlyFileTree({
  skillId,
  skillName,
  files,
  composedSkillMd,
  bare = false,
  selectedPath,
  onSelectPath
}: {
  skillId: string
  skillName: string
  files: SkillFileEntry[]
  composedSkillMd: string
  bare?: boolean
  selectedPath?: string
  onSelectPath?: (path: string) => void
}): React.JSX.Element {
  const treeData = useMemo((): TreeNode<FileTreeNodeData>[] => {
    interface FolderBucket {
      files: SkillFileEntry[]
      subfolders: Record<string, FolderBucket>
    }
    const rootBucket: FolderBucket = { files: [], subfolders: {} }

    for (const file of files) {
      const segments = file.path.split('/').filter(Boolean)
      if (segments.length === 0) continue
      segments.pop()
      let bucket = rootBucket
      for (const segment of segments) {
        if (!bucket.subfolders[segment]) bucket.subfolders[segment] = { files: [], subfolders: {} }
        bucket = bucket.subfolders[segment]
      }
      bucket.files.push(file)
    }

    const bucketToNodes = (
      bucket: FolderBucket,
      parentPath: string
    ): TreeNode<FileTreeNodeData>[] => {
      const nodes: TreeNode<FileTreeNodeData>[] = []
      for (const [folderName, sub] of Object.entries(bucket.subfolders).sort(([a], [b]) =>
        a.localeCompare(b)
      )) {
        const folderPath = parentPath ? `${parentPath}/${folderName}` : folderName
        const children = bucketToNodes(sub, folderPath)
        const immediateCount = Object.keys(sub.subfolders).length + sub.files.length
        nodes.push({
          data: {
            id: `folder-${folderPath}`,
            name: `${folderName}/`,
            type: 'folder',
            childCount: immediateCount,
            path: folderPath
          },
          children
        })
      }
      for (const file of bucket.files.sort((a, b) =>
        fileNameFromPath(a.path).localeCompare(fileNameFromPath(b.path))
      )) {
        nodes.push({
          data: {
            id: `file-${file.path}`,
            name: fileNameFromPath(file.path),
            type: 'file',
            mimeType: file.mimeType,
            sourceType: file.sourceType,
            fileSizeBytes: file.fileSizeBytes,
            path: file.path
          }
        })
      }
      return nodes
    }

    return [
      {
        data: {
          id: 'root',
          name: `${skillName || 'skill'}/`,
          type: 'root',
          childCount: Object.keys(rootBucket.subfolders).length + rootBucket.files.length
        },
        children: [
          { data: { id: 'skillmd', name: 'SKILL.md', type: 'skillmd' } },
          ...bucketToNodes(rootBucket, '')
        ]
      }
    ]
  }, [skillName, files])

  const downloadFileWithAuth = async (path: string, name: string): Promise<void> => {
    let url: string | undefined
    try {
      url = await fetchSkillFileObjectUrl(skillId, path)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch {
      /* ignore */
    } finally {
      if (url) URL.revokeObjectURL(url)
    }
  }

  const tree = (
    <TooltipProvider>
      <Tree<FileTreeNodeData>
        data={treeData}
        levelsToExpandByDefault={1}
        indentSize={28}
        renderItem={({
          item,
          isExpanded,
          hasChildren,
          onToggle,
          onExpandAll,
          onCollapseAll,
          isAllExpanded,
          isAllCollapsed
        }) => {
          const isFolder = item.type === 'root' || item.type === 'folder'
          const isSkillMd = item.type === 'skillmd'
          const isFile = item.type === 'file'
          const isDownloadable = isSkillMd || isFile

          const selectKey = isSkillMd ? SKILLMD_KEY : item.path
          const isSelected =
            !!onSelectPath &&
            isDownloadable &&
            selectedPath != null &&
            selectedPath === selectKey

          const downloadFile = (): void => {
            if (isSkillMd) {
              downloadTextAsFile(composedSkillMd, 'SKILL.md')
            } else if (isFile && item.path) {
              void downloadFileWithAuth(item.path, item.name)
            }
          }

          const handleClick = (): void => {
            if (hasChildren) {
              onToggle()
            } else if (isDownloadable) {
              if (onSelectPath && selectKey != null) onSelectPath(selectKey)
              else downloadFile()
            }
          }

          return (
            <div
              data-selected={isSelected || undefined}
              className={cn(
                'group flex h-7 min-w-0 items-center gap-1.5 rounded-sm px-1.5 text-sm transition-colors',
                (hasChildren || isDownloadable) && 'cursor-pointer hover:bg-muted',
                isSelected && 'bg-primary/10 text-primary hover:bg-primary/10'
              )}
              onClick={handleClick}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && (hasChildren || isDownloadable)) {
                  e.preventDefault()
                  handleClick()
                }
              }}
              role={hasChildren || isDownloadable ? 'button' : undefined}
              tabIndex={hasChildren || isDownloadable ? 0 : undefined}
              aria-label={isFolder ? `${isExpanded ? 'Collapse' : 'Expand'} ${item.name}` : item.name}
            >
              <TreeRowChevron hasChildren={hasChildren} isExpanded={isExpanded} />
              <TreeRowIcon
                isSkillMd={isSkillMd}
                isFile={isFile}
                isFolder={isFolder}
                isExpanded={isExpanded}
              />

              <span
                className={cn('min-w-0 flex-1 truncate font-mono text-xs', isFolder && 'font-medium')}
                title={item.name}
              >
                {item.name}
              </span>

              {isFolder && !isExpanded && item.childCount != null && item.childCount > 0 && (
                <span className="text-muted-foreground text-xs">
                  {item.childCount} item{item.childCount !== 1 ? 's' : ''}
                </span>
              )}

              {isDownloadable && (
                <div
                  className="sticky right-1 z-10 ml-auto shrink-0 rounded-sm bg-muted px-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          aria-label={`Actions for ${item.name}`}
                        />
                      }
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem className="cursor-pointer" onClick={() => downloadFile()}>
                        <Download className="h-3.5 w-3.5" />
                        Download
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}

              {item.type === 'root' && (
                <div
                  className="sticky right-1 z-10 ml-auto rounded-sm px-0.5"
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          aria-label="File actions"
                        />
                      }
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        className="cursor-pointer"
                        disabled={isAllExpanded}
                        onClick={() => onExpandAll()}
                      >
                        <ChevronsUpDown className="h-3.5 w-3.5" />
                        Expand all
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="cursor-pointer"
                        disabled={isAllCollapsed}
                        onClick={() => onCollapseAll()}
                      >
                        <ChevronsDownUp className="h-3.5 w-3.5" />
                        Collapse all
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )}
            </div>
          )
        }}
      />
    </TooltipProvider>
  )

  if (bare) return tree

  return <FormSection title="Files">{tree}</FormSection>
}

export function SkillReadOnlyContent({
  skillId,
  skillName,
  skillMdBody,
  files,
  extraFrontmatter,
  metadata,
  composedSkillMd,
  className
}: {
  skillId: string
  skillName: string
  skillMdBody: string
  files: SkillFileEntry[]
  extraFrontmatter: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
  composedSkillMd: string
  className?: string
}): React.JSX.Element {
  const METADATA_KEY = '__metadata__'
  const FRONTMATTER_KEY = '__extra_frontmatter__'

  const [selected, setSelected] = useState<string>(SKILLMD_KEY)
  const selectedFile =
    selected === SKILLMD_KEY || selected === METADATA_KEY || selected === FRONTMATTER_KEY
      ? null
      : (files.find((f) => f.path === selected) ?? null)

  const hasMetadata = metadata && Object.keys(metadata).length > 0
  const hasFrontmatter = extraFrontmatter && Object.keys(extraFrontmatter).length > 0

  const hasSkillGroup = hasMetadata || hasFrontmatter

  return (
    <div className={cn('flex min-h-0 w-full gap-3', className)}>
      {/* One unified navigator — frontmatter sections + files, matching the editor. */}
      <div className="bg-card flex min-h-0 w-64 shrink-0 flex-col overflow-hidden rounded-lg border hairline">
        {hasSkillGroup && (
          <div className="shrink-0 p-2">
            <div className="eyebrow px-2 pt-1 pb-1.5">Skill</div>
            <div className="flex flex-col gap-0.5">
              {hasMetadata && (
                <RailRow
                  icon={Table2}
                  label="Metadata"
                  active={selected === METADATA_KEY}
                  onClick={() => setSelected(METADATA_KEY)}
                />
              )}
              {hasFrontmatter && (
                <RailRow
                  icon={Braces}
                  label="Extra frontmatter"
                  active={selected === FRONTMATTER_KEY}
                  onClick={() => setSelected(FRONTMATTER_KEY)}
                />
              )}
            </div>
          </div>
        )}
        <div className={cn('flex min-h-0 flex-1 flex-col', hasSkillGroup && 'border-t')}>
          <div className="eyebrow shrink-0 px-4 pt-3 pb-1.5">Files</div>
          <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
            <ReadOnlyFileTree
              bare
              skillId={skillId}
              skillName={skillName}
              files={files}
              composedSkillMd={composedSkillMd}
              selectedPath={
                selected === METADATA_KEY || selected === FRONTMATTER_KEY ? undefined : selected
              }
              onSelectPath={setSelected}
            />
          </ScrollArea>
        </div>
      </div>

      <div className="flex grow flex-col overflow-auto">
        {selected === METADATA_KEY && metadata ? (
          <ReadOnlyMetadataTable value={metadata} />
        ) : selected === FRONTMATTER_KEY && extraFrontmatter ? (
          <ReadOnlyYamlBlock title="Extra Frontmatter" value={extraFrontmatter} />
        ) : selectedFile ? (
          <FilePreviewPane file={selectedFile} skillId={skillId} mode="view" />
        ) : (
          <ReadOnlySkillBody body={skillMdBody} />
        )}
      </div>
    </div>
  )
}
