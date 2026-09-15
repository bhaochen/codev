import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import type { ProgressMessage } from '../../types/message.js'
import type { RlmProgress } from './engine.js'

type State = 'done' | 'active' | 'pending' | 'error'

function marker(state: State): string {
  switch (state) {
    case 'done': return '✓'
    case 'active': return '◉'
    case 'error': return '✕'
    case 'pending': return '○'
  }
}

function color(state: State): 'gray' | 'yellow' | 'green' | 'red' {
  switch (state) {
    case 'active': return 'yellow'
    case 'done': return 'green'
    case 'error': return 'red'
    case 'pending': return 'gray'
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
      <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1}>
        <Text color="yellow">◆ MODEL {progress.turn ? `· turn ${progress.turn}` : ''}</Text>
        <Text>{progress.response ?? progress.detail ?? ''}</Text>
        {progress.usage && <Text dimColor>tokens · {progress.usage.input} in / {progress.usage.output} out</Text>}
      </Box>
    )
  }
  if (progress.phase === 'python') {
    return (
      <Box borderStyle="round" borderColor="green" flexDirection="column" paddingX={1}>
        <Text color="green">λ PYTHON SANDBOX · {progress.executionTimeMs ?? 0}ms</Text>
        {progress.code && <Text dimColor>{`>>> ${progress.code}`}</Text>}
        {progress.stdout && <Text>{progress.stdout}</Text>}
        {progress.stderr && <Text color="red">stderr: {progress.stderr}</Text>}
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
      <Box borderStyle="round" borderColor="magenta" flexDirection="column" paddingX={1}>
        <Text color="magenta">◇ SUB-LLM · depth {progress.depth ?? 0}</Text>
        {progress.prompt && <Text dimColor>{`prompt: ${progress.prompt}`}</Text>}
        {progress.response && <Text>{`response: ${progress.response}`}</Text>}
        {progress.usage && <Text dimColor>tokens · {progress.usage.input} in / {progress.usage.output} out</Text>}
      </Box>
    )
  }
  return null
}

export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage[],
): React.ReactNode {
  const events = progressMessages
    .map((message) => message.data as RlmProgress)
    .filter((event) => event?.type === 'rlm_progress')
  if (events.length === 0) {
    return <MessageResponse height={1}><Text dimColor>RLM: starting…</Text></MessageResponse>
  }

  const maxVisible = 12
  const hidden = Math.max(0, events.length - maxVisible)
  const visible = events.slice(-maxVisible)
  const lastIndex = visible.length - 1
  const latest = visible[lastIndex]!
  const showPendingAnswer = latest.phase !== 'answer' && latest.phase !== 'done' && latest.phase !== 'error'
  const cards = visible
    .filter((event) => event.phase === 'model' || event.phase === 'python' || event.phase === 'subcall')
    .slice(-3)

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text dimColor>RLM FLOW · live</Text>
        {hidden > 0 && <Text dimColor>{`  ┊ ${hidden} earlier events`}</Text>}
        {visible.map((event, index) => {
          const state = stateFor(event, index === lastIndex)
          const prefix = `${'  '.repeat(indentFor(event))}├─ `
          return (
            <Text key={`${index}-${event.phase}-${event.detail ?? ''}`} color={color(state)}>
              {prefix}{marker(state)} {label(event)}
            </Text>
          )
        })}
        {showPendingAnswer && (
          <Text color="gray">{'  '.repeat((latest.depth ?? 0) + 1)}└─ {marker('pending')} answer</Text>
        )}
        {cards.map((event, index) => (
          <React.Fragment key={`card-${index}-${event.phase}-${event.turn ?? ''}`}>
            {traceCard(event)}
          </React.Fragment>
        ))}
      </Box>
    </MessageResponse>
  )
}
