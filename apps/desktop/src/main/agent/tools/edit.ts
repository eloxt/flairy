import { constants } from 'node:fs'
import { access, readFile, writeFile } from 'node:fs/promises'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { resolveToCwd } from './paths'
import { withFileMutationQueue } from './file-mutation-queue'
import {
  applyEditsToNormalizedContent,
  detectLineEnding,
  type Edit,
  generateDiffString,
  generateUnifiedPatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom
} from './edit-diff'

/**
 * edit — ported from pi-coding-agent (tools/edit.ts). Exact (with fuzzy
 * fallback) multi-replacement editing in a single file, returning a
 * line-numbered diff. Paths are confined to cwd. Requires user approval.
 */

interface EditInput {
  path: string
  edits: Edit[]
}
type LegacyEditInput = EditInput & { oldText?: unknown; newText?: unknown }

/**
 * Normalize the model's arguments. Some models send `edits` as a JSON string,
 * or use the legacy single-edit `{ oldText, newText }` shape; coerce both into
 * the canonical `{ path, edits: [...] }` form.
 */
function prepareEditArguments(input: unknown): EditInput {
  if (!input || typeof input !== 'object') {
    return input as EditInput
  }
  const args = input as Record<string, unknown>

  if (typeof args.edits === 'string') {
    try {
      const parsed = JSON.parse(args.edits)
      if (Array.isArray(parsed)) args.edits = parsed
    } catch {
      /* leave as-is; validation will report it */
    }
  }

  const legacy = args as unknown as LegacyEditInput
  if (typeof legacy.oldText !== 'string' || typeof legacy.newText !== 'string') {
    return args as unknown as EditInput
  }
  const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : []
  edits.push({ oldText: legacy.oldText, newText: legacy.newText })
  const { oldText: _o, newText: _n, ...rest } = legacy
  return { ...rest, edits } as EditInput
}

function validateEditInput(input: EditInput): { path: string; edits: Edit[] } {
  if (!Array.isArray(input.edits) || input.edits.length === 0) {
    throw new Error('Edit tool input is invalid. edits must contain at least one replacement.')
  }
  return { path: input.path, edits: input.edits }
}

export function createEditTool(cwd: string): AgentTool<any> {
  const replaceEditSchema = Type.Object(
    {
      oldText: Type.String({
        description:
          'Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.'
      }),
      newText: Type.String({ description: 'Replacement text for this targeted edit.' })
    },
    { additionalProperties: false }
  )

  return {
    name: 'edit',
    label: 'edit',
    description:
      'Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.',
    parameters: Type.Object(
      {
        path: Type.String({ description: 'Path to the file to edit (relative to the working directory)' }),
        edits: Type.Array(replaceEditSchema, {
          description:
            'One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits.'
        })
      },
      { additionalProperties: false }
    ),
    executionMode: 'sequential',
    prepareArguments: prepareEditArguments,
    execute: async (_id, input: any, signal) => {
      const { path, edits } = validateEditInput(input as EditInput)
      const absolutePath = resolveToCwd(path, cwd)

      return withFileMutationQueue(absolutePath, async () => {
        const throwIfAborted = (): void => {
          if (signal?.aborted) throw new Error('Operation aborted')
        }
        throwIfAborted()

        try {
          await access(absolutePath, constants.R_OK | constants.W_OK)
        } catch (error: unknown) {
          throwIfAborted()
          const errorMessage = error instanceof Error && 'code' in error ? `Error code: ${(error as { code: string }).code}` : String(error)
          throw new Error(`Could not edit file: ${path}. ${errorMessage}.`)
        }
        throwIfAborted()

        const buffer = await readFile(absolutePath)
        const rawContent = buffer.toString('utf-8')
        throwIfAborted()

        // Strip BOM before matching; the model will not include an invisible BOM in oldText.
        const { bom, text: content } = stripBom(rawContent)
        const originalEnding = detectLineEnding(content)
        const normalizedContent = normalizeToLF(content)
        const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path)
        throwIfAborted()

        const finalContent = bom + restoreLineEndings(newContent, originalEnding)
        await writeFile(absolutePath, finalContent, 'utf-8')
        throwIfAborted()

        const diffResult = generateDiffString(baseContent, newContent)
        const patch = generateUnifiedPatch(path, baseContent, newContent)
        return {
          content: [{ type: 'text', text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
          details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine }
        }
      })
    }
  }
}
