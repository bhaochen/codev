import { describe, expect, it } from 'bun:test'
import type { LogOption } from '../types/logs.js'
import { updateForkForestTitle, type ForkNode } from './forkGraph.js'

function createNode(
  sessionId: string,
  title: string,
  children: ForkNode[] = [],
): ForkNode {
  const now = new Date()
  const log: LogOption = {
    date: '2026-10-05',
    messages: [],
    fullPath: `/sessions/${sessionId}.jsonl`,
    value: 0,
    created: now,
    modified: now,
    firstPrompt: '',
    messageCount: 0,
    isSidechain: false,
    sessionId,
    customTitle: title,
  }
  return { sessionId, parentId: null, log, children }
}

describe('updateForkForestTitle', () => {
  it('renames a historical node without changing its ancestors or siblings', () => {
    const sibling = createNode('sibling', 'Sibling')
    const target = createNode('target', 'Old title')
    const root = createNode('root', 'Root', [target, sibling])

    const updated = updateForkForestTitle([root], 'target', 'New title')

    expect(updated[0]?.log.customTitle).toBe('Root')
    expect(updated[0]?.children[0]?.log.customTitle).toBe('New title')
    expect(updated[0]?.children[1]?.log.customTitle).toBe('Sibling')
    expect(updated[0]).not.toBe(root)
    expect(updated[0]?.children[0]).not.toBe(target)
    expect(root.children[0]?.log.customTitle).toBe('Old title')
  })
})
