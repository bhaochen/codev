import { describe, expect, test } from 'bun:test'
import { hostResolvesToPublicOnly, isPublicAddress } from './utils.js'

describe('isPublicAddress', () => {
  test('allows public IPs', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true)
    expect(isPublicAddress('93.184.216.34')).toBe(true)
    expect(isPublicAddress('2606:4700::1111')).toBe(true)
  })

  test('rejects private, loopback, link-local and reserved ranges', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '172.16.5.4',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      'fe80::1',
    ]) {
      expect(isPublicAddress(ip)).toBe(false)
    }
  })
})

describe('hostResolvesToPublicOnly', () => {
  test('a literal public IP needs no lookup', async () => {
    let called = false
    const ok = await hostResolvesToPublicOnly('1.1.1.1', async () => {
      called = true
      return []
    })
    expect(ok).toBe(true)
    expect(called).toBe(false)
  })

  test('accepts a name whose every address is public', async () => {
    expect(
      await hostResolvesToPublicOnly('example.com', async () => [
        { address: '93.184.216.34' },
        { address: '2606:2800:220:1::1' },
      ]),
    ).toBe(true)
  })

  test('rejects a name resolving to a private address (SSRF)', async () => {
    expect(
      await hostResolvesToPublicOnly('evil.example', async () => [
        { address: '169.254.169.254' },
      ]),
    ).toBe(false)
    expect(
      await hostResolvesToPublicOnly('mixed.example', async () => [
        { address: '93.184.216.34' },
        { address: '10.0.0.5' },
      ]),
    ).toBe(false)
  })

  test('rejects localhost and lookup failure', async () => {
    expect(await hostResolvesToPublicOnly('localhost', async () => [])).toBe(
      false,
    )
    expect(
      await hostResolvesToPublicOnly('boom.example', async () => {
        throw new Error('ENOTFOUND')
      }),
    ).toBe(false)
  })
})
