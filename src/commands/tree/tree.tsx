import { c as _c } from 'react/compiler-runtime'
import type { UUID } from 'crypto'
import React from 'react'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { Spinner } from '../../components/Spinner.js'
import { TreeSelect, type TreeNode } from '../../components/ui/TreeSelect.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import type { LogOption } from '../../types/logs.js'
import { formatLogMetadata } from '../../utils/format.js'
import { getWorktreePaths } from '../../utils/getWorktreePaths.js'
import { getLogDisplayTitle, logError } from '../../utils/log.js'
import { getSessionIdFromLog, isLiteLog, loadFullLog, loadSameRepoMessageLogs } from '../../utils/sessionStorage.js'
import { buildForkForest, type ForkNode } from '../../utils/forkGraph.js'

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
  const [nodes, setNodes] = React.useState<TreeNode<{ log: LogOption }>[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const { rows } = useTerminalSize()

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
        setNodes(toTreeNodes(forest))
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

  return (
    <TreeSelect
      nodes={nodes}
      layout="expanded"
      isNodeExpanded={() => true}
      visibleOptionCount={Math.max(3, rows - 2)}
      onCancel={() => onDone('Tree navigation cancelled', { display: 'system' })}
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
