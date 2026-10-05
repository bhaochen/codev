import { test as bunTest } from 'bun:test'
/**
 * Safety-brake regression tests for the Browser tool. The brake must catch
 * real payment/deletion/card actions and must NOT nag on benign UI toggles
 * (remove filter, clear search, unlike). Ported alongside the classifier from
 * Bah browser's risk.ts.
 *
 * Run: bun run src/services/browser/riskClassifier.test.ts
 */

import {
  classifyBrowserRisk,
  classifyPressRisk,
} from './riskClassifier.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error: unknown) {
    failed++
    console.log(
      `  FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function assert(cond: boolean, hint: string): void {
  if (!cond) throw new Error(hint)
}

function main(): void {
  console.log('classifyBrowserRisk (clicks):')
  test('flags "Pay now" as payment', () => {
    assert(classifyBrowserRisk('click', 'Pay now')?.kind === 'payment', 'should be payment')
  })
  test('flags "Place order" as payment', () => {
    assert(classifyBrowserRisk('click', 'Place order')?.kind === 'payment', 'should be payment')
  })
  test('flags "Buy now" as payment', () => {
    assert(classifyBrowserRisk('click', 'Buy now')?.kind === 'payment', 'should be payment')
  })
  test('flags Portuguese "Finalizar compra" as payment', () => {
    assert(classifyBrowserRisk('click', 'Finalizar compra')?.kind === 'payment', 'should be payment')
  })
  test('flags "Delete account" as deletion', () => {
    assert(classifyBrowserRisk('click', 'Delete account')?.kind === 'deletion', 'should be deletion')
  })
  test('flags "Delete permanently" as deletion', () => {
    assert(classifyBrowserRisk('click', 'Delete permanently')?.kind === 'deletion', 'should be deletion')
  })

  console.log('classifyBrowserRisk (benign — must NOT prompt):')
  test('"Remove filter" is benign', () => {
    assert(classifyBrowserRisk('click', 'Remove filter') === null, 'should be null')
  })
  test('"Clear search" is benign', () => {
    assert(classifyBrowserRisk('click', 'Clear search') === null, 'should be null')
  })
  test('"Remove like" (social toggle) is benign', () => {
    assert(classifyBrowserRisk('click', 'Remove like') === null, 'should be null')
  })
  test('"Unsubscribe" is benign', () => {
    assert(classifyBrowserRisk('click', 'Unsubscribe') === null, 'should be null')
  })
  test('empty label is null', () => {
    assert(classifyBrowserRisk('click', '') === null, 'should be null')
  })

  console.log('classifyBrowserRisk (fills):')
  test('flags "Card number" fill as card data', () => {
    assert(classifyBrowserRisk('fill', 'Card number')?.kind === 'card data', 'should be card data')
  })
  test('flags "CVV" fill as card data', () => {
    assert(classifyBrowserRisk('fill', 'CVV')?.kind === 'card data', 'should be card data')
  })
  test('normal "Search" fill is null', () => {
    assert(classifyBrowserRisk('fill', 'Search') === null, 'should be null')
  })
  test('payment word in a fill (not card) is null', () => {
    // Filling a field is only risky for card data; "Pay now" as a field label is not.
    assert(classifyBrowserRisk('fill', 'Pay now') === null, 'fills are only card-risky')
  })

  console.log('classifyPressRisk (Enter):')
  test('Enter on a checkout URL is payment', () => {
    assert(classifyPressRisk('enter', 'https://shop.test/checkout')?.kind === 'payment', 'should be payment')
  })
  test('Enter on a cart URL is payment', () => {
    assert(classifyPressRisk('enter', 'https://shop.test/cart')?.kind === 'payment', 'should be payment')
  })
  test('Enter on a normal URL is null', () => {
    assert(classifyPressRisk('enter', 'https://shop.test/products') === null, 'should be null')
  })
  test('Enter with no URL is null', () => {
    assert(classifyPressRisk('enter', undefined) === null, 'should be null')
  })
  test('non-Enter key is null even on checkout', () => {
    assert(classifyPressRisk('tab', 'https://shop.test/checkout') === null, 'should be null')
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) throw new Error(`${failed} browser regression assertion(s) failed`)
}

bunTest('riskClassifier browser service regressions', async () => {
  await main()
})
