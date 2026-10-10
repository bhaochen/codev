import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { formatAgentLine, getPrompt } from './prompt.js'
import type { AgentDefinition } from './loadAgentsDir.js'

// getPrompt → getSubscriptionType needs an auth source to be present.
const prevKey = process.env.ANTHROPIC_API_KEY
beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-unit-test'
})
afterAll(() => {
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = prevKey
})

describe('formatAgentLine', () => {
  test('announces a pinned provider so the spawner does not override it', () => {
    const agent = {
      agentType: 'pinned-agent',
      whenToUse: 'does a thing',
      tools: ['Read'],
      provider: 'openrouter',
      model: 'google/gemini-2.5-flash',
    } as unknown as AgentDefinition
    const line = formatAgentLine(agent)
    expect(line).toContain('Pinned to openrouter / google/gemini-2.5-flash')
    expect(line).toContain('do not pass `model`')
  })

  test('a non-pinned agent line is unchanged', () => {
    const agent = {
      agentType: 'plain',
      whenToUse: 'does a thing',
      tools: ['Read'],
    } as unknown as AgentDefinition
    expect(formatAgentLine(agent)).toBe('- plain: does a thing (Tools: Read)')
  })
})

describe('getPrompt subagent surface', () => {
  test('teaches naming and continuing a stayed-alive agent', async () => {
    const prompt = await getPrompt([], false)
    expect(prompt).toContain('Pass a short `name`')
    expect(prompt).toContain('picks the message up at its next tool round')
    expect(prompt).toContain('Prefer continuing an existing agent over spawning a fresh one')
    expect(prompt).toContain('warm prompt cache')
  })

  test('includes the implementation-prompt and side-by-side guidance', async () => {
    const prompt = await getPrompt([], false)
    expect(prompt).toContain('An implementation prompt covers three things')
    expect(prompt).toContain('Running agents side by side')
    expect(prompt).toContain('Give each agent disjoint files')
  })
})
