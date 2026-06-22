import * as React from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { cn } from '@/lib/utils'

interface MarkdownProps {
  content: string
  className?: string
  /** Custom component overrides (e.g. external-link interception). */
  components?: Components
}

/**
 * Markdown renderer for the skills repo. Uses react-markdown + remark-gfm
 * (Bifrost ships streamdown; the admin keeps deps minimal). Prose styling is
 * applied via Tailwind utility selectors so it works without a typography plugin.
 */
function Markdown({ content, className, components }: MarkdownProps): React.JSX.Element {
  return (
    <div
      className={cn(
        'text-sm text-foreground',
        '[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold',
        '[&_h2]:mt-4 [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold',
        '[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-base [&_h3]:font-semibold',
        '[&_p]:my-2 [&_p]:leading-6',
        '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
        '[&_li]:my-0.5',
        '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground',
        '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-xs',
        '[&_pre]:my-3 [&_pre]:overflow-x-auto [&_pre]:rounded-sm [&_pre]:border [&_pre]:bg-muted [&_pre]:p-3',
        '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
        '[&_table]:my-3 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs',
        '[&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-medium',
        '[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
}

export { Markdown, type MarkdownProps }
