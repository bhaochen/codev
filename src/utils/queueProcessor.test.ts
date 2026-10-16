import { describe, expect, it } from 'vitest'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { asAgentId } from '../types/ids.js'
import { mergeConsecutiveTaskNotifications } from './queueProcessor.js'

function taskNotification(value: string, agentId?: string): QueuedCommand {
  return {
    value,
    mode: 'task-notification',
    agentId: agentId !== undefined ? asAgentId(agentId) : undefined,
    uuid: `00000000-0000-4000-8000-${value.length.toString().padStart(12, '0')}`,
  }
}

function prompt(value: string): QueuedCommand {
  return { value, mode: 'prompt' }
}

describe('mergeConsecutiveTaskNotifications', () => {
  it('passes a single notification through unchanged', () => {
    const cmd = taskNotification('<task-notification>a</task-notification>')
    const out = mergeConsecutiveTaskNotifications([cmd])
    expect(out).toHaveLength(1)
    expect(out[0]).toBe(cmd)
  })

  it('merges consecutive notifications into one joined message', () => {
    const a = taskNotification('A')
    const b = taskNotification('B')
    const c = taskNotification('C')
    const out = mergeConsecutiveTaskNotifications([a, b, c])
    expect(out).toHaveLength(1)
    expect(out[0]!.value).toBe('A\nB\nC')
    // First notification's identity is kept.
    expect(out[0]!.uuid).toBe(a.uuid)
  })

  it('does not merge across a user prompt', () => {
    const out = mergeConsecutiveTaskNotifications([
      taskNotification('A'),
      prompt('hello'),
      taskNotification('B'),
    ])
    expect(out).toHaveLength(3)
    expect(out[1]!.mode).toBe('prompt')
  })

  it('does not merge notifications for different agents', () => {
    const out = mergeConsecutiveTaskNotifications([
      taskNotification('A'),
      taskNotification('B', 'agent-1'),
      taskNotification('C', 'agent-1'),
    ])
    expect(out).toHaveLength(2)
    expect(out[0]!.value).toBe('A')
    expect(out[1]!.value).toBe('B\nC')
    expect(out[1]!.agentId).toBe('agent-1')
  })

  it('does not merge non-string payloads', () => {
    const blockPayload: QueuedCommand = {
      value: [{ type: 'text', text: 'block' }],
      mode: 'task-notification',
    }
    const out = mergeConsecutiveTaskNotifications([
      taskNotification('A'),
      blockPayload,
      taskNotification('C'),
    ])
    expect(out).toHaveLength(3)
    expect(out[1]).toBe(blockPayload)
  })

  it('returns other command kinds untouched', () => {
    const bash: QueuedCommand = { value: 'ls -la', mode: 'bash' }
    const out = mergeConsecutiveTaskNotifications([bash, prompt('/help')])
    expect(out).toHaveLength(2)
    expect(out[0]).toBe(bash)
  })

  it('handles an empty list', () => {
    expect(mergeConsecutiveTaskNotifications([])).toEqual([])
  })
})
