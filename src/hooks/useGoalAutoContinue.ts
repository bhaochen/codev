import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import {
  buildContinuationPrompt,
  getFocusedGoal,
  getGoalContinuationGoalId,
  isGoalContinuationPrompt,
} from '../utils/goal.js'
import {
  enqueue,
  getCommandQueue,
  removeByFilter,
} from '../utils/messageQueueManager.js'
import type { QueryGuard } from '../utils/QueryGuard.js'

/**
 * Auto-continuation hook for /goal. Subscribes to the QueryGuard's
 * isActive snapshot via useSyncExternalStore. When isActive transitions
 * from true -> false (turn just ended), and a goal is pursuing, enqueue
 * a meta continuation prompt.
 *
 * Bails out for: no goal, non-pursuing status, or plan mode.
 */
export function useGoalAutoContinue(queryGuard: QueryGuard): void {
  const isActive = useSyncExternalStore(
    queryGuard.subscribe,
    queryGuard.getSnapshot,
  )
  const goal = useAppState(getFocusedGoal)
  const mode = useAppState(s => s.toolPermissionContext.mode)
  const setAppState = useSetAppState()

  const wasActiveRef = useRef(isActive)

  useEffect(() => {
    const wasActive = wasActiveRef.current
    wasActiveRef.current = isActive

    // Only fire on running -> idle transition.
    if (!(wasActive && !isActive)) return

    if (!goal) return
    if (goal.status !== 'pursuing') return
    if (mode === 'plan') return

    const now = Date.now()

    // User/control input wins over autonomous continuation.
    const queue = getCommandQueue()
    const hasBlockingQueuedWork = queue.some(
      cmd => !isGoalContinuationPrompt(cmd.value),
    )
    if (hasBlockingQueuedWork) return

    const alreadyQueuedForThisGoal = queue.some(
      cmd => getGoalContinuationGoalId(cmd.value) === goal.id,
    )
    if (alreadyQueuedForThisGoal) return

    removeByFilter(cmd => {
      if (!isGoalContinuationPrompt(cmd.value)) return false
      return getGoalContinuationGoalId(cmd.value) !== goal.id
    })

    const prompt = buildContinuationPrompt(goal, now)
    enqueue({
      mode: 'prompt',
      value: prompt,
      priority: 'later',
      isMeta: true,
    })

    setAppState(prev => ({
      ...prev,
      goals:
        prev.goals &&
        prev.focusedGoalId &&
        prev.goals[prev.focusedGoalId]?.id === goal.id
          ? {
              ...prev.goals,
              [prev.focusedGoalId]: {
                ...prev.goals[prev.focusedGoalId],
                continuationCount:
                  prev.goals[prev.focusedGoalId].continuationCount + 1,
                lastUpdatedAt: now,
              },
            }
          : prev.goals,
    }))
  }, [isActive, goal, mode, setAppState])
}