import { z } from 'zod/v4'
import {
  type FileDiff,
  listSnapshots,
  revertSnapshot,
  snapshotDiff,
  snapshotDiffBetween,
  type SnapshotEntry,
  trackSnapshot,
} from '../../services/snapshot/snapshot.js'
import { buildTool, type Tool, type ToolDef } from '../../Tool.js'
import { getCwd } from '../../utils/cwd.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  DESCRIPTION,
  SNAPSHOT_TOOL_NAME,
  SNAPSHOT_TOOL_PROMPT,
} from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['save', 'list', 'diff', 'restore'])
      .describe('Save, list, diff, or restore snapshots.'),
    hash: z
      .string()
      .optional()
      .describe('Required for diff and restore; full snapshot hash or prefix.'),
    compareHash: z
      .string()
      .optional()
      .describe('Optional target hash for diff; hash is the base snapshot.'),
    label: z.string().max(120).optional().describe('Short save label.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Maximum snapshots to list (default 20).'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const fileDiffSchema = lazySchema(() =>
  z.object({
    file: z.string(),
    status: z.enum(['added', 'deleted', 'modified']),
    binary: z.boolean(),
    additions: z.number(),
    deletions: z.number(),
    patch: z.string(),
    truncated: z.boolean().optional(),
  }),
)

const outputSchema = lazySchema(() =>
  z.object({
    action: z.enum(['save', 'list', 'diff', 'restore']),
    ok: z.boolean(),
    summary: z.string(),
    hash: z.string().optional(),
    entries: z
      .array(
        z.object({
          hash: z.string(),
          date: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
    files: z.array(fileDiffSchema()).optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function entriesToText(entries: SnapshotEntry[]): string {
  return entries.length
    ? entries
        .map(entry => `${entry.hash.slice(0, 12)}  ${entry.date}  ${entry.message}`)
        .join('\n')
    : 'No snapshots.'
}

function filesToText(files: FileDiff[]): string {
  if (!files.length) return 'No differences.'
  const lines = [
    `${files.length} file${files.length === 1 ? '' : 's'} changed:`,
  ]
  for (const file of files) {
    const stats = file.binary
      ? '(binary)'
      : `+${file.additions} -${file.deletions}`
    lines.push(`  ${file.status}  ${file.file}  ${stats}`)
  }
  lines.push('')
  for (const file of files) {
    lines.push(`--- ${file.file} (${file.status})`)
    lines.push(
      file.binary ? '(binary file — no patch)' : file.patch || '(empty diff)',
      '',
    )
  }
  return lines.join('\n').trimEnd()
}

export const SnapshotTool: Tool<InputSchema, Output> = buildTool({
  name: SNAPSHOT_TOOL_NAME,
  searchHint: 'save, list, diff, compare, and restore snapshots',
  maxResultSizeChars: 500_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return SNAPSHOT_TOOL_PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName(input) {
    switch (input?.action) {
      case 'save':
        return 'Saving snapshot'
      case 'list':
        return 'Listing snapshots'
      case 'diff':
        return 'Showing snapshot diff'
      case 'restore':
        return 'Restoring snapshot'
      default:
        return 'Snapshot'
    }
  },
  isReadOnly(input) {
    return input?.action === 'list' || input?.action === 'diff'
  },
  isConcurrencySafe(input) {
    return input?.action === 'list' || input?.action === 'diff'
  },
  isDestructive(input) {
    return input?.action === 'restore'
  },
  toAutoClassifierInput(input) {
    return [input.action, input.hash, input.compareHash].filter(Boolean).join(' ')
  },
  async validateInput(input) {
    if (
      (input.action === 'diff' || input.action === 'restore') &&
      !input.hash?.trim()
    ) {
      return {
        result: false,
        message: `${input.action} requires a snapshot hash.`,
        errorCode: 1,
      }
    }
    if (input.compareHash && input.action !== 'diff') {
      return {
        result: false,
        message: 'compareHash is only valid for diff.',
        errorCode: 1,
      }
    }
    if (input.label && input.action !== 'save') {
      return {
        result: false,
        message: 'label is only valid for save.',
        errorCode: 1,
      }
    }
    if (input.limit !== undefined && input.action !== 'list') {
      return {
        result: false,
        message: 'limit is only valid for list.',
        errorCode: 1,
      }
    }
    return { result: true }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(input) {
    const projectCwd = getCwd()
    switch (input.action) {
      case 'save': {
        const snapshot = await trackSnapshot(projectCwd, input.label)
        return {
          data: {
            action: 'save',
            ok: true,
            summary: `Snapshot ${snapshot.hash.slice(0, 8)} saved.`,
            hash: snapshot.hash,
          },
        }
      }
      case 'list': {
        const entries = await listSnapshots(projectCwd, input.limit)
        return {
          data: {
            action: 'list',
            ok: true,
            summary: `${entries.length} snapshot${entries.length === 1 ? '' : 's'}.`,
            entries,
          },
        }
      }
      case 'diff': {
        const hash = input.hash!
        const files = input.compareHash
          ? await snapshotDiffBetween(projectCwd, hash, input.compareHash)
          : await snapshotDiff(projectCwd, hash)
        const pair = input.compareHash
          ? `${hash.slice(0, 8)} → ${input.compareHash.slice(0, 8)}`
          : hash.slice(0, 8)
        return {
          data: {
            action: 'diff',
            ok: true,
            summary: files.length
              ? `${files.length} file${files.length === 1 ? '' : 's'} differ (${pair}).`
              : `No changes (${pair}).`,
            files,
          },
        }
      }
      case 'restore': {
        const snapshot = await revertSnapshot(projectCwd, input.hash!)
        return {
          data: {
            action: 'restore',
            ok: true,
            summary: `Working tree restored from ${snapshot.hash.slice(0, 8)}.`,
            hash: snapshot.hash,
          },
        }
      }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const content =
      output.action === 'list'
        ? entriesToText(output.entries ?? [])
        : output.action === 'diff'
          ? filesToText(output.files ?? [])
          : `${output.summary}${output.hash ? `\nhash: ${output.hash}` : ''}`
    return {
      type: 'tool_result',
      content,
      tool_use_id: toolUseID,
      is_error: output.ok ? undefined : true,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
