import { describe, expect, test } from 'bun:test'
import type { Message } from '../../../types/message.js'
import { tryCodevCompact } from './codevCompact.js'
import { parseConfig } from './config.js'
import { DecisionEngine } from './decision.js'
import { buildJudge } from './registry.js'

/**
 * E1, compaction without a summary: the tool output that is no longer worth its tokens goes, word for word, and
 * nothing anyone said is rewritten. These tests run the whole way a real compaction does — codev's own message
 * shapes in, the judge cascade from the configured tiers answering, the history text out — with a judge that never
 * touches the network.
 */

const engineWith = (tiers: string[]): DecisionEngine => {
  const { judge } = buildJudge(parseConfig({ tiers, modes: { default: 'active' } }))
  return new DecisionEngine({ judge, defaultMode: 'active' })
}

const OPTIONS = {
  keepThreshold: 0.5,
  minChars: 600,
  headChars: 300,
  targetRatio: 0.5,
  maxWindowShare: 0.25,
  freeChars: 24_000,
  maxJudged: 120,
  /** A 200K-token window in characters. */
  contextWindow: 700_000,
}

/** Long enough to be worth pruning (`minChars`), and distinctive enough to find in the output. */
const output = (marker: string): string => `${marker} ${'lorem ipsum dolor sit amet '.repeat(40)}`.slice(0, 900)

function say(text: string): Message {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    uuid: `say-${text.slice(0, 8)}`,
    timestamp: '2026-01-01T00:00:00.000Z',
  }
}

function toolCall(name: string, input: Record<string, unknown>, id: string): Message {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    uuid: `call-${id}`,
    timestamp: '2026-01-01T00:00:00.000Z',
  }
}

function toolResult(id: string, content: string): Message {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
    uuid: `result-${id}`,
    timestamp: '2026-01-01T00:00:00.000Z',
  }
}

describe('tryCodevCompact', () => {
  test('prunes output no longer needed, keeps what the live turn still refers to, and never rewrites what was said', async () => {
    const messages: Message[] = [
      // The paths are in the calls, not in what was said: only the last line names a file as still live.
      say('Read the three files below.'),
      toolCall('read', { path: 'src/agent/loop.ts' }, 'c1'),
      toolResult('c1', output('KEEP-LOOP')),
      toolCall('read', { path: 'docs/plan.md' }, 'c2'),
      toolResult('c2', output('STALE-PLAN')),
      toolCall('read', { path: 'vendor/legacy/blob.bin' }, 'c3'),
      toolResult('c3', output('IRRELEVANT-BLOB')),
      // docs/plan.md is read again, so the first read describes a state that no longer exists.
      toolCall('read', { path: 'docs/plan.md' }, 'c4'),
      toolResult('c4', output('SECOND-PLAN')),
      say('Now fix the agent loop in src/agent/loop.ts.'),
    ]

    const result = await tryCodevCompact(messages, { engine: engineWith(['mock']), ...OPTIONS })

    expect(result).not.toBeNull()
    const compact = result!

    // What people said is complete and in order, word for word.
    expect(compact.historyText).toContain('This is the earlier part of the conversation, word for word.')
    expect(compact.historyText).toContain('Read the three files below.')
    expect(compact.historyText).toContain('Now fix the agent loop in src/agent/loop.ts.')

    // Still worth its tokens: the whole 900 characters are there, not a 300-character head.
    expect(compact.historyText).toContain(output('KEEP-LOOP'))

    // Read again since: pruned by rule, no judgment needed.
    const stale = compact.plans.find(plan => plan.reason.includes('read again later'))
    expect(stale?.action).toBe('prune')
    expect(compact.historyText).toContain('pruned: first 300 of 900 chars')
    expect(compact.historyText).not.toContain(output('STALE-PLAN'))

    // Nothing live refers to it: the judge and the lexical match agree it goes.
    expect(compact.historyText).not.toContain(output('IRRELEVANT-BLOB'))
    expect(compact.historyText).toContain('blob.bin')

    // Every kept call is renumbered and still readable.
    expect(compact.historyText).toContain('[Tool call t1] read path="src/agent/loop.ts"')
    expect(compact.fits).toBe(true)
  })

  test('returns null when nothing is worth pruning, so the caller falls back to the summary', async () => {
    // One short result: under `minChars`, so it is not worth asking about or pruning.
    const messages: Message[] = [
      say('What does this do?'),
      toolCall('read', { path: 'src/tiny.ts' }, 'c1'),
      toolResult('c1', 'export const x = 1'),
    ]

    expect(await tryCodevCompact(messages, { engine: engineWith(['mock']), ...OPTIONS })).toBeNull()
  })

  test('returns null when there are no tool calls at all', async () => {
    const messages: Message[] = [say('hello'), say('are you there?')]
    expect(await tryCodevCompact(messages, { engine: engineWith(['mock']), ...OPTIONS })).toBeNull()
  })

  test('with no judge configured, the rules still prune what is stale', async () => {
    const messages: Message[] = [
      say('Read docs/plan.md twice.'),
      toolCall('read', { path: 'docs/plan.md' }, 'c1'),
      toolResult('c1', output('FIRST')),
      toolCall('read', { path: 'docs/plan.md' }, 'c2'),
      toolResult('c2', output('SECOND')),
    ]

    const result = await tryCodevCompact(messages, { engine: engineWith([]), ...OPTIONS })

    // No tier can answer, so the cascade fails and every verdict falls back to the prior. A file read again
    // later needs no judge at all: that is the point of doing the rules first.
    expect(result).not.toBeNull()
    expect(result!.plans.filter(plan => plan.action === 'prune')).toHaveLength(1)
    expect(result!.plans.find(plan => plan.action === 'prune')?.reason).toContain('read again later')
  })

  test('the budget squeezes the lowest scores first when the threshold alone would keep everything', async () => {
    // Every file is named in what was said, so relevance is 1 for all three and the threshold keeps them all:
    // only the budget can prune here.
    const messages: Message[] = [
      say('Read vendor/a/one.bin, vendor/b/two.bin and vendor/c/three.bin.'),
      toolCall('read', { path: 'vendor/a/one.bin' }, 'c1'),
      toolResult('c1', output('ONE')),
      toolCall('read', { path: 'vendor/b/two.bin' }, 'c2'),
      toolResult('c2', output('TWO')),
      toolCall('read', { path: 'vendor/c/three.bin' }, 'c3'),
      toolResult('c3', output('THREE')),
    ]
    // Three quarters of what came before, with no free allowance: the threshold keeps all three, the budget cuts.
    const tight = { ...OPTIONS, targetRatio: 0.75, freeChars: 0 }

    const result = await tryCodevCompact(messages, { engine: engineWith(['mock']), ...tight })

    expect(result).not.toBeNull()
    const compact = result!
    const pruned = compact.plans.filter(plan => plan.action === 'prune')
    expect(pruned.length).toBeGreaterThan(0)
    // Whatever the budget cuts says so, so a reader knows it was the budget and not a judgment.
    for (const plan of pruned) expect(plan.reason).toContain('to fit the budget')
    expect(compact.fits).toBe(true)
  })

  test('gives up when what people said alone is over the budget, so the summary can say it in a sentence', async () => {
    const messages: Message[] = [
      say('Read vendor/a/one.bin.'),
      toolCall('read', { path: 'vendor/a/one.bin' }, 'c1'),
      toolResult('c1', output('ONE')),
    ]
    // A budget nothing can meet: the user said more than it allows, and nothing said is ever pruned.
    const impossible = { ...OPTIONS, targetRatio: 0.01, freeChars: 0 }

    expect(await tryCodevCompact(messages, { engine: engineWith(['mock']), ...impossible })).toBeNull()
  })

  test('a history of only talk is left alone: nothing said is ever pruned', async () => {
    const long = 'a sentence the user wrote. '.repeat(400)
    const messages: Message[] = [say(long), say(long)]

    expect(await tryCodevCompact(messages, { engine: engineWith(['mock']), ...OPTIONS })).toBeNull()
  })
})
