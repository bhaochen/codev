import { describe, expect, test } from 'bun:test'
import { shouldRenderStatically } from '../Messages.js'
import { areMessagePropsEqual } from '../Message.js'
import type { Props as MessageProps } from '../Message.js'
import type { RenderableMessage } from '../../types/message.js'

// system 分支不触碰 lookups，传占位即可
const lookups = undefined as unknown as Parameters<
  typeof shouldRenderStatically
>[5]
const emptyIDs = new Set<string>()

function sysMessage(subtype: string): RenderableMessage {
  return {
    type: 'system',
    subtype,
    uuid: 'u',
    timestamp: 0,
  } as unknown as RenderableMessage
}

describe('shouldRenderStatically — system messages', () => {
  test('local_command renders dynamically (in-place transcript updates)', () => {
    // /benchmark 等本地命令的输出经 setMessages 原地更新 content，
    // 若被判为 static，Message memo 会永久跳过重渲染（areMessagePropsEqual
    // 对 prev/next 均 isStatic 时直接 return true），live 进度永不显示。
    expect(
      shouldRenderStatically(
        sysMessage('local_command'),
        emptyIDs,
        emptyIDs,
        emptyIDs,
        'prompt',
        lookups,
      ),
    ).toBe(false)
  })

  test('api_error renders dynamically', () => {
    expect(
      shouldRenderStatically(
        sysMessage('api_error'),
        emptyIDs,
        emptyIDs,
        emptyIDs,
        'prompt',
        lookups,
      ),
    ).toBe(false)
  })

  test('other system subtypes stay static', () => {
    expect(
      shouldRenderStatically(
        sysMessage('compact_boundary'),
        emptyIDs,
        emptyIDs,
        emptyIDs,
        'prompt',
        lookups,
      ),
    ).toBe(true)
  })

  test('transcript screen is always static', () => {
    expect(
      shouldRenderStatically(
        sysMessage('local_command'),
        emptyIDs,
        emptyIDs,
        emptyIDs,
        'transcript',
        lookups,
      ),
    ).toBe(true)
  })
})

describe('areMessagePropsEqual — local_command in-place updates', () => {
  function messageProps(isStatic: boolean, content: string): MessageProps {
    return {
      message: {
        type: 'system',
        subtype: 'local_command',
        content,
        uuid: 'u',
        timestamp: 0,
        level: 'info',
        isMeta: false,
      } as unknown as MessageProps['message'],
      lookups: undefined as unknown as MessageProps['lookups'],
      addMargin: true,
      tools: undefined as unknown as MessageProps['tools'],
      commands: [],
      verbose: false,
      inProgressToolUseIDs: new Set<string>(),
      progressMessagesForMessage: [],
      shouldAnimate: false,
      shouldShowDot: true,
      isTranscriptMode: false,
      isStatic,
    }
  }

  test('non-static: content change must re-render', () => {
    expect(areMessagePropsEqual(messageProps(false, 'old'), messageProps(false, 'new'))).toBe(false)
  })

  test('static: content change is skipped — root-cause contract', () => {
    // 若 local_command 被判为 static，此处返回 true → live 进度永不显示。
    // 这是 must-fail：任何把 local_command 加回 static 的改动都会让本测试报警。
    expect(areMessagePropsEqual(messageProps(true, 'old'), messageProps(true, 'new'))).toBe(true)
  })
})
