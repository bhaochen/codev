import { describe, test, expect } from 'bun:test'
import { PythonSandbox } from '../sandbox.js'

describe('PythonSandbox', () => {
  test('spawns and executes basic code', async () => {
    const sandbox = await PythonSandbox.spawn({ python: 'python3', execTimeoutS: 10, initTimeoutMs: 10_000 })
    try {
      const res = await sandbox.exec('print(2 + 3)')
      expect(res.stdout.trim()).toBe('5')
      expect(res.raised).toBe(false)
    } finally {
      await sandbox.dispose()
    }
  })

  test('captures stderr', async () => {
    const sandbox = await PythonSandbox.spawn({ python: 'python3', execTimeoutS: 10, initTimeoutMs: 10_000 })
    try {
      const res = await sandbox.exec('import sys; print("err msg", file=sys.stderr)')
      expect(res.stderr).toContain('err msg')
      expect(res.raised).toBe(false)
    } finally {
      await sandbox.dispose()
    }
  })

  test('variable persists across exec calls', async () => {
    const sandbox = await PythonSandbox.spawn({ python: 'python3', execTimeoutS: 10, initTimeoutMs: 10_000 })
    try {
      const r1 = await sandbox.exec('x = 99')
      expect(r1.varNames).toContain('x')
      const r2 = await sandbox.exec('print(x)')
      expect(r2.stdout.trim()).toBe('99')
    } finally {
      await sandbox.dispose()
    }
  })

  test('handles multiple instances', async () => {
    const [a, b] = await Promise.all([
      PythonSandbox.spawn({ python: 'python3', execTimeoutS: 10, initTimeoutMs: 10_000 }),
      PythonSandbox.spawn({ python: 'python3', execTimeoutS: 10, initTimeoutMs: 10_000 }),
    ])
    await a.exec('v = 1')
    await b.exec('v = 2')
    const ra = await a.exec('print(v)')
    const rb = await b.exec('print(v)')
    expect(ra.stdout.trim()).toBe('1')
    expect(rb.stdout.trim()).toBe('2')
    await Promise.all([a.dispose(), b.dispose()])
  })
})
