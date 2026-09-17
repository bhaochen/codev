import { describe, test, expect } from 'bun:test'
import {
  anthropicBlockToAgent,
  agentBlockToAnthropic,
  anthropicMessageToAgent,
  agentMessageToAnthropic,
  anthropicUsageToAgent,
} from './anthropicAdapter'
import {
  createTextBlock,
  createImageBlock,
  createToolUseBlock,
  createToolResultBlock,
  createThinkingBlock,
  createUserMessage,
  createAssistantMessage,
  type AgentTextBlock,
  type AgentImageBlock,
  type AgentToolUseBlock,
  type AgentToolResultBlock,
} from './agentMessage'
import type {
  ContentBlockParam,
  TextBlockParam,
  ImageBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
  MessageParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'

// ============================================================================
// Content Block Conversion: Anthropic → Agent
// ============================================================================

describe('anthropicBlockToAgent', () => {
  test('converts TextBlockParam to AgentTextBlock', () => {
    const anthropic: TextBlockParam = { type: 'text', text: 'Hello' }
    const agent = anthropicBlockToAgent(anthropic)
    expect(agent).toEqual({ type: 'text', text: 'Hello' })
  })

  test('converts TextBlockParam with cache_control', () => {
    const anthropic: TextBlockParam = {
      type: 'text',
      text: 'Hello',
      cache_control: { type: 'ephemeral' },
    }
    const agent = anthropicBlockToAgent(anthropic)
    expect(agent).toEqual({
      type: 'text',
      text: 'Hello',
      providerOptions: {
        cache_control: { type: 'ephemeral' },
      },
    })
  })

  test('converts ImageBlockParam to AgentImageBlock', () => {
    const anthropic: ImageBlockParam = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'base64data' },
    }
    const agent = anthropicBlockToAgent(anthropic)
    expect(agent).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'base64data' },
    })
  })

  test('converts ToolUseBlockParam to AgentToolUseBlock', () => {
    const anthropic: ToolUseBlockParam = {
      type: 'tool_use',
      id: 'tool_123',
      name: 'bash',
      input: { command: 'ls' },
    }
    const agent = anthropicBlockToAgent(anthropic)
    expect(agent).toEqual({
      type: 'tool_use',
      id: 'tool_123',
      name: 'bash',
      input: { command: 'ls' },
    })
  })

  test('converts ToolResultBlockParam to AgentToolResultBlock', () => {
    const anthropic: ToolResultBlockParam = {
      type: 'tool_result',
      tool_use_id: 'tool_123',
      content: 'output',
      is_error: false,
    }
    const agent = anthropicBlockToAgent(anthropic)
    expect(agent).toEqual({
      type: 'tool_result',
      tool_use_id: 'tool_123',
      content: 'output',
      is_error: false,
    })
  })

  test('converts ThinkingBlockParam to AgentThinkingBlock', () => {
    const anthropic: ContentBlockParam = {
      type: 'thinking',
      thinking: 'Thinking...',
      signature: 'sig_123',
    }
    const agent = anthropicBlockToAgent(anthropic)
    expect(agent).toEqual({
      type: 'thinking',
      thinking: 'Thinking...',
      signature: 'sig_123',
    })
  })
})

// ============================================================================
// Content Block Conversion: Agent → Anthropic
// ============================================================================

describe('agentBlockToAnthropic', () => {
  test('converts AgentTextBlock to TextBlockParam', () => {
    const agent = createTextBlock('Hello')
    const anthropic = agentBlockToAnthropic(agent)
    expect(anthropic).toEqual({ type: 'text', text: 'Hello' })
  })

  test('converts AgentTextBlock with providerOptions', () => {
    const agent: AgentTextBlock & { providerOptions?: Record<string, unknown> } = {
      type: 'text',
      text: 'Hello',
      providerOptions: {
        cache_control: { type: 'ephemeral' },
      },
    }
    const anthropic = agentBlockToAnthropic(agent)
    expect(anthropic).toEqual({
      type: 'text',
      text: 'Hello',
      cache_control: { type: 'ephemeral' },
    })
  })

  test('converts AgentImageBlock to ImageBlockParam', () => {
    const agent = createImageBlock('image/png', 'base64data')
    const anthropic = agentBlockToAnthropic(agent)
    expect(anthropic).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'base64data' },
    })
  })

  test('converts AgentToolUseBlock to ToolUseBlockParam', () => {
    const agent = createToolUseBlock('tool_123', 'bash', { command: 'ls' })
    const anthropic = agentBlockToAnthropic(agent)
    expect(anthropic).toEqual({
      type: 'tool_use',
      id: 'tool_123',
      name: 'bash',
      input: { command: 'ls' },
    })
  })

  test('converts AgentToolResultBlock to ToolResultBlockParam', () => {
    const agent = createToolResultBlock('tool_123', 'output', false)
    const anthropic = agentBlockToAnthropic(agent)
    expect(anthropic).toEqual({
      type: 'tool_result',
      tool_use_id: 'tool_123',
      content: 'output',
      is_error: false,
    })
  })

  test('converts AgentThinkingBlock to ThinkingBlockParam', () => {
    const agent = createThinkingBlock('Thinking...', 'sig_123')
    const anthropic = agentBlockToAnthropic(agent)
    expect(anthropic).toEqual({
      type: 'thinking',
      thinking: 'Thinking...',
      signature: 'sig_123',
    })
  })
})

// ============================================================================
// Round-trip Conversion Tests
// ============================================================================

describe('round-trip conversion (Anthropic → Agent → Anthropic)', () => {
  test('text block round-trip preserves content', () => {
    const original: TextBlockParam = { type: 'text', text: 'Hello world' }
    const agent = anthropicBlockToAgent(original)
    const backToAnthropic = agentBlockToAnthropic(agent)
    expect(backToAnthropic).toEqual(original)
  })

  test('tool use block round-trip preserves content', () => {
    const original: ToolUseBlockParam = {
      type: 'tool_use',
      id: 'tool_1',
      name: 'read',
      input: { path: '/test.txt' },
    }
    const agent = anthropicBlockToAgent(original)
    const backToAnthropic = agentBlockToAnthropic(agent)
    expect(backToAnthropic).toEqual(original)
  })

  test('tool result block round-trip preserves content', () => {
    const original: ToolResultBlockParam = {
      type: 'tool_result',
      tool_use_id: 'tool_1',
      content: 'File content here',
      is_error: false,
    }
    const agent = anthropicBlockToAgent(original)
    const backToAnthropic = agentBlockToAnthropic(agent)
    expect(backToAnthropic).toEqual(original)
  })
})

// ============================================================================
// Message Conversion Tests
// ============================================================================

describe('message conversion', () => {
  const testUuid = '123e4567-e89b-12d3-a456-426614174000'
  const testTimestamp = 1694868000000

  test('converts Anthropic user message to AgentMessage', () => {
    const anthropic: MessageParam = {
      role: 'user',
      content: 'Hello',
    }
    const agent = anthropicMessageToAgent(anthropic, testUuid, testTimestamp)
    expect(agent).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'Hello' }],
      uuid: testUuid,
      timestamp: testTimestamp,
    })
  })

  test('converts Anthropic assistant message to AgentMessage', () => {
    const anthropic: MessageParam = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Response' },
        { type: 'tool_use', id: 'tool_1', name: 'bash', input: {} },
      ],
    }
    const agent = anthropicMessageToAgent(anthropic, testUuid, testTimestamp)
    expect(agent).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'Response' },
        { type: 'tool_use', id: 'tool_1', name: 'bash', input: {} },
      ],
      uuid: testUuid,
      timestamp: testTimestamp,
    })
  })

  test('converts AgentMessage to Anthropic MessageParam', () => {
    const agent = createUserMessage(
      [createTextBlock('Hello'), createToolUseBlock('tool_1', 'read', {})],
      testUuid,
      testTimestamp,
    )
    const anthropic = agentMessageToAnthropic(agent)
    expect(anthropic).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', id: 'tool_1', name: 'read', input: {} },
      ],
    })
  })
})

// ============================================================================
// Usage Conversion Tests
// ============================================================================

describe('usage conversion', () => {
  test('converts Anthropic usage to AgentUsage', () => {
    const anthropic = {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
    }
    const agent = anthropicUsageToAgent(anthropic)
    expect(agent).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
    })
  })

  test('converts Anthropic usage without cache tokens', () => {
    const anthropic = {
      input_tokens: 100,
      output_tokens: 50,
    }
    const agent = anthropicUsageToAgent(anthropic)
    expect(agent).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: undefined,
    })
  })
})
