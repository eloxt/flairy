import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Textarea } from '@/components/ui/textarea'
import type { SkillFileEntry } from '@/lib/types/skills'
import { fetchSkillFileObjectUrl, fetchSkillFileText, skillFileServeUrl } from '@/api/client'
import { Download, File as FileIcon, Info, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatFileSize } from './helpers'

// ---------- helpers ----------

/**
 * The authenticated file-serve URL for a stored file. Unlike Bifrost (which
 * served files publicly by skill name), Flairy serves by skill id behind the
 * bearer token — so direct `<img src>`/`<a href>` to this URL won't work for
 * media; the preview fetches bytes with the token into an object URL instead.
 */
export function getFileServeUrl(skillId: string, path: string): string {
  return skillFileServeUrl(skillId, path)
}

const TEXT_MIME_HINTS = [
  'json',
  'xml',
  'yaml',
  'yml',
  'javascript',
  'typescript',
  'x-sh',
  'x-shellscript',
  'x-python',
  'csv',
  'markdown',
  'toml'
]

function isTextLikeMime(mime: string, sourceType: SkillFileEntry['sourceType']): boolean {
  if (sourceType === 'text') return true
  if (!mime) return false
  if (mime.startsWith('text/')) return true
  return TEXT_MIME_HINTS.some((hint) => mime.includes(hint))
}

type FileKind = 'text' | 'image' | 'audio' | 'video' | 'binary'

function detectKind(file: SkillFileEntry): FileKind {
  const mime = file.mimeType || ''
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  if (isTextLikeMime(mime, file.sourceType)) return 'text'
  return 'binary'
}

interface ResolvedSource {
  /** For saved files: needs an authed fetch into an object URL (media). */
  servePath?: string
  /** For text sources stored inline locally. */
  inlineText?: string
  /** For dataurl / url sources usable directly in src. */
  directUrl?: string
  unavailable?: boolean
}

/**
 * Resolves what the preview needs. Saved text/dataurl/upload files are fetched
 * from the authed serve endpoint; local/unsaved files use in-memory content;
 * url sources use their external href directly.
 */
function resolveSource(file: SkillFileEntry, skillId: string): ResolvedSource {
  switch (file.sourceType) {
    case 'text':
    case 'dataurl':
      if (!file.__local && skillId && file.path) {
        return { servePath: file.path }
      }
      if (file.sourceType === 'text') {
        return { inlineText: file.content ?? '' }
      }
      return file.dataurl ? { directUrl: file.dataurl } : { unavailable: true }
    case 'url':
      return file.sourceUrl ? { directUrl: file.sourceUrl } : { unavailable: true }
    case 'upload':
      if (!file.__local && skillId && file.path) {
        return { servePath: file.path }
      }
      // A locally-added upload carries its bytes as a data URL.
      return file.dataurl ? { directUrl: file.dataurl } : { unavailable: true }
    default:
      return { unavailable: true }
  }
}

// ---------- FilePreview ----------

export function FilePreview({
  file,
  skillId,
  mode,
  onFileUpdate
}: {
  file: SkillFileEntry
  skillId: string
  mode: 'view' | 'edit'
  onFileUpdate?: (updates: Partial<SkillFileEntry>) => void
}): React.JSX.Element {
  const kind = detectKind(file)
  const source = resolveSource(file, skillId)
  const fileName = file.path.split('/').filter(Boolean).pop() || file.path

  // Media object URL fetched with auth for saved files.
  const [mediaUrl, setMediaUrl] = useState<string | null>(null)
  // Text content fetched from the serve endpoint.
  const [fetchedText, setFetchedText] = useState<string | null>(null)
  const [fetchState, setFetchState] = useState<'idle' | 'loading' | 'error'>('idle')

  useEffect(() => {
    // Saved text files fetch their content with auth.
    if (kind !== 'text' || source.inlineText != null || !source.servePath) {
      setFetchedText(null)
      setFetchState('idle')
      return
    }
    let cancelled = false
    setFetchState('loading')
    fetchSkillFileText(skillId, source.servePath)
      .then((text) => {
        if (cancelled) return
        setFetchedText(text)
        setFetchState('idle')
      })
      .catch(() => {
        if (cancelled) return
        setFetchState('error')
      })
    return () => {
      cancelled = true
    }
  }, [kind, skillId, source.inlineText, source.servePath])

  useEffect(() => {
    // Saved media fetches an object URL with auth.
    const isMedia = kind === 'image' || kind === 'audio' || kind === 'video'
    if (!isMedia || !source.servePath) {
      setMediaUrl(null)
      return
    }
    let cancelled = false
    let url: string | null = null
    fetchSkillFileObjectUrl(skillId, source.servePath)
      .then((objectUrl) => {
        if (cancelled) {
          URL.revokeObjectURL(objectUrl)
          return
        }
        url = objectUrl
        setMediaUrl(objectUrl)
      })
      .catch(() => {
        if (!cancelled) setMediaUrl(null)
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [kind, skillId, source.servePath])

  if (mode === 'edit') {
    return <FileSourceEditor file={file} skillId={skillId} onFileUpdate={onFileUpdate} />
  }

  const directOrMedia = source.directUrl ?? mediaUrl ?? undefined

  // ---- Unavailable (e.g. unsaved upload) ----
  if (source.unavailable && kind !== 'text') {
    return (
      <FallbackBlock fileName={fileName} file={file} downloadUrl={directOrMedia}>
        Preview available after saving.
      </FallbackBlock>
    )
  }

  // ---- Image ----
  if (kind === 'image' && directOrMedia) {
    return (
      <div className="bg-muted/20 flex items-center justify-center p-4">
        <img src={directOrMedia} alt={fileName} className="max-h-full max-w-full object-contain" />
      </div>
    )
  }

  // ---- Audio ----
  if (kind === 'audio' && directOrMedia) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
        <FileIcon className="text-muted-foreground h-10 w-10" />
        <span className="text-muted-foreground max-w-full truncate font-mono text-xs">
          {fileName}
        </span>
        <audio controls src={directOrMedia} className="w-full max-w-md" />
      </div>
    )
  }

  // ---- Video ----
  if (kind === 'video' && directOrMedia) {
    return (
      <div className="bg-muted/20 flex h-full items-center justify-center p-4">
        <video controls src={directOrMedia} className="max-h-full max-w-full" />
      </div>
    )
  }

  // ---- Text ----
  if (kind === 'text') {
    if (fetchState === 'loading') {
      return (
        <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-xs">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading…
        </div>
      )
    }
    if (fetchState === 'error') {
      return (
        <FallbackBlock fileName={fileName} file={file} downloadUrl={directOrMedia}>
          Could not load file contents.
        </FallbackBlock>
      )
    }

    const textContent = source.inlineText ?? fetchedText ?? ''

    return (
      <ScrollArea className="h-full">
        <pre className="p-4 font-mono text-xs leading-5 whitespace-pre-wrap">
          {textContent || '(empty)'}
        </pre>
      </ScrollArea>
    )
  }

  // ---- Fallback (binary / unknown) ----
  return <FallbackBlock fileName={fileName} file={file} downloadUrl={directOrMedia} />
}

// ---------- FilePreviewPane ----------
// Full-height bordered box: a header (file path) over the preview.

export function FilePreviewPane({
  file,
  skillId,
  mode,
  onFileUpdate
}: {
  file: SkillFileEntry
  skillId: string
  mode: 'view' | 'edit'
  onFileUpdate?: (updates: Partial<SkillFileEntry>) => void
}): React.JSX.Element {
  const fileName = file.path.split('/').filter(Boolean).pop() || file.path

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-sm border">
      <div className="bg-muted/30 flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3">
        <span
          className="flex min-w-0 items-center gap-1.5 truncate font-mono text-xs"
          title={file.path}
        >
          {file.path}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <DownloadButton file={file} skillId={skillId} fileName={fileName} />
        </div>
      </div>
      <div className="min-h-0 grow overflow-y-auto">
        <FilePreview file={file} skillId={skillId} mode={mode} onFileUpdate={onFileUpdate} />
      </div>
    </div>
  )
}

/** Download control: fetches saved bytes with auth, or links a local data URL. */
function DownloadButton({
  file,
  skillId,
  fileName
}: {
  file: SkillFileEntry
  skillId: string
  fileName: string
}): React.JSX.Element | null {
  const source = resolveSource(file, skillId)
  const [downloading, setDownloading] = useState(false)

  if (source.directUrl) {
    return (
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground hover:text-foreground h-7 px-2"
        render={<a href={source.directUrl} download={fileName} aria-label={`Download ${fileName}`} />}
      >
        <Download className="h-3.5 w-3.5" />
      </Button>
    )
  }

  if (!source.servePath) return null

  const handleDownload = async (): Promise<void> => {
    setDownloading(true)
    let url: string | undefined
    try {
      url = await fetchSkillFileObjectUrl(skillId, source.servePath as string)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } catch {
      /* ignore */
    } finally {
      if (url) URL.revokeObjectURL(url)
      setDownloading(false)
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      className="text-muted-foreground hover:text-foreground h-7 px-2"
      onClick={() => void handleDownload()}
      disabled={downloading}
      aria-label={`Download ${fileName}`}
    >
      {downloading ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
    </Button>
  )
}

function FileSourceEditor({
  file,
  skillId,
  onFileUpdate
}: {
  file: SkillFileEntry
  skillId: string
  onFileUpdate?: (updates: Partial<SkillFileEntry>) => void
}): React.JSX.Element {
  const fileName = file.path.split('/').filter(Boolean).pop() || file.path
  const source = resolveSource(file, skillId)
  const kind = detectKind(file)

  // For saved text/dataurl files, content lives on the serve endpoint.
  const [fetchedContent, setFetchedContent] = useState<string | null>(null)
  const [fetchState, setFetchState] = useState<'idle' | 'loading' | 'error'>('idle')
  const needsFetch =
    (file.sourceType === 'text' || (file.sourceType === 'dataurl' && kind === 'text')) &&
    !file.__local &&
    source.servePath != null &&
    source.inlineText == null

  useEffect(() => {
    if (!needsFetch || !source.servePath) return
    let cancelled = false
    setFetchState('loading')
    fetchSkillFileText(skillId, source.servePath)
      .then((text) => {
        if (cancelled) return
        setFetchedContent(text)
        setFetchState('idle')
      })
      .catch(() => {
        if (cancelled) return
        setFetchState('error')
      })
    return () => {
      cancelled = true
    }
  }, [needsFetch, skillId, source.servePath])

  if (file.sourceType === 'upload') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
        <FileIcon className="text-muted-foreground h-12 w-12" />
        <div className="flex flex-col gap-0.5">
          <p className="max-w-full truncate font-mono text-sm">{fileName}</p>
          <p className="text-muted-foreground text-xs">
            {file.mimeType || 'uploaded file'}
            {file.fileSizeBytes ? ` · ${formatFileSize(file.fileSizeBytes)}` : ''}
          </p>
        </div>
        <p className="text-muted-foreground max-w-md text-xs">
          Uploaded files cannot be edited here. The preview is available on the view page; to change
          this file, delete it and upload a replacement.
        </p>
      </div>
    )
  }

  if (file.sourceType === 'url') {
    return (
      <div className="flex h-full flex-col gap-4 p-4">
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-xs">Source URL</Label>
          <Input
            value={file.sourceUrl ?? ''}
            onChange={(e) => onFileUpdate?.({ sourceUrl: e.target.value })}
            placeholder="https://example.com/file.py"
            className="font-mono text-xs"
          />
        </div>
        <div className="flex items-start gap-2 rounded-sm border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            This source is saved as a live reference. The file is read from this URL when the skill
            is retrieved.
          </span>
        </div>
      </div>
    )
  }

  if (needsFetch && fetchState === 'loading') {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-xs">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    )
  }
  if (needsFetch && fetchState === 'error') {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-xs">
        Could not load file contents.
      </div>
    )
  }

  if (file.sourceType === 'dataurl') {
    if (!file.dataurl && kind !== 'text') {
      return (
        <FallbackBlock fileName={fileName} file={file}>
          Binary data URLs can&apos;t be edited as text. Download to inspect, or delete and re-upload
          to replace this file.
        </FallbackBlock>
      )
    }
    const currentValue =
      file.dataurl ??
      (fetchedContent != null
        ? `data:${file.mimeType || 'text/plain'};base64,${btoa(
            unescape(encodeURIComponent(fetchedContent))
          )}`
        : '')
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-4">
        <Label className="text-muted-foreground text-xs">Data URL</Label>
        <Textarea
          value={currentValue}
          onChange={(e) => onFileUpdate?.({ dataurl: e.target.value })}
          placeholder="data:text/plain;base64,..."
          className="min-h-0 flex-1 resize-none font-mono text-xs"
        />
      </div>
    )
  }

  // text source
  const currentContent = file.content ?? source.inlineText ?? fetchedContent ?? ''
  return (
    <Textarea
      value={currentContent}
      onChange={(e) => onFileUpdate?.({ content: e.target.value })}
      placeholder="File content..."
      className="h-full w-full resize-none rounded-none border-0 font-mono text-xs focus-visible:ring-0"
    />
  )
}

function FallbackBlock({
  fileName,
  file,
  downloadUrl,
  children
}: {
  fileName: string
  file: SkillFileEntry
  downloadUrl?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <FileIcon className="text-muted-foreground h-12 w-12" />
      <div className="flex flex-col gap-0.5">
        <p className="max-w-full truncate font-mono text-sm">{fileName}</p>
        <p className="text-muted-foreground text-xs">
          {file.mimeType || 'unknown type'}
          {file.fileSizeBytes ? ` · ${formatFileSize(file.fileSizeBytes)}` : ''}
        </p>
      </div>
      {children && <p className="text-muted-foreground text-xs">{children}</p>}
      {downloadUrl && (
        <Button variant="outline" size="sm" render={<a href={downloadUrl} download={fileName} />}>
          <Download className="h-3.5 w-3.5" />
          Download
        </Button>
      )}
    </div>
  )
}
