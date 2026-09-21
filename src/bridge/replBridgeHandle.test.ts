import { beforeEach, describe, expect, test } from 'bun:test'
import type { ReplBridgeHandle } from './replBridge.js'
import {
  getReplBridgeHandle,
  isReplBridgeActive,
  setReplBridgeHandle,
} from './replBridgeHandle.js'

function fakeHandle(): ReplBridgeHandle {
  return {
    bridgeSessionId: 'session_test',
    environmentId: 'env_test',
    sessionIngressUrl: 'https://example.test',
    writeMessages() {},
    writeSdkMessages() {},
    sendControlRequest() {},
    sendControlResponse() {},
    sendControlCancelRequest() {},
    sendResult() {},
    teardown: async () => {},
  }
}

beforeEach(() => {
  setReplBridgeHandle(null)
})

describe('isReplBridgeActive', () => {
  test('is false when no bridge handle is set', () => {
    expect(getReplBridgeHandle()).toBeNull()
    expect(isReplBridgeActive()).toBe(false)
  })

  test('is true for an inbound-capable bridge', () => {
    setReplBridgeHandle(fakeHandle())
    expect(isReplBridgeActive()).toBe(true)
  })

  test('is false for an outbound-only bridge', () => {
    setReplBridgeHandle(fakeHandle(), true)
    expect(isReplBridgeActive()).toBe(false)
  })

  test('resets outbound-only state on teardown', () => {
    setReplBridgeHandle(fakeHandle(), true)
    setReplBridgeHandle(fakeHandle())
    expect(isReplBridgeActive()).toBe(true)
  })
})
