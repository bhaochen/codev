import { describe, it, expect } from 'vitest'
import { extractListingMeta, mergeListingMeta } from './listingProjection.js'
import type { Entry } from '../../types/logs.js'

const S = '00000000-0000-4000-8000-0000000000c1'

function e(fields: Record<string, unknown>): Entry {
  return { sessionId: S, ...fields } as unknown as Entry
}

describe('listingProjection', () => {
  describe('extractListingMeta', () => {
    it('last-wins for tail-scanned fields', () => {
      const meta = extractListingMeta([
        e({ type: 'last-prompt', lastPrompt: 'first' }),
        e({ type: 'tag', tag: '#one' }),
        e({ type: 'last-prompt', lastPrompt: 'latest' }),
        e({ type: 'tag', tag: '#two' }),
      ])
      expect(meta.lastPrompt).toBe('latest')
      expect(meta.tag).toBe('#two')
    })

    it('tracks customTitle and aiTitle separately (file precedence: customTitle ?? aiTitle)', () => {
      const meta = extractListingMeta([
        e({ type: 'ai-title', aiTitle: 'AI title' }),
        e({ type: 'custom-title', customTitle: 'User title' }),
      ])
      expect(meta.customTitle).toBe('User title')
      expect(meta.aiTitle).toBe('AI title')
      // Reader applies: customTitle ?? aiTitle
      expect(meta.customTitle ?? meta.aiTitle).toBe('User title')
    })

    it('aiTitle alone still wins over nothing (later ai-title overrides)', () => {
      const meta = extractListingMeta([
        e({ type: 'ai-title', aiTitle: 'v1' }),
        e({ type: 'ai-title', aiTitle: 'v2' }),
      ])
      expect(meta.customTitle).toBeUndefined()
      expect(meta.aiTitle).toBe('v2')
    })

    it('first-wins for head-scanned fields (cwd, teamName, isSidechain)', () => {
      const meta = extractListingMeta([
        e({ type: 'user', cwd: '/first', teamName: 'team-a', isSidechain: false }),
        e({ type: 'assistant', cwd: '/second', teamName: 'team-b', isSidechain: true }),
      ])
      expect(meta.projectPath).toBe('/first')
      expect(meta.teamName).toBe('team-a')
      expect(meta.isSidechain).toBe(false)
    })

    it('gitBranch is last-wins (tail scan semantics)', () => {
      const meta = extractListingMeta([
        e({ type: 'user', gitBranch: 'main' }),
        e({ type: 'assistant', gitBranch: 'feature/x' }),
      ])
      expect(meta.gitBranch).toBe('feature/x')
    })

    it('pr-link fields', () => {
      const meta = extractListingMeta([
        e({ type: 'pr-link', prNumber: 1, prUrl: 'https://a', prRepository: 'repo-a' }),
        e({ type: 'pr-link', prNumber: 42, prUrl: 'https://b', prRepository: 'repo-b' }),
      ])
      expect(meta.prNumber).toBe(42)
      expect(meta.prUrl).toBe('https://b')
      expect(meta.prRepository).toBe('repo-b')
    })

    it('agent-setting, agent-name, agent-color, summary', () => {
      const meta = extractListingMeta([
        e({ type: 'agent-setting', agentSetting: 'normal' }),
        e({ type: 'agent-name', agentName: 'Worker' }),
        e({ type: 'agent-color', agentColor: 'blue' }),
        e({ type: 'summary', summary: 'did things' }),
      ])
      expect(meta.agentSetting).toBe('normal')
      expect(meta.agentName).toBe('Worker')
      expect(meta.agentColor).toBe('blue')
      expect(meta.summary).toBe('did things')
    })

    it('ignores empty strings', () => {
      const meta = extractListingMeta([
        e({ type: 'last-prompt', lastPrompt: '' }),
        e({ type: 'user', gitBranch: '' }),
      ])
      expect(meta.lastPrompt).toBeUndefined()
      expect(meta.gitBranch).toBeUndefined()
    })
  })

  describe('mergeListingMeta', () => {
    it('defined patch values overwrite existing', () => {
      const merged = mergeListingMeta(
        { lastPrompt: 'old', gitBranch: 'main' },
        { lastPrompt: 'new' },
      )
      expect(merged.lastPrompt).toBe('new')
      expect(merged.gitBranch).toBe('main')
    })

    it('first-wins keys only fill when absent', () => {
      const merged = mergeListingMeta(
        { projectPath: '/first', teamName: 'team-a' },
        { projectPath: '/later', teamName: 'team-b' },
      )
      expect(merged.projectPath).toBe('/first')
      expect(merged.teamName).toBe('team-a')
    })

    it('fills first-wins keys when previously absent', () => {
      const merged = mergeListingMeta({}, { projectPath: '/first' })
      expect(merged.projectPath).toBe('/first')
    })

    it('does not clobber with undefined patch values', () => {
      const merged = mergeListingMeta({ lastPrompt: 'keep' }, { gitBranch: 'main' })
      expect(merged.lastPrompt).toBe('keep')
      expect(merged.gitBranch).toBe('main')
    })
  })
})
