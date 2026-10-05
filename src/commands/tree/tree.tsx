import { c as _c } from 'react/compiler-runtime'
import type { UUID } from 'crypto'
import React from 'react'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text, useInput } from '../../ink.js'
import { Spinner } from '../../components/Spinner.js'
import { TreeSelect, type TreeNode } from '../../components/ui/TreeSelect.js'
import TextInput from '../../components/TextInput.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { LogOption } from '../../types/logs.js'
import { formatLogMetadata } from '../../utils/format.js'
import { getWorktreePaths } from '../../utils/getWorktreePaths.js'
import { getLogDisplayTitle, logError } from '../../utils/log.js'
import { getSessionIdFromLog, isLiteLog, loadFullLog, loadSameRepoMessageLogs, saveCustomTitle } from '../../utils/sessionStorage.js'
import {
  buildForkForest,
  type ForkNode,
  updateForkForestTitle,
} from '../../utils/forkGraph.js'

function toTreeNodes(nodes: ForkNode[]): TreeNode<{ log: LogOption }>[] {
  return nodes.map(node => ({
    id: node.sessionId,
    label: getLogDisplayTitle(node.log),
    description: formatLogMetadata(node.log),
    value: { log: node.log },
    children: node.children.length ? toTreeNodes(node.children) : undefined,
  }))
}

function TreeCommand({
  onDone,
  onResume,
}: {
  onDone: (result?: string, options?: { display?: 'skip' | 'system' | 'user' }) => void
  onResume: (sessionId: UUID, log: LogOption, entrypoint: 'tree') => Promise<void>
}): React.ReactNode {
  const [loading, setLoading] = React.useState(true)
  const [forest, setForest] = React.useState<ForkNode[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [focusedLog, setFocusedLog] = React.useState<LogOption | null>(null)
  const [renameTarget, setRenameTarget] = React.useState<LogOption | null>(null)
  const [renameValue, setRenameValue] = React.useState('')
  const [renameCursorOffset, setRenameCursorOffset] = React.useState(0)
  const [renameError, setRenameError] = React.useState<string | null>(null)
  const [renaming, setRenaming] = React.useState(false)
  const { columns, rows } = useTerminalSize()
  const nodes = React.useMemo(() => toTreeNodes(forest), [forest])

  useInput(
    (input, key) => {
      if (
        key.ctrl &&
        input.toLowerCase() === 'r' &&
        focusedLog &&
        !renaming
      ) {
        setRenameTarget(focusedLog)
        setRenameValue(getLogDisplayTitle(focusedLog))
        setRenameCursorOffset(getLogDisplayTitle(focusedLog).length)
        setRenameError(null)
      }
    },
    { isActive: !loading && !error && !renameTarget },
  )

  React.useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const paths = await getWorktreePaths(getOriginalCwd())
        const logs = await loadSameRepoMessageLogs(paths)
        const forest = await buildForkForest(logs)
        if (cancelled) return
        if (forest.length === 0) {
          onDone('No sessions found to navigate')
          return
        }
        setForest(forest)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [onDone])

  if (loading) {
    return (
      <Box>
        <Spinner />
        <Text> Loading session tree…</Text>
      </Box>
    )
  }

  if (error) {
    return <Text color="red">{error}</Text>
  }

  async function handleRenameSubmit(value: string): Promise<void> {
    if (renaming) return
    const title = value.trim()
    const sessionId = renameTarget && getSessionIdFromLog(renameTarget)
    if (!renameTarget || !sessionId || !title) {
      setRenameError('Enter a non-empty session name.')
      return
    }

    setRenaming(true)
    setRenameError(null)
    try {
      await saveCustomTitle(sessionId, title, renameTarget.fullPath)
      setForest(current => updateForkForestTitle(current, sessionId, title))
      setFocusedLog({ ...renameTarget, customTitle: title })
      setRenameTarget(null)
      setRenameValue('')
    } catch (renameFailure) {
      setRenameError(
        renameFailure instanceof Error
          ? renameFailure.message
          : 'Failed to rename session.',
      )
    } finally {
      setRenaming(false)
    }
  }

  return (
    <Box flexDirection="column">
      {renameTarget ? (
        <Box flexDirection="column" paddingLeft={2}>
          <Text bold>Rename session: {getLogDisplayTitle(renameTarget)}</Text>
          <TextInput
            value={renameValue}
            onChange={setRenameValue}
            onSubmit={value => void handleRenameSubmit(value)}
            onExit={() => {
              if (!renaming) {
                setRenameTarget(null)
                setRenameError(null)
              }
            }}
            placeholder="Enter new session name"
            columns={columns}
            cursorOffset={renameCursorOffset}
            onChangeCursorOffset={setRenameCursorOffset}
            showCursor
            focus
          />
          {renameError && <Text color="error">{renameError}</Text>}
          <Text dimColor>Enter to save · Esc to cancel</Text>
        </Box>
      ) : (
        <>
          <TreeSelect
            nodes={nodes}
            focusNodeId={
              focusedLog ? getSessionIdFromLog(focusedLog) : undefined
            }
            layout="expanded"
            isNodeExpanded={() => true}
            visibleOptionCount={Math.max(3, rows - 3)}
            onCancel={() => onDone('Tree navigation cancelled', { display: 'system' })}
            onFocus={node => setFocusedLog(node.value.log)}
            onSelect={async node => {
              const log = node.value.log
              const sessionId = getSessionIdFromLog(log)
              if (!sessionId) {
                onDone('Failed to resolve session')
                return
              }
              const fullLog = isLiteLog(log) ? await loadFullLog(log) : log
              await onResume(sessionId, fullLog, 'tree')
            }}
          />
          <Box paddingLeft={2}>
            <Text dimColor>Ctrl+R to rename selected session</Text>
          </Box>
        </>
      )}
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context) => {
  const onResume = async (sessionId: UUID, log: LogOption, entrypoint: 'tree') => {
    try {
      await context.resume?.(sessionId, log, entrypoint)
      onDone(undefined, { display: 'skip' })
    } catch (error) {
      logError(error as Error)
      onDone('Failed to resume: ' + (error as Error).message)
    }
  }
  return <TreeCommand onDone={onDone} onResume={onResume} />
}
