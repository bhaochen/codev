import * as React from 'react'
import { randomUUID } from 'crypto'
import { getTotalCost as getTotalCostUSD } from '../../cost-tracker.js'
import { getSessionId, getTotalTokensUsed } from '../../bootstrap/state.js'
import { Box, Text, useInput } from '../../ink.js'
import type { AppState } from '../../state/AppState.js'
import type { Goal, GoalStatus } from '../../state/AppStateStore.js'
import type { LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import {
  buildGoalStateEntry,
  buildObjectiveUpdatedPrompt,
  formatElapsed,
  formatGoalStatus,
  getFocusedGoal,
  isGoalContinuationPrompt,
  isGoalInactive,
} from '../../utils/goal.js'
import { clearGoal, saveGoal } from '../../utils/sessionStorage.js'
import { enqueue, removeByFilter } from '../../utils/messageQueueManager.js'
import { renderToString } from '../../utils/staticRender.js'

function statusColor(status: GoalStatus): string {
  switch (status) {
    case 'pursuing':
      return 'green'
    case 'paused':
      return 'yellow'
    case 'achieved':
      return 'cyan'
    case 'blocked':
      return 'red'
    case 'usage-limited':
      return 'gray'
    case 'budget-limited':
      return 'magenta'
  }
}

function GoalDisplay({
  goal,
  now,
}: {
  goal: Goal
  now: number
}): React.ReactNode {
  const elapsed = formatElapsed(now - goal.startedAt)

  return (
    <Box flexDirection="column">
      <Text bold>Goal</Text>
      <Text>{goal.objective}</Text>
      <Box marginTop={1}>
        <Text>Status: </Text>
        <Text color={statusColor(goal.status)}>
          {formatGoalStatus(goal.status)}
        </Text>
      </Box>
      <Text dimColor>
        Elapsed: {elapsed} · Continuations:{' '}
        {goal.continuationCount}
      </Text>
      {goal.lastReason ? (
        <Text dimColor>Last update: {goal.lastReason}</Text>
      ) : null}
    </Box>
  )
}

function GoalOverwriteConfirm({
  existing,
  objective,
  context,
  onDone,
  inPlanMode,
}: {
  existing: Goal
  objective: string
  context: LocalJSXCommandContext
  onDone: LocalJSXCommandOnDone
  inPlanMode: boolean
}): React.ReactNode {
  const [choice, setChoice] = React.useState<'replace' | 'cancel' | null>(null)

  useInput((input, key) => {
    if (choice !== null) return
    if (input === 'y' || input === 'Y' || key.return) {
      setChoice('replace')
    } else if (input === 'n' || input === 'N' || key.escape) {
      setChoice('cancel')
    }
  })

  React.useEffect(() => {
    if (choice === null) return
    const { setAppState } = context

    if (choice === 'cancel') {
      onDone('Goal not changed.')
      return
    }

    const now = Date.now()
    const newGoal: Goal = {
      id: randomUUID(),
      objective,
      status: 'pursuing',
      startedAt: now,
      startCostUSD: getTotalCostUSD(),
      startTokensUsed: getTotalTokensUsed(),
      continuationCount: 0,
      lastUpdatedAt: now,
    }
    // Replace only the focused goal; other open goals in the pool are kept.
    setGoal(setAppState, prev => {
      const goals = { ...(prev.goals ?? {}) }
      if (prev.focusedGoalId) delete goals[prev.focusedGoalId]
      goals[newGoal.id] = newGoal
      return { goals, focusedGoalId: newGoal.id }
    })
    clearQueuedGoalContinuations()

    const message = inPlanMode
      ? `Goal set: ${objective}\nAuto-continuation is disabled while in Plan mode. Exit plan mode (Shift+Tab) to begin pursuit.`
      : `Goal set: ${objective}\nThe agent will auto-continue toward this objective until it is achieved, blocked, or paused. Use /goal pause, /goal resume, /goal edit, or /goal clear to manage it.`
    onDone(message, {
      metaMessages: [
        `[goal] Active goal id: ${newGoal.id}. If calling update_goal for this goal, include goal_id='${newGoal.id}'.`,
      ],
    })
  }, [choice, objective, context, onDone, inPlanMode])

  return (
    <Box flexDirection="column">
      <Text bold>Replace existing goal?</Text>
      <Box marginTop={1}>
        <Text dimColor>
          Current focused goal ({formatGoalStatus(existing.status)}):
        </Text>
      </Box>
      <Text>{existing.objective}</Text>
      <Box marginTop={1}>
        <Text dimColor>New objective:</Text>
      </Box>
      <Text>{objective}</Text>
      <Box marginTop={1}>
        <Text dimColor>
          Press <Text bold>Enter</Text> to replace, <Text bold>Esc</Text> to
          cancel.
        </Text>
      </Box>
    </Box>
  )
}

type GoalPatch = {
  goals?: Record<string, Goal>
  focusedGoalId?: string | undefined
}

function setGoal(
  setAppState: LocalJSXCommandContext['setAppState'],
  updater: (prev: { goals?: Record<string, Goal>; focusedGoalId?: string }) => GoalPatch,
): void {
  setAppState((prev: AppState) => {
    const next = updater({
      goals: prev.goals,
      focusedGoalId: prev.focusedGoalId,
    })
    if (next.goals) {
      saveGoal(buildGoalStateEntry(next.goals, next.focusedGoalId, getSessionId()))
    } else {
      clearGoal()
    }
    return {
      ...prev,
      goals: next.goals,
      focusedGoalId: next.focusedGoalId,
    } satisfies AppState
  })
}

function clearQueuedGoalContinuations(): void {
  removeByFilter(cmd => isGoalContinuationPrompt(cmd.value))
}

function createGoal(objective: string): Goal {
  const now = Date.now()
  return {
    id: randomUUID(),
    objective: objective.trim(),
    status: 'pursuing' as const,
    startedAt: now,
    startCostUSD: getTotalCostUSD(),
    startTokensUsed: getTotalTokensUsed(),
    continuationCount: 0,
    lastUpdatedAt: now,
  }
}

function createAndFocus(
  setAppState: LocalJSXCommandContext['setAppState'],
  objective: string,
  inPlanMode: boolean,
  onDone: LocalJSXCommandOnDone,
): void {
  const newGoal = createGoal(objective)
  setGoal(setAppState, prev => ({
    goals: { ...(prev.goals ?? {}), [newGoal.id]: newGoal },
    focusedGoalId: newGoal.id,
  }))
  clearQueuedGoalContinuations()

  const message = inPlanMode
    ? `Goal set: ${objective}\nAuto-continuation is disabled while in Plan mode. Exit plan mode (Shift+Tab) to begin pursuit.`
    : `Goal set: ${objective}\nThe agent will auto-continue toward this objective until it is achieved, blocked, or paused. Use /goal pause, /goal resume, /goal edit, /goal clear, or /goal list to manage it.`
  onDone(message, {
    metaMessages: [
      `[goal] Active goal id: ${newGoal.id}. If calling update_goal for this goal, include goal_id='${newGoal.id}'.`,
    ],
  })
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const { getAppState, setAppState } = context
  const trimmed = args.trim()
  const firstTokenMatch = trimmed.match(/^\S+/)
  const firstToken = firstTokenMatch?.[0] ?? ''
  const sub = firstToken.toLowerCase()
  const rest = firstTokenMatch
    ? trimmed.slice(firstTokenMatch[0].length).trimStart()
    : ''

  const appState = getAppState()
  const goals = appState.goals
  const focusedGoalId = appState.focusedGoalId
  const focused = getFocusedGoal(appState)
  const inPlanMode = appState.toolPermissionContext.mode === 'plan'

  // /goal list — show every open goal and which is focused.
  if (sub === 'list') {
    if (!goals || Object.keys(goals).length === 0) {
      onDone('No goals. Set one with: /goal <objective>')
      return null
    }
    const lines = Object.values(goals).map(g => {
      const marker = g.id === focusedGoalId ? '*' : ' '
      return `${marker} ${g.id.slice(0, 8)}  [${formatGoalStatus(g.status)}]  ${g.objective}`
    })
    onDone(`Goals (\* = focused):\n${lines.join('\n')}`)
    return null
  }

  // /goal focus <id> — switch the focused goal (drives auto-continue + footer).
  if (sub === 'focus') {
    if (!goals || Object.keys(goals).length === 0) {
      onDone('No goals to focus. Set one with: /goal <objective>')
      return null
    }
    const q = rest.trim().toLowerCase()
    if (!q) {
      onDone('Usage: /goal focus <goal-id-prefix>')
      return null
    }
    const match = Object.values(goals).find(
      g => g.id.toLowerCase() === q || g.id.toLowerCase().startsWith(q),
    )
    if (!match) {
      onDone(`No goal matching "${rest}". Use /goal list to see ids.`)
      return null
    }
    setGoal(setAppState, prev => ({ goals: prev.goals, focusedGoalId: match.id }))
    clearQueuedGoalContinuations()
    onDone(`Focused goal ${match.id.slice(0, 8)}: ${match.objective}`)
    return null
  }

  if (sub === 'pause') {
    if (!focused) {
      onDone('No active goal.')
      return null
    }
    if (focused.status !== 'pursuing') {
      onDone(`Goal is already ${formatGoalStatus(focused.status)}.`)
      return null
    }
    setGoal(setAppState, prev => ({
      goals: prev.goals
        ? { ...prev.goals, [prev.focusedGoalId!]: { ...focused, status: 'paused', lastUpdatedAt: Date.now() } }
        : prev.goals,
      focusedGoalId: prev.focusedGoalId,
    }))
    clearQueuedGoalContinuations()
    onDone('Goal paused. Auto-continuation suspended.')
    return null
  }

  if (sub === 'resume') {
    if (!focused) {
      onDone('No active goal.')
      return null
    }
    if (focused.status === 'pursuing') {
      onDone('Goal already pursuing.')
      return null
    }
    if (focused.status === 'achieved') {
      onDone(
        `Goal already ${formatGoalStatus(focused.status)}. Use /goal <objective> to start a new one.`,
      )
      return null
    }
    setGoal(setAppState, prev => ({
      goals: prev.goals
        ? {
            ...prev.goals,
            [prev.focusedGoalId!]: {
              ...focused,
              status: 'pursuing',
              continuationCount: 0,
              startedAt: Date.now(),
              startCostUSD: getTotalCostUSD(),
              startTokensUsed: getTotalTokensUsed(),
              lastUpdatedAt: Date.now(),
              lastReason: undefined,
            },
          }
        : prev.goals,
      focusedGoalId: prev.focusedGoalId,
    }))
    clearQueuedGoalContinuations()
    onDone(
      'Goal resumed. Continuation count and budget window reset; auto-continuation will start on the next idle tick.',
    )
    return null
  }

  if (sub === 'clear') {
    if (!focused) {
      onDone('No active goal.')
      return null
    }
    const clearedId = focusedGoalId
    setGoal(setAppState, prev => {
      const nextGoals = { ...(prev.goals ?? {}) }
      if (clearedId) delete nextGoals[clearedId]
      const remaining = Object.keys(nextGoals)
      return {
        goals: remaining.length > 0 ? nextGoals : undefined,
        focusedGoalId:
          remaining.length > 0
            ? remaining[0]
            : undefined,
      }
    })
    clearQueuedGoalContinuations()
    onDone('Goal cleared.')
    return null
  }

  if (sub === 'edit') {
    if (!focused) {
      onDone('No active goal. Set one with: /goal <objective>')
      return null
    }
    if (!rest) {
      onDone('Usage: /goal edit <new objective>')
      return null
    }
    setGoal(setAppState, prev => ({
      goals: prev.goals
        ? { ...prev.goals, [prev.focusedGoalId!]: { ...focused, objective: rest, lastUpdatedAt: Date.now() } }
        : prev.goals,
      focusedGoalId: prev.focusedGoalId,
    }))
    clearQueuedGoalContinuations()
    onDone(`Goal objective updated to: ${rest}`, {
      metaMessages: [
        buildObjectiveUpdatedPrompt({ ...focused, objective: rest }),
      ],
    })
    return null
  }

  if (trimmed === '') {
    if (!focused) {
      onDone(
        'No active goal. Set one with: /goal <objective>\nThen the agent will auto-continue toward it across turns.',
      )
      return null
    }
    const display = (
      <GoalDisplay
        goal={focused as Goal}
        now={Date.now()}
      />
    )
    const output = await renderToString(display)
    onDone(output)
    return null
  }

  const objective = (sub === 'set' || sub === 'add') ? rest : trimmed
  if (!objective) {
    onDone('Missing objective.\nUsage: /goal <objective>')
    return null
  }

  // /goal add <objective> — always create a new goal without replacing.
  if (sub === 'add' || !focused || isGoalInactive(focused.status)) {
    createAndFocus(setAppState, objective, inPlanMode, onDone)
    return null
  }

  // An active goal is focused — confirm before replacing it.
  return (
    <GoalOverwriteConfirm
      existing={focused}
      objective={objective}
      context={context}
      onDone={onDone}
      inPlanMode={inPlanMode}
    />
  )
}
