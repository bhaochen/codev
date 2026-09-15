import React from 'react'
import { HighlightedCode } from '../../components/HighlightedCode.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import type { ProgressMessage } from '../../types/message.js'
import type { RlmProgress } from './engine.js'

// HighlightedCode is exported from a compiler-generated component whose public
// props are erased in the generated declaration; keep the shared Read renderer
// while restoring its small prop surface for this tool.
const SyntaxHighlightedCode = HighlightedCode as React.ComponentType<{
  code: string
  filePath: string
  dim?: boolean
}>

type State = 'done' | 'active' | 'pending' | 'error'

function marker(state: State): string {
  switch (state) {
    case 'done': return '✓'
    case 'active': return '◉'
    case 'error': return '✕'
    case 'pending': return '○'
  }
}

type RlmColor =
  | 'inactive'
  | 'warning'
  | 'success'
  | 'error'
  | 'professionalBlue'
  | 'cyan_FOR_SUBAGENTS_ONLY'
  | 'purple_FOR_SUBAGENTS_ONLY'

function color(state: State): RlmColor {
  switch (state) {
    case 'active': return 'warning'
    case 'done': return 'success'
    case 'error': return 'error'
    case 'pending': return 'inactive'
  }
}

function phaseColor(progress: RlmProgress): RlmColor {
  switch (progress.phase) {
    case 'start': return 'cyan_FOR_SUBAGENTS_ONLY'
    case 'turn': return 'professionalBlue'
    case 'model': return 'warning'
    case 'python': return 'success'
    case 'subcall': return 'purple_FOR_SUBAGENTS_ONLY'
    case 'answer': return 'cyan_FOR_SUBAGENTS_ONLY'
    case 'error': return 'error'
    case 'done': return 'success'
  }
}

function label(progress: RlmProgress): string {
  switch (progress.phase) {
    case 'start': return progress.detail ?? 'context'
    case 'turn': return `turn ${progress.turn ?? 0}/${progress.maxTurns ?? '?'}`
    case 'model': return progress.response
      ? `MODEL · turn ${progress.turn ?? '?'}${progress.usage ? ` · ${progress.usage.output} tokens` : ''}`
      : `MODEL · ${progress.detail ?? `turn ${progress.turn ?? '?'}`}`
    case 'python': return progress.detail ?? 'PYTHON SANDBOX'
    case 'subcall': return progress.detail ?? 'model request'
    case 'answer': return progress.detail ? `answer: ${progress.detail}` : 'answer ready'
    case 'error': return progress.detail ?? 'error'
    case 'done': return 'complete'
  }
}

function indentFor(progress: RlmProgress): number {
  const depth = progress.depth ?? 0
  // Model requests belong under the turn that caused them. Recursive turns keep
  // their own depth, so child runs naturally appear as nested branches.
  return depth + (progress.phase === 'subcall' ? 1 : 0)
}

function stateFor(progress: RlmProgress, isLast: boolean): State {
  if (progress.phase === 'error') return 'error'
  if (
    (progress.phase === 'model' && progress.response !== undefined) ||
    progress.phase === 'python' ||
    (progress.phase === 'subcall' && progress.response !== undefined)
  ) return 'done'
  if (isLast && progress.phase !== 'done' && progress.phase !== 'answer') return 'active'
  return 'done'
}

function traceCard(progress: RlmProgress): React.ReactNode {
  if (progress.phase === 'model') {
    return (
      <Box borderStyle="round" borderColor="warning" flexDirection="column" paddingX={1}>
        <Text color="warning">◆ MODEL {progress.turn ? `· turn ${progress.turn}` : ''}</Text>
        <Text>{progress.response ?? progress.detail ?? ''}</Text>
        {progress.usage && <Text dimColor>tokens · {progress.usage.input} in / {progress.usage.output} out</Text>}
      </Box>
    )
  }
  if (progress.phase === 'python') {
    return (
      <Box borderStyle="round" borderColor={progress.stderr ? 'error' : 'success'} flexDirection="column" paddingX={1}>
        <Text color="success">λ PYTHON SANDBOX · {progress.executionTimeMs ?? 0}ms</Text>
        {progress.code && (
          <Box flexDirection="column" marginTop={1}>
            <Text color="cyan_FOR_SUBAGENTS_ONLY">CODE · python</Text>
            <SyntaxHighlightedCode code={progress.code} filePath="rlm-sandbox.py" dim />
          </Box>
        )}
        {progress.stdout && <Text>{progress.stdout}</Text>}
        {progress.stderr && <Text color="error">stderr: {progress.stderr}</Text>}
        <Text dimColor>variables · {progress.varNames?.length ?? 0} · persistent</Text>
        {progress.varNames && progress.varNames.length > 0 && (
          <Text dimColor>
            {`state · ${progress.varNames.slice(0, 10).join(', ')}${progress.varNames.length > 10 ? ' …' : ''}`}
          </Text>
        )}
      </Box>
    )
  }
  if (progress.phase === 'subcall') {
    return (
      <Box borderStyle="round" borderColor="purple_FOR_SUBAGENTS_ONLY" flexDirection="column" paddingX={1}>
        <Text color="purple_FOR_SUBAGENTS_ONLY">◇ SUB-LLM · depth {progress.depth ?? 0}</Text>
        {progress.prompt && <Text dimColor>{`prompt: ${progress.prompt}`}</Text>}
        {progress.response && <Text>{`response: ${progress.response}`}</Text>}
        {progress.usage && <Text dimColor>tokens · {progress.usage.input} in / {progress.usage.output} out</Text>}
      </Box>
    )
  }
  return null
}

function progressEvents(progressMessages: ProgressMessage[]): RlmProgress[] {
  return progressMessages
    .map((message) => message.data as RlmProgress)
    .filter((event) => event?.type === 'rlm_progress')
}

function graphSymbol(progress: RlmProgress): string {
  switch (progress.phase) {
    case 'start': return '╭─'
    case 'model': return '▭'
    case 'python': return 'λ'
    case 'subcall': return '◇'
    case 'answer': return '╰─'
    case 'done': return '╰─'
    case 'error': return '✕'
    case 'turn': return '│'
  }
}

function graphRelation(progress: RlmProgress): string {
  if (progress.phase === 'start' && (progress.depth ?? 0) > 0) return '↳ child branch · '
  if (progress.phase === 'answer' && (progress.depth ?? 0) > 0) return '↩ return · '
  if (progress.phase === 'done' && (progress.depth ?? 0) > 0) return '↩ parent · '
  return ''
}

type GraphNode = {
  readonly kind: 'start' | 'turn' | 'subcall' | 'end' | 'error'
  readonly event: RlmProgress
  readonly status: RlmProgress
  readonly python: RlmProgress[]
}

function graphNodes(events: readonly RlmProgress[]): GraphNode[] {
  const nodes: GraphNode[] = []
  const turnNodes = new Map<string, GraphNode>()
  const pendingSubcalls: GraphNode[] = []

  for (const event of events) {
    if (event.phase === 'start') {
      // Packing is setup noise, not a graph node. Keep actual root/child run starts.
      if (event.depth !== undefined && !event.detail?.startsWith('packing ') && !event.detail?.startsWith('packed ')) {
        nodes.push({ kind: 'start', event, status: event, python: [] })
      }
      continue
    }
    if (event.phase === 'model') {
      const key = `${event.depth ?? 0}:${event.turn ?? 0}`
      const existing = turnNodes.get(key)
      if (existing) {
        const index = nodes.indexOf(existing)
        if (index >= 0) {
          const updated: GraphNode = {
            ...existing,
            event: event.response !== undefined ? event : existing.event,
            status: event,
          }
          nodes[index] = updated
          turnNodes.set(key, updated)
        }
      } else {
        const node: GraphNode = { kind: 'turn', event, status: event, python: [] }
        nodes.push(node)
        turnNodes.set(key, node)
      }
      continue
    }
    if (event.phase === 'python') {
      const key = `${event.depth ?? 0}:${event.turn ?? 0}`
      const turn = turnNodes.get(key)
      if (turn) {
        turn.python.push(event)
        const index = nodes.indexOf(turn)
        if (index >= 0) {
          const updated = { ...turn, status: event }
          nodes[index] = updated
          turnNodes.set(key, updated)
        }
      }
      continue
    }
    if (event.phase === 'subcall') {
      if (event.response !== undefined) {
        const pending = [...pendingSubcalls].reverse().find((node) => node.event.prompt === event.prompt)
        if (pending) {
          const index = nodes.indexOf(pending)
          if (index >= 0) nodes[index] = { ...pending, event, status: event }
          pendingSubcalls.splice(pendingSubcalls.indexOf(pending), 1)
        } else {
          nodes.push({ kind: 'subcall', event, status: event, python: [] })
        }
      } else {
        const node: GraphNode = { kind: 'subcall', event, status: event, python: [] }
        nodes.push(node)
        pendingSubcalls.push(node)
      }
      continue
    }
    if (event.phase === 'error') nodes.push({ kind: 'error', event, status: event, python: [] })
    if (event.phase === 'done') nodes.push({ kind: 'end', event, status: event, python: [] })
  }
  return nodes
}

function graphIndent(node: GraphNode): string {
  return `${'│  '.repeat(node.event.depth ?? 0)}${node.kind === 'subcall' ? '  ' : ''}`
}

function graphNodeLabel(node: GraphNode): string {
  const event = node.event
  if (node.kind === 'start') return `START · depth ${event.depth ?? 0}`
  if (node.kind === 'turn') return `TURN ${String(event.turn ?? 0).padStart(2, '0')} · ${event.usage?.output ?? 0} tokens`
  if (node.kind === 'subcall') return `SUB-LLM · depth ${event.depth ?? 0} · ${event.usage?.output ?? '…'} tokens`
  if (node.kind === 'error') return `ERROR · ${event.detail ?? 'run failed'}`
  return `END · ${event.detail ?? 'complete'}`
}

function graphNodeLine(node: GraphNode, isLast: boolean): React.ReactNode {
  const state = stateFor(node.status, isLast)
  const branch = isLast ? '└─ ' : '├─ '
  const symbol = node.kind === 'turn' ? '▭' : node.kind === 'subcall' ? '◇' : graphSymbol(node.event)
  return (
    <Text>
      <Text color="gray">{graphIndent(node)}{branch}</Text>
      <Text color={color(state)}>{marker(state)} </Text>
      <Text color={phaseColor(node.event)}>{symbol} {graphRelation(node.event)}{graphNodeLabel(node)}</Text>
      {node.kind === 'turn' && node.python.length > 0 && (
        <Text color="green">{` · λ python ${node.python.length} block${node.python.length === 1 ? '' : 's'}`}</Text>
      )}
    </Text>
  )
}

function graphNodeDetails(node: GraphNode): React.ReactNode {
  if (node.kind === 'turn') {
    return (
      <Box flexDirection="column" marginLeft={5}>
        {traceCard(node.event)}
        {node.python.map((python, index) => (
          <React.Fragment key={`python-${index}`}>{traceCard(python)}</React.Fragment>
        ))}
      </Box>
    )
  }
  if (node.kind === 'subcall') return <Box marginLeft={5}>{traceCard(node.event)}</Box>
  return null
}

type RlmResultLike = {
  readonly answer?: string
}

function RlmExecutionGraph({
  events,
  answer,
  live,
}: {
  events: RlmProgress[]
  answer?: string
  live: boolean
}): React.ReactNode {
  const [expandedNodes, setExpandedNodes] = React.useState<ReadonlySet<number>>(() => new Set())
  const latest = events.at(-1)
  const outerState = latest ? stateFor(latest, true) : 'pending'
  const nodes = graphNodes(events)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={color(outerState)} paddingX={1}>
      <Text color={outerState === 'active' ? 'warning' : outerState === 'error' ? 'error' : 'success'} bold>
        RLM EXECUTION GRAPH · {live ? 'LIVE' : 'COMPLETE'}
      </Text>
      {latest && (latest.totalInputTokens !== undefined || latest.totalOutputTokens !== undefined) && (
        <Text color="cyan_FOR_SUBAGENTS_ONLY">
          {`TOKENS · ${(latest.totalInputTokens ?? 0).toLocaleString()} in / ${(latest.totalOutputTokens ?? 0).toLocaleString()} out / ${((latest.totalInputTokens ?? 0) + (latest.totalOutputTokens ?? 0)).toLocaleString()} total`}
        </Text>
      )}
      <Text dimColor>click a node to expand · click again to collapse</Text>
      <Box flexDirection="column" marginTop={1}>
        {nodes.map((node, index) => {
          const open = expandedNodes.has(index)
          return (
            <Box key={`node-${index}-${node.kind}-${node.event.turn ?? ''}`} flexDirection="column" onClick={() => {
              setExpandedNodes((previous) => {
                const next = new Set(previous)
                if (next.has(index)) next.delete(index)
                else next.add(index)
                return next
              })
            }}>
              {graphNodeLine(node, index === nodes.length - 1)}
              {open && graphNodeDetails(node)}
            </Box>
          )
        })}
      </Box>
      {!live && answer && (
        <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1} marginTop={1}>
          <Text color="cyan_FOR_SUBAGENTS_ONLY">╰─ ANSWER</Text>
          <Text>{answer}</Text>
        </Box>
      )}
    </Box>
  )
}

export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage[],
): React.ReactNode {
  const events = progressEvents(progressMessages)
  if (events.length === 0) {
    return <MessageResponse height={1}><Text dimColor>RLM: starting…</Text></MessageResponse>
  }
  return (
    <MessageResponse>
      <RlmExecutionGraph events={events} live />
    </MessageResponse>
  )
}

export function renderRlmResultMessage(
  content: RlmResultLike,
  progressMessages: ProgressMessage[],
): React.ReactNode {
  const events = progressEvents(progressMessages)
  return (
    <MessageResponse>
      <RlmExecutionGraph events={events} answer={content.answer} live={false} />
    </MessageResponse>
  )
}
