import { describe, test, expect } from 'bun:test'
import { PythonSandbox } from '../sandbox.js'

describe('PythonSandbox context loading', () => {
  test('loadContext seeds `context` and search queries it', async () => {
    const sandbox = await PythonSandbox.spawn({ python: 'python3', execTimeoutS: 10, initTimeoutMs: 10_000 })
    try {
      const payload = [
        { path: 'src/foo.ts', content: 'export function add(a: number, b: number) { return a + b }' },
        { path: 'src/bar.ts', content: 'const greeting = "hello world"; console.log(greeting)' },
      ]
      await sandbox.loadContext(payload)

      const res = await sandbox.exec('search("add function")')
      expect(res.stdout).toContain('src/foo.ts')
      expect(res.raised).toBe(false)

      const ctx = await sandbox.exec('len(context)')
      expect(ctx.stdout.trim()).toBe('2')
    } finally {
      await sandbox.dispose()
    }
  })

  test('multiple sandboxes each get their own context', async () => {
    const [a, b] = await Promise.all([
      PythonSandbox.spawn({ python: 'python3', execTimeoutS: 10, initTimeoutMs: 10_000 }),
      PythonSandbox.spawn({ python: 'python3', execTimeoutS: 10, initTimeoutMs: 10_000 }),
    ])
    try {
      await a.loadContext([{ path: 'a.txt', content: 'alpha beta' }])
      await b.loadContext([{ path: 'b.txt', content: 'gamma delta' }])
      const ra = await a.exec('search("alpha")')
      const rb = await b.exec('search("alpha")')
      expect(ra.stdout).toContain('a.txt')
      expect(rb.stdout).not.toContain('a.txt')
    } finally {
      await Promise.all([a.dispose(), b.dispose()])
    }
  })
})