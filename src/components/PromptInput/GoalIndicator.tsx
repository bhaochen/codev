import * as React from 'react'
import { Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import type { GoalStatus } from '../../state/AppStateStore.js'
import { getFocusedGoal, isGoalInactive } from '../../utils/goal.js'

const MAX_OBJECTIVE_CHARS = 40

export function goalStatusColor(status: GoalStatus): string {
  switch (status) {
    case 'pursuing':
      return 'ansi:yellow'
    case 'paused':
      return 'ansi:gray'
    case 'achieved':
      return 'ansi:green'
    case 'blocked':
      return 'ansi:red'
    case 'usage-limited':
      return 'ansi:gray'
    case 'budget-limited':
      return 'ansi:magenta'
  }
}

export function GoalIndicator(): React.ReactNode {
  const goals = useAppState(s => s.goals)
  const focusedGoalId = useAppState(s => s.focusedGoalId)
  const goal = useAppState(getFocusedGoal)
  const mode = useAppState(s => s.toolPermissionContext.mode)
  if (!goal) return null

  const truncated =
    goal.objective.length > MAX_OBJECTIVE_CHARS
      ? goal.objective.slice(0, MAX_OBJECTIVE_CHARS - 1) + '…'
      : goal.objective

  const planSuppressed = goal.status === 'pursuing' && mode === 'plan'
  const label = planSuppressed ? 'paused: plan mode' : goal.status
  const dotColor = planSuppressed ? 'yellow' : goalStatusColor(goal.status)

  const otherOpen =
    goals && focusedGoalId
      ? Object.values(goals).filter(
          g => g.id !== focusedGoalId && !isGoalInactive(g.status),
        ).length
      : 0

  return (
    <Text>
      <Text color={dotColor}>●</Text>
      <Text dimColor> goal: </Text>
      <Text>{truncated}</Text>
      <Text dimColor> [{label}]</Text>
      {otherOpen > 0 ? <Text dimColor> (+{otherOpen} open)</Text> : null}
    </Text>
  )
}