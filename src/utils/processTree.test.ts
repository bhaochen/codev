import { describe, expect, test } from 'bun:test'
import { killProcessTree, resolveWindowsTaskkillPath } from './processTree.js'

describe('resolveWindowsTaskkillPath', () => {
  test('prefers SystemRoot, joins System32/taskkill.exe', () => {
    expect(resolveWindowsTaskkillPath({ SystemRoot: 'C:\\Windows' })).toBe(
      'C:\\Windows\\System32\\taskkill.exe',
    )
  })

  test('falls back to WINDIR', () => {
    expect(resolveWindowsTaskkillPath({ WINDIR: 'D:\\Win' })).toBe(
      'D:\\Win\\System32\\taskkill.exe',
    )
  })

  test('rejects a relative or injection-bearing root', () => {
    expect(resolveWindowsTaskkillPath({ SystemRoot: 'Windows' })).toBeNull()
    expect(
      resolveWindowsTaskkillPath({ SystemRoot: 'C:\\Windows\ncalc' }),
    ).toBeNull()
    expect(resolveWindowsTaskkillPath({})).toBeNull()
  })
})

describe('killProcessTree', () => {
  test('non-Windows keeps tree-kill with SIGKILL', () => {
    const calls: Array<[number, string]> = []
    killProcessTree(123, {
      platform: 'linux',
      treeKillImpl: ((pid: number, signal: string) => {
        calls.push([pid, signal])
      }) as never,
    })
    expect(calls).toEqual([[123, 'SIGKILL']])
  })

  test('Windows spawns the absolute System32 taskkill, not a bare name', () => {
    const spawned: Array<{ file: string; args: string[]; opts: unknown }> = []
    const treeCalls: number[] = []
    killProcessTree(456, {
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      spawnImpl: ((file: string, args: string[], opts: unknown) => {
        spawned.push({ file, args, opts })
        return { once: () => {} }
      }) as never,
      treeKillImpl: ((pid: number) => {
        treeCalls.push(pid)
      }) as never,
    })
    expect(treeCalls).toEqual([])
    expect(spawned).toHaveLength(1)
    expect(spawned[0]!.file).toBe('C:\\Windows\\System32\\taskkill.exe')
    expect(spawned[0]!.args).toEqual(['/PID', '456', '/T', '/F'])
  })

  test('Windows without a resolvable root falls back to direct kill', () => {
    const killed: Array<[number, string]> = []
    killProcessTree(789, {
      platform: 'win32',
      env: {},
      processKillImpl: ((pid: number, signal: string) => {
        killed.push([pid, signal])
      }) as never,
    })
    expect(killed).toEqual([[789, 'SIGKILL']])
  })

  test('a failing spawn stays silent', () => {
    expect(() =>
      killProcessTree(1, {
        platform: 'win32',
        env: { SystemRoot: 'C:\\Windows' },
        spawnImpl: (() => {
          throw new Error('ENOENT')
        }) as never,
      }),
    ).not.toThrow()
  })
})
