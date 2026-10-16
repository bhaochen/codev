/**
 * QuotaManager — atomic reserve/settle semantics.
 *
 * Regression context: the backing map was declared as `usage` while every
 * method accessed `this.used`, so the first checkQuota()/reserve() call would
 * have thrown `TypeError: Cannot read properties of undefined`. These tests
 * pin the fixed, consistent field and the reserve/settle arithmetic.
 */
import { describe, expect, test } from 'bun:test'
import { QuotaManager } from './QuotaManager.js'

describe('QuotaManager', () => {
  test('unlimited when no limit is set', () => {
    const qm = new QuotaManager()
    const status = qm.checkQuota('firstParty', 'test-model', 100)
    expect(status.remaining).toBe(Number.MAX_SAFE_INTEGER)
    expect(status.isEstimate).toBe(true)
  })

  test('checkQuota reflects remaining quota', () => {
    const qm = new QuotaManager()
    qm.setLimit('firstParty', 'test-model', 1000, 60_000)
    const status = qm.checkQuota('firstParty', 'test-model', 100)
    expect(status.limit).toBe(1000)
    expect(status.remaining).toBe(1000)
  })

  test('reserve consumes quota and rejects when exceeded', () => {
    const qm = new QuotaManager()
    qm.setLimit('firstParty', 'test-model', 1000, 60_000)

    const r1 = qm.reserve('firstParty', 'test-model', 600)
    expect(r1).not.toBeNull()

    const status = qm.checkQuota('firstParty', 'test-model', 100)
    expect(status.remaining).toBe(400)

    // 400 remaining, asking for 700 — must be rejected
    expect(qm.reserve('firstParty', 'test-model', 700)).toBeNull()
  })

  test('settle replaces the estimate with the actual usage', () => {
    const qm = new QuotaManager()
    qm.setLimit('firstParty', 'test-model', 1000, 60_000)

    const r = qm.reserve('firstParty', 'test-model', 600)
    expect(r).not.toBeNull()

    // Only 200 actually used — 400 of the estimate is released
    qm.settle(r!.id, 200)
    expect(qm.checkQuota('firstParty', 'test-model', 0).remaining).toBe(800)
  })

  test('release gives the full estimate back', () => {
    const qm = new QuotaManager()
    qm.setLimit('firstParty', 'test-model', 1000, 60_000)

    const r = qm.reserve('firstParty', 'test-model', 600)
    qm.release(r!.id)
    expect(qm.checkQuota('firstParty', 'test-model', 0).remaining).toBe(1000)
  })

  test('updateFromProvider sets used from the reported remaining', () => {
    const qm = new QuotaManager()
    qm.setLimit('firstParty', 'test-model', 1000, 60_000)
    qm.updateFromProvider('firstParty', 'test-model', 300, Date.now() + 60_000)
    expect(qm.checkQuota('firstParty', 'test-model', 0).remaining).toBe(300)
  })
})
