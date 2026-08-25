import { describe, test, expect } from 'bun:test'
import {
  SpecStore,
  BudgetTracker,
  SpecValue,
  NonSpeculated,
  AbortSpeculationError,
  specKey,
  isSpeculatable,
} from '../speculation.js'

describe('specKey', () => {
  test('produces deterministic hash for same input', () => {
    const k1 = specKey('read', { file_path: '/tmp/a.txt' })
    const k2 = specKey('read', { file_path: '/tmp/a.txt' })
    expect(k1.toolName).toBe('read')
    expect(k1.argsHash).toBe(k2.argsHash)
  })

  test('different inputs produce different hashes', () => {
    const k1 = specKey('read', { file_path: '/tmp/a.txt' })
    const k2 = specKey('read', { file_path: '/tmp/b.txt' })
    expect(k1.argsHash).not.toBe(k2.argsHash)
  })

  test('different tools produce different keys', () => {
    const k1 = specKey('read', { file_path: '/tmp/a.txt' })
    const k2 = specKey('grep', { file_path: '/tmp/a.txt' })
    expect(k1.toolName).not.toBe(k2.toolName)
  })
})

describe('SpecStore', () => {
  test('claim returns null on empty store', () => {
    const store = new SpecStore()
    const key = specKey('read', { file_path: '/tmp/a.txt' })
    expect(store.claim(key)).toBeNull()
  })

  test('dispatch + claim returns SpecValue when ready', async () => {
    const store = new SpecStore()
    const key = specKey('read', { file_path: '/tmp/a.txt' })
    store.dispatch(key, Promise.resolve('file contents'))
    // Wait for promise to resolve
    await new Promise(r => setTimeout(r, 10))
    const hit = store.claim(key)
    expect(hit).not.toBeNull()
    expect(await hit!.force()).toBe('file contents')
  })

  test('claim returns null after already claimed (FIFO)', async () => {
    const store = new SpecStore()
    const key = specKey('read', { file_path: '/tmp/a.txt' })
    store.dispatch(key, Promise.resolve('result1'))
    await new Promise(r => setTimeout(r, 10))
    const hit1 = store.claim(key)
    expect(hit1).not.toBeNull()
    const hit2 = store.claim(key)
    expect(hit2).toBeNull()
  })

  test('multiplicity: N identical dispatches → N claims', async () => {
    const store = new SpecStore()
    const key = specKey('read', { file_path: '/tmp/a.txt' })
    store.dispatch(key, Promise.resolve('r1'))
    store.dispatch(key, Promise.resolve('r2'))
    await new Promise(r => setTimeout(r, 10))
    const hit1 = store.claim(key)
    const hit2 = store.claim(key)
    expect(hit1).not.toBeNull()
    expect(hit2).not.toBeNull()
    expect(await hit1!.force()).toBe('r1')
    expect(await hit2!.force()).toBe('r2')
  })

  test('evict removes pending/running specs', async () => {
    const store = new SpecStore()
    const key = specKey('read', { file_path: '/tmp/a.txt' })
    store.dispatch(key, Promise.resolve('result'))
    const evicted = store.evict(key)
    expect(evicted).toBe(1)
    expect(store.claim(key)).toBeNull()
  })

  test('clear removes all entries', async () => {
    const store = new SpecStore()
    const k1 = specKey('read', { file_path: '/tmp/a.txt' })
    const k2 = specKey('read', { file_path: '/tmp/b.txt' })
    store.dispatch(k1, Promise.resolve('a'))
    store.dispatch(k2, Promise.resolve('b'))
    store.clear()
    expect(store.claim(k1)).toBeNull()
    expect(store.claim(k2)).toBeNull()
  })

  test('inflightCount tracks active specs', async () => {
    const store = new SpecStore()
    const k1 = specKey('read', { file_path: '/tmp/a.txt' })
    const k2 = specKey('read', { file_path: '/tmp/b.txt' })
    expect(store.inflightCount).toBe(0)
    store.dispatch(k1, Promise.resolve('a'))
    expect(store.inflightCount).toBe(1)
    store.dispatch(k2, Promise.resolve('b'))
    expect(store.inflightCount).toBe(2)
    await new Promise(r => setTimeout(r, 10))
    store.claim(k1)
    store.claim(k2)
    expect(store.inflightCount).toBe(0)
  })
})

describe('BudgetTracker', () => {
  test('allows dispatch within budget', () => {
    const store = new SpecStore()
    const budget = new BudgetTracker()
    expect(budget.canDispatch(store)).toBe(true)
    budget.recordDispatch()
    expect(budget.canDispatch(store)).toBe(true)
  })

  test('blocks dispatch when maxDispatchesPerTurn exceeded', () => {
    const store = new SpecStore()
    const budget = new BudgetTracker({ maxDispatchesPerTurn: 2 })
    budget.recordDispatch()
    budget.recordDispatch()
    expect(budget.canDispatch(store)).toBe(false)
  })

  test('blocks dispatch when maxInflight exceeded', async () => {
    const store = new SpecStore()
    const budget = new BudgetTracker({ maxInflight: 1 })
    const key = specKey('read', { file_path: '/tmp/a.txt' })
    store.dispatch(key, new Promise(() => {})) // never resolves → always inflight
    expect(budget.canDispatch(store)).toBe(false)
  })

  test('reset clears turn counters', () => {
    const store = new SpecStore()
    const budget = new BudgetTracker({ maxDispatchesPerTurn: 1 })
    budget.recordDispatch()
    expect(budget.canDispatch(store)).toBe(false)
    budget.reset()
    expect(budget.canDispatch(store)).toBe(true)
  })
})

describe('SpecValue', () => {
  test('force returns value when ready', async () => {
    const store = new SpecStore()
    const key = specKey('read', { file_path: '/tmp/a.txt' })
    const spec = store.dispatch(key, Promise.resolve('hello'))
    const sv = new SpecValue(spec)
    expect(await sv.force()).toBe('hello')
  })

  test('force throws on failed speculation', async () => {
    const store = new SpecStore()
    const key = specKey('read', { file_path: '/tmp/a.txt' })
    const spec = store.dispatch(key, Promise.reject(new Error('boom')))
    const sv = new SpecValue(spec)
    await expect(sv.force()).rejects.toThrow('boom')
  })
})

describe('NonSpeculated', () => {
  test('throws on toString', () => {
    const ns = new NonSpeculated('test reason')
    expect(() => ns.toString()).toThrow(AbortSpeculationError)
    expect(() => ns.toString()).toThrow('speculation aborted: test reason')
  })

  test('throws on valueOf', () => {
    const ns = new NonSpeculated('reason')
    expect(() => ns.valueOf()).toThrow(AbortSpeculationError)
  })

  test('throws on toJSON', () => {
    const ns = new NonSpeculated('reason')
    expect(() => ns.toJSON()).toThrow(AbortSpeculationError)
  })
})

describe('isSpeculatable', () => {
  test('returns true when speculatable and pure', () => {
    expect(isSpeculatable({ speculatable: true, pure: true })).toBe(true)
  })

  test('returns false when not speculatable', () => {
    expect(isSpeculatable({ speculatable: false, pure: true })).toBe(false)
  })

  test('returns false when not pure', () => {
    expect(isSpeculatable({ speculatable: true, pure: false })).toBe(false)
  })

  test('returns false when neither', () => {
    expect(isSpeculatable({})).toBe(false)
  })
})
