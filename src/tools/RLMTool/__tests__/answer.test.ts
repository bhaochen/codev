import { describe, expect, test } from 'bun:test'
import { formatReplOutputs, latestStdoutOf } from '../answer.js'
import type { ReplResult } from '../protocol.js'

function result(stdout: string): ReplResult {
  return {
    stdout,
    stderr: '',
    finalAnswer: null,
    answerContent: '',
    raised: false,
    executionTimeMs: 1,
    varNames: [],
  }
}

describe('RLM stdout preservation', () => {
  test('keeps the middle of large stdout in model history', () => {
    const stdout = Array.from({ length: 2_000 }, (_, i) => `edge-${i}`).join('\n')
    const formatted = formatReplOutputs([result(stdout)])

    expect(formatted).toContain('edge-0')
    expect(formatted).toContain('edge-999')
    expect(formatted).toContain('edge-1999')
    expect(formatted).not.toContain('chars elided')
  })

  test('keeps the complete latest stdout for fallback answers', () => {
    const stdout = 'header\n' + 'middle-edge\n'.repeat(2_000) + 'footer'
    expect(latestStdoutOf([result(stdout)])).toBe(stdout.trim())
  })
})
