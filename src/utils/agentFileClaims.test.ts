/**
 * Subagent file-write ownership.
 *
 * These pin the two things that make the mechanism safe to put in the write
 * path: it must never engage outside a genuine multi-agent race, and it must
 * never strand a path behind an agent that is gone.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { runWithAgentContext, type SubagentContext } from './agentContext.js'
import {
  _orphanAgentForTest,
  _ownerLabelForTest,
  _resetAgentFileClaimsForTest,
  beginAgentFileScope,
  checkAgentFileClaim,
  endAgentFileScope,
  enforceAgentFileClaim,
} from './agentFileClaims.js'

/** Run `fn` as if it were subagent `id`'s async execution chain. */
function asAgent<T>(id: string, fn: () => T): T {
  return runWithAgentContext(
    { agentId: id, agentType: 'subagent' } as SubagentContext,
    fn,
  )
}

function throws(fn: () => void): Error | undefined {
  try {
    fn()
    return undefined
  } catch (e) {
    return e as Error
  }
}

const FILE = process.platform === 'win32' ? 'C:\\repo\\src\\app.ts' : '/repo/src/app.ts'
const OTHER =
  process.platform === 'win32' ? 'C:\\repo\\src\\other.ts' : '/repo/src/other.ts'

beforeEach(() => {
  _resetAgentFileClaimsForTest()
})

describe('agent file claims', () => {
  test('the main session is never blocked and never claims', () => {
    beginAgentFileScope('a', 'alpha')
    beginAgentFileScope('b', 'bravo')
    // No agent context = main session.
    enforceAgentFileClaim(FILE)
    expect(_ownerLabelForTest(FILE)).toBeUndefined()
  })

  // The live agent count at write time says nothing about the count a moment
  // later: an agent is routinely the only one running when it writes and racing
  // a second agent by the time that file matters. So ownership is recorded
  // whenever a registered subagent writes, and only the *refusal* depends on who
  // else is running — which is why a lone agent can claim and still never be
  // blocked.
  test('a lone subagent claims what it writes, and is never refused', () => {
    beginAgentFileScope('a', 'alpha')
    asAgent('a', () => enforceAgentFileClaim(FILE))
    expect(_ownerLabelForTest(FILE)).toBe('alpha')
    expect(throws(() => asAgent('a', () => enforceAgentFileClaim(FILE)))).toBeUndefined()
  })

  test('a path claimed while alone still blocks an agent that starts later', () => {
    beginAgentFileScope('a', 'alpha')
    asAgent('a', () => enforceAgentFileClaim(FILE))
    beginAgentFileScope('b', 'bravo')
    const err = throws(() => asAgent('b', () => enforceAgentFileClaim(FILE)))
    expect(err).toBeDefined()
    expect(err!.message).toContain('alpha')
  })

  // The reported failure, exactly: two agents spawn together, the short one
  // finishes before the long one reaches its Edit, then SendMessage resumes it
  // while the long one is still running and still owns the file.
  test('a resumed agent is refused by the agent still holding the path', () => {
    beginAgentFileScope('holder', 'holder')
    beginAgentFileScope('worker', 'worker')
    endAgentFileScope('worker')
    asAgent('holder', () => enforceAgentFileClaim(FILE))
    beginAgentFileScope('worker', 'worker')

    let seen: string | undefined
    asAgent('worker', () => {
      seen = checkAgentFileClaim(FILE)
    })
    expect(seen).toBe('holder')
    expect(throws(() => asAgent('worker', () => enforceAgentFileClaim(FILE)))).toBeDefined()
    expect(_ownerLabelForTest(FILE)).toBe('holder')
  })

  test('the first of two concurrent subagents takes ownership', () => {
    beginAgentFileScope('a', 'alpha')
    beginAgentFileScope('b', 'bravo')
    asAgent('a', () => enforceAgentFileClaim(FILE))
    expect(_ownerLabelForTest(FILE)).toBe('alpha')
  })

  test('a second subagent is refused, and told who owns it', () => {
    beginAgentFileScope('a', 'alpha')
    beginAgentFileScope('b', 'bravo')
    asAgent('a', () => enforceAgentFileClaim(FILE))
    const err = throws(() => asAgent('b', () => enforceAgentFileClaim(FILE)))
    expect(err).toBeDefined()
    expect(err!.message).toContain('alpha')
    expect(err!.message).toContain(FILE)
  })

  test('the owner may keep writing its own file', () => {
    beginAgentFileScope('a', 'alpha')
    beginAgentFileScope('b', 'bravo')
    asAgent('a', () => enforceAgentFileClaim(FILE))
    expect(throws(() => asAgent('a', () => enforceAgentFileClaim(FILE)))).toBeUndefined()
  })

  test('disjoint files never conflict', () => {
    beginAgentFileScope('a', 'alpha')
    beginAgentFileScope('b', 'bravo')
    asAgent('a', () => enforceAgentFileClaim(FILE))
    expect(throws(() => asAgent('b', () => enforceAgentFileClaim(OTHER)))).toBeUndefined()
  })

  test('claims are released when the owner finishes', () => {
    beginAgentFileScope('a', 'alpha')
    beginAgentFileScope('b', 'bravo')
    asAgent('a', () => enforceAgentFileClaim(FILE))
    endAgentFileScope('a')
    beginAgentFileScope('c', 'charlie')
    expect(throws(() => asAgent('b', () => enforceAgentFileClaim(FILE)))).toBeUndefined()
  })

  test('a claim whose owner vanished is taken over, not stranded', () => {
    beginAgentFileScope('a', 'alpha')
    beginAgentFileScope('b', 'bravo')
    asAgent('a', () => enforceAgentFileClaim(FILE))
    // Simulate a run that ended without its cleanup finally.
    _orphanAgentForTest('a')
    beginAgentFileScope('c', 'charlie')
    expect(throws(() => asAgent('b', () => enforceAgentFileClaim(FILE)))).toBeUndefined()
    expect(_ownerLabelForTest(FILE)).toBe('bravo')
  })

  test('an unregistered agent id is not part of the concurrent set', () => {
    beginAgentFileScope('a', 'alpha')
    beginAgentFileScope('b', 'bravo')
    asAgent('a', () => enforceAgentFileClaim(FILE))
    expect(throws(() => asAgent('ghost', () => enforceAgentFileClaim(FILE)))).toBeUndefined()
  })

  test('releasing an agent drops only its own claims', () => {
    beginAgentFileScope('a', 'alpha')
    beginAgentFileScope('b', 'bravo')
    asAgent('a', () => enforceAgentFileClaim(FILE))
    asAgent('b', () => enforceAgentFileClaim(OTHER))
    endAgentFileScope('a')
    expect(_ownerLabelForTest(FILE)).toBeUndefined()
    expect(_ownerLabelForTest(OTHER)).toBe('bravo')
  })

  test('a relative path is refused, never resolved against the wrong cwd', () => {
    beginAgentFileScope('a', 'alpha')
    beginAgentFileScope('b', 'bravo')
    // process.cwd() is not an agent's working directory once a spawn runs under
    // isolation:"worktree", so guessing an absolute path here would key one
    // agent's file under another's tree. Every real caller passes an absolute
    // path; a relative one must be skipped rather than guessed.
    asAgent('a', () => enforceAgentFileClaim('src/relative.ts'))
    expect(_ownerLabelForTest('src/relative.ts')).toBeUndefined()
    let seen: string | undefined = 'x'
    asAgent('b', () => {
      seen = checkAgentFileClaim('src/relative.ts')
    })
    expect(seen).toBeUndefined()
  })

  // checkAgentFileClaim is what the mutating tools call in validateInput, before
  // they read the file or match old_string. Without it the write-path backstop is
  // the first thing to fire — and by then Edit has already rejected with "String
  // to replace not found", which names no agent and invites the loser to retry
  // against the winner's content.
  test('checkAgentFileClaim names the owner without taking ownership', () => {
    beginAgentFileScope('a', 'alpha')
    beginAgentFileScope('b', 'bravo')
    asAgent('a', () => enforceAgentFileClaim(FILE))

    let seen: string | undefined
    asAgent('b', () => {
      seen = checkAgentFileClaim(FILE)
    })
    expect(seen).toBe('alpha')
    expect(_ownerLabelForTest(FILE)).toBe('alpha')
  })

  test('checkAgentFileClaim is silent for the owner, main session, and lone agents', () => {
    beginAgentFileScope('a', 'alpha')
    beginAgentFileScope('b', 'bravo')
    asAgent('a', () => enforceAgentFileClaim(FILE))

    let own: string | undefined = 'x'
    asAgent('a', () => {
      own = checkAgentFileClaim(FILE)
    })
    expect(own).toBeUndefined()
    expect(checkAgentFileClaim(FILE)).toBeUndefined()

    endAgentFileScope('b')
    let lone: string | undefined = 'x'
    asAgent('a', () => {
      lone = checkAgentFileClaim(FILE)
    })
    expect(lone).toBeUndefined()
  })

  test('checkAgentFileClaim never claims on an unowned path', () => {
    beginAgentFileScope('a', 'alpha')
    beginAgentFileScope('b', 'bravo')
    asAgent('b', () => checkAgentFileClaim(OTHER))
    expect(_ownerLabelForTest(OTHER)).toBeUndefined()
  })

  if (process.platform === 'win32') {
    test('windows paths collide case-insensitively', () => {
      beginAgentFileScope('a', 'alpha')
      beginAgentFileScope('b', 'bravo')
      asAgent('a', () => enforceAgentFileClaim('C:\\repo\\Src\\App.ts'))
      expect(
        throws(() => asAgent('b', () => enforceAgentFileClaim('C:\\repo\\src\\app.ts'))),
      ).toBeDefined()
    })
  }
})
