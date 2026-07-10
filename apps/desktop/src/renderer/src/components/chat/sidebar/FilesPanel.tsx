import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { FileTree, useFileTree } from '@pierre/trees/react'
import { themeToTreeStyles } from '@pierre/trees'
import { DEFAULT_THEMES, resolveTheme } from '@pierre/diffs'
import { File as FilePreview } from '@pierre/diffs/react'
import { useChat } from '@/store/chat-store'
import { useRootDark } from '@/hooks/use-root-dark'
import { cn } from '@/lib/utils'

/**
 * The Files tab: a workspace file tree that hands the whole panel over to a
 * text-file preview when a file is clicked (back button returns to the tree).
 * The tree is @pierre/trees — a virtualized shadow-DOM component fed the flat
 * list of file paths from main (fd-based, gitignore-aware). There is no file
 * watcher; the tree refreshes event-driven — on mount (= tab opened, panels
 * unmount when inactive) and when an agent turn ends.
 */

type Preview =
  | { state: 'idle' }
  | { state: 'loading'; path: string }
  | { state: 'text'; path: string; content: string; size: number }
  | { state: 'binary'; path: string; size: number }
  | { state: 'tooLarge'; path: string; size: number }
  | { state: 'error'; path: string }

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/** Every ancestor directory implied by a set of file paths. */
function directoriesOf(paths: readonly string[]): string[] {
  const dirs = new Set<string>()
  for (const p of paths) {
    let idx = p.indexOf('/')
    while (idx !== -1) {
      dirs.add(p.slice(0, idx))
      idx = p.indexOf('/', idx + 1)
    }
  }
  return [...dirs]
}

export function FilesPanel({ workspacePath }: { workspacePath: string }): React.JSX.Element {
  const { t } = useTranslation()
  const dark = useRootDark()
  const running = useChat((s) => s.running)

  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [empty, setEmpty] = useState(false)
  const [truncated, setTruncated] = useState(false)
  const [preview, setPreview] = useState<Preview>({ state: 'idle' })
  // Transparent from the first paint so the frosted rail shows through even
  // before the async theme resolves (the tree's own default is opaque #f8f8f8).
  const [treeStyles, setTreeStyles] = useState<Record<string, string>>({
    backgroundColor: 'transparent'
  })

  // The tree model is constructed once with these options; all later behavior
  // goes through model.* methods, and the selection callback through a ref
  // (the options object is captured at construction and never re-read).
  const onSelectRef = useRef<(paths: readonly string[]) => void>(() => {})
  const { model } = useFileTree({
    paths: [],
    initialExpansion: 'closed',
    icons: { set: 'standard', colored: true },
    flattenEmptyDirectories: true,
    search: true,
    onSelectionChange: (paths) => onSelectRef.current(paths)
  })

  // Theme the shadow-DOM tree from the same resolved Shiki theme family the
  // diff/preview rendering uses, keeping all code surfaces in one palette.
  useEffect(() => {
    let live = true
    void resolveTheme(dark ? DEFAULT_THEMES.dark : DEFAULT_THEMES.light).then((theme) => {
      if (!live) return
      setTreeStyles({
        ...themeToTreeStyles(theme),
        // Let the frosted sidebar rail show through instead of the theme's
        // opaque editor background. themeToTreeStyles emits BOTH a direct
        // backgroundColor style and the --trees-theme-sidebar-bg var (the
        // sticky-folder/selection fallback chain reads the var) — override both.
        backgroundColor: 'transparent',
        '--trees-theme-sidebar-bg': 'transparent'
      })
    })
    return () => {
      live = false
    }
  }, [dark])

  const prevPathsRef = useRef<readonly string[]>([])
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const res = await window.api.listWorkspaceFiles({ root: workspacePath })
      // Preserve which directories are open across the reset: derive the old
      // directory set from the previous path list and keep the expanded ones.
      const expanded = directoriesOf(prevPathsRef.current).filter((dir) => {
        const item = model.getItem(dir)
        return item !== null && 'isExpanded' in item && item.isExpanded()
      })
      model.resetPaths(res.paths, { initialExpandedPaths: expanded })
      if (res.gitStatus) model.setGitStatus(res.gitStatus)
      prevPathsRef.current = res.paths
      setEmpty(res.paths.length === 0)
      setTruncated(res.truncated)
      setListState('ready')
    } catch {
      setListState('error')
    }
  }, [model, workspacePath])

  // Refresh on mount (inactive tabs unmount, so mounting IS "tab opened")…
  useEffect(() => {
    void refresh()
  }, [refresh])

  // …and when the foreground session's agent turn ends (running: true → false),
  // since that's when the agent has finished creating/editing files.
  const prevRunning = useRef(running)
  useEffect(() => {
    if (prevRunning.current && !running) void refresh()
    prevRunning.current = running
  }, [running, refresh])

  const latestPathRef = useRef<string | null>(null)
  onSelectRef.current = (paths) => {
    const path = paths[0]
    if (!path || model.getItem(path)?.isDirectory() !== false) return
    latestPathRef.current = path
    setPreview({ state: 'loading', path })
    void window.api.readWorkspaceFile({ root: workspacePath, relPath: path }).then((res) => {
      if (latestPathRef.current !== path) return // a newer selection superseded this read
      if (res.kind === 'text') setPreview({ state: 'text', path, content: res.content, size: res.size })
      else if (res.kind === 'binary') setPreview({ state: 'binary', path, size: res.size })
      else if (res.kind === 'tooLarge') setPreview({ state: 'tooLarge', path, size: res.size })
      else setPreview({ state: 'error', path })
    })
  }

  // Leaving the preview clears the tree selection so clicking the same file
  // again re-fires onSelectionChange (an identical re-select emits nothing).
  const backToTree = (): void => {
    latestPathRef.current = null
    for (const p of model.getSelectedPaths()) model.getItem(p)?.deselect()
    setPreview({ state: 'idle' })
  }

  // Takeover layout: the tree owns the whole panel until a file is clicked,
  // then the preview replaces it with a back button in its header. The tree
  // (and its expansion) stays mounted underneath — back is instant.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn('min-h-0 flex-1 flex-col', preview.state === 'idle' ? 'flex' : 'hidden')}>
        <div className="min-h-0 flex-1 mt-2">
          {listState === 'error' || (listState === 'ready' && empty) ? (
            <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted-foreground">
              {t(listState === 'error' ? 'panel.filesError' : 'panel.filesEmpty')}
            </div>
          ) : (
            <FileTree
              model={model}
              style={{ height: '100%', ...treeStyles } as React.CSSProperties}
            />
          )}
        </div>
        {truncated && (
          <div className="shrink-0 border-t border-border/70 px-3 py-1.5 text-[0.65rem] text-muted-foreground">
            {t('panel.filesTruncated', { count: prevPathsRef.current.length })}
          </div>
        )}
      </div>
      {preview.state !== 'idle' && (
        <>
          <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border/70 pr-3 pl-1">
            <button
              type="button"
              onClick={backToTree}
              title={t('panel.filesBack')}
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
            </button>
            <span className="min-w-0 truncate text-[0.75rem] text-foreground" title={preview.path}>
              {preview.path}
            </span>
            {preview.state !== 'loading' && preview.state !== 'error' && (
              <span className="ml-auto shrink-0 text-[0.65rem] text-muted-foreground tabular-nums">
                {formatBytes(preview.size)}
              </span>
            )}
          </div>
          {preview.state === 'text' ? (
            <div className="min-h-0 flex-1 overflow-auto">
              <FilePreview
                file={{ name: preview.path, contents: preview.content }}
                disableWorkerPool
                options={{
                  themeType: dark ? 'dark' : 'light',
                  overflow: 'wrap',
                  disableFileHeader: true
                }}
              />
            </div>
          ) : (
            <div
              className={cn(
                'flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-muted-foreground',
                preview.state === 'loading' && 'animate-pulse'
              )}
            >
              {preview.state === 'loading' && t('panel.filesLoading')}
              {preview.state === 'binary' && t('panel.fileBinary')}
              {preview.state === 'tooLarge' && t('panel.fileTooLarge', { size: formatBytes(preview.size) })}
              {preview.state === 'error' && t('panel.fileError')}
            </div>
          )}
        </>
      )}
    </div>
  )
}
