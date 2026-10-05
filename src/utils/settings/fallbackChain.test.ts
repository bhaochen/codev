import { describe, expect, test } from 'bun:test'
import { SettingsSchema } from './types.js'

describe('fallback chain settings', () => {
  test('accepts ordered provider targets and optional effort', () => {
    const parsed = SettingsSchema().parse({
      fallbackChain: [
        { provider: 'openai', model: 'gpt-5', effort: 'high' },
        { provider: 'firstParty', model: 'claude-sonnet-4-6' },
      ],
      fallbackEnabled: true,
    })
    expect(parsed.fallbackChain).toEqual([
      { provider: 'openai', model: 'gpt-5', effort: 'high' },
      { provider: 'firstParty', model: 'claude-sonnet-4-6' },
    ])
  })

  test('rejects unsupported providers and chains longer than three', () => {
    const invalidProvider = SettingsSchema().safeParse({
      fallbackChain: [{ provider: 'bedrock', model: 'claude-sonnet' }],
    })
    const tooManyTargets = SettingsSchema().safeParse({
      fallbackChain: [
        { provider: 'openai', model: 'one' },
        { provider: 'opencode', model: 'two' },
        { provider: 'nvidia', model: 'three' },
        { provider: 'firstParty', model: 'four' },
      ],
    })
    expect(invalidProvider.success).toBe(false)
    expect(tooManyTargets.success).toBe(false)
  })
})
