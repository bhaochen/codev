import { parsePatch, type StructuredPatchHunk } from 'diff'
import * as React from 'react'
import { StructuredDiff } from '../../components/StructuredDiff.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import type { FileDiff } from '../../services/snapshot/snapshot.js'
import type { Output } from './SnapshotTool.js'

const MAX_VISUAL_FILES = 6

export function renderToolUseMessage(input: {
  action?: string
  hash?: string
  label?: string
}): React.ReactNode {
  return [input.action, input.hash?.slice(0, 8), input.label && `"${input.label}"`]
    .filter(Boolean)
    .join(' ')
}

function statusGlyph(status: FileDiff['status']): string {
  return status === 'added' ? '+' : status === 'deleted' ? '-' : 'M'
}

function statusColor(
  status: FileDiff['status'],
): 'success' | 'error' | 'warning' {
  return status === 'added'
    ? 'success'
    : status === 'deleted'
      ? 'error'
      : 'warning'
}

function SnapshotDiffView({
  files,
}: {
  files: NonNullable<Output['files']>
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const shown = files.slice(0, MAX_VISUAL_FILES)
  const hidden = files.length - shown.length
  return (
    <Box flexDirection="column">
      <Text>
        {files.length} file{files.length === 1 ? '' : 's'} changed
      </Text>
      {shown.map(file => {
        let hunks: StructuredPatchHunk[] = []
        if (!file.binary && !file.truncated && file.patch.trim()) {
          try {
            hunks = (parsePatch(file.patch)[0]?.hunks ??
              []) as StructuredPatchHunk[]
          } catch {
            hunks = []
          }
        }
        return (
          <Box key={file.file} flexDirection="column" marginTop={1}>
            <Text color={statusColor(file.status)}>
              {statusGlyph(file.status)} {file.file}{' '}
              {file.binary
                ? '(binary)'
                : `+${file.additions} -${file.deletions}`}
              {file.truncated ? ' [diff elided]' : ''}
            </Text>
            {hunks.map((hunk, index) => (
              <StructuredDiff
                key={index}
                patch={hunk}
                filePath={file.file}
                firstLine={null}
                dim={false}
                width={Math.max(1, columns - 4)}
              />
            ))}
          </Box>
        )
      })}
      {hidden > 0 && (
        <Text color="inactive">
          … {hidden} more file{hidden === 1 ? '' : 's'} not shown (full patches
          sent to the model).
        </Text>
      )}
    </Box>
  )
}

export function renderToolResultMessage(output: Output): React.ReactNode {
  if (output.action === 'list') {
    if (!output.entries?.length) {
      return <Text color="inactive">No snapshots</Text>
    }
    return (
      <Box flexDirection="column">
        {output.entries.map(entry => (
          <Text key={entry.hash}>
            {entry.hash.slice(0, 8)} {entry.date} {entry.message}
          </Text>
        ))}
      </Box>
    )
  }
  if (output.action === 'diff') {
    const files = output.files ?? []
    return files.length ? (
      <SnapshotDiffView files={files} />
    ) : (
      <Text color="inactive">No differences</Text>
    )
  }
  return (
    <Text color={output.ok ? 'success' : 'error'}>{output.summary}</Text>
  )
}
