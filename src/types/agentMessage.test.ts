import { describe, test, expect } from 'bun:test'
import {
  createTextBlock,
  createImageBlock,
  createToolUseBlock,
  createToolResultBlock,
  createThinkingBlock,
  createUserMessage,
  createAssistantMessage,
  createSystemMessage,
  isUserMessage,
  isAssistantMessage,
  isSystemMessage,
  isTextBlock,
  isImageBlock,
  isToolUseBlock,
  isToolResultBlock,
  isThinkingBlock,
  type AgentContentBlock,
  type AgentMessage,
  type AgentUserMessage,
  type AgentAssistantMessage,
  type AgentSystemMessage,
} from './agentMessage'

// ============================================================================
// Content Block Creation Tests
// ============================================================================

describe('AgentMessage content block creation', () => {
  test('createTextBlock creates text content block', () => {
    const block = createTextBlock('Hello, world!')
    expect(block).toEqual({ type: 'text', text: 'Hello, world!' })
  })

  test('createImageBlock creates image content block', () => {
    const block = createImageBlock('image/png', 'base64data')
    expect(block).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: 'base64data',
      },
    })
  })

  test('createToolUseBlock creates tool use content block', () => {
    const input = { command: 'ls -la' }
    const block = createToolUseBlock('tool_123', 'bash', input)
    expect(block).toEqual({
      type: 'tool_use',
      id: 'tool_123',
      name: 'bash',
      input: { command: 'ls -la' },
    })
  })

  test('createToolResultBlock creates tool result content block', () => {
    const block = createToolResultBlock('tool_123', 'output text', false)
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'tool_123',
      content: 'output text',
      is_error: false,
    })
  })

  test('createToolResultBlock creates error tool result', () => {
    const block = createToolResultBlock('tool_123', 'error message', true)
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'tool_123',
      content: 'error message',
      is_error: true,
    })
  })

  test('createToolResultBlock with complex content', () => {
    const complexContent: AgentContentBlock[] = [
      createTextBlock('Output:'),
      createImageBlock('image/png', 'data'),
    ]
    const block = createToolResultBlock('tool_123', complexContent)
    expect(block).toEqual({
      type: 'tool_result',
      tool_use_id: 'tool_123',
      content: complexContent,
    })
  })

  test('createThinkingBlock creates thinking content block', () => {
    const block = createThinkingBlock('Thinking process...', 'sig_123')
    expect(block).toEqual({
      type: 'thinking',
      thinking: 'Thinking process...',
      signature: 'sig_123',
    })
  })

  test('createThinkingBlock without signature', () => {
    const block = createThinkingBlock('Thinking process...')
    expect(block).toEqual({
      type: 'thinking',
      thinking: 'Thinking process...',
      signature: undefined,
    })
  })
})

// ============================================================================
// Message Creation Tests
// ============================================================================

describe('AgentMessage creation', () => {
  const testUuid = '123e4567-e89b-12d3-a456-426614174000'
  const testTimestamp = 1694868000000

  test('createUserMessage creates user message', () => {
    const content = [createTextBlock('Hello')]
    const message = createUserMessage(content, testUuid, testTimestamp)
    expect(message).toEqual({
      role: 'user',
      content,
      uuid: testUuid,
      timestamp: testTimestamp,
      isMeta: undefined,
      isVirtual: undefined,
    })
  })

  test('createUserMessage with meta and virtual options', () => {
    const content = [createTextBlock('Hello')]
    const message = createUserMessage(content, testUuid, testTimestamp, {
      isMeta: true,
      isVirtual: true,
    })
    expect(message).toEqual({
      role: 'user',
      content,
      uuid: testUuid,
      timestamp: testTimestamp,
      isMeta: true,
      isVirtual: true,
    })
  })

  test('createAssistantMessage creates assistant message', () => {
    const content = [createTextBlock('Response')]
    const message = createAssistantMessage(content, testUuid, testTimestamp)
    expect(message).toEqual({
      role: 'assistant',
      content,
      uuid: testUuid,
      timestamp: testTimestamp,
      model: undefined,
      stop_reason: undefined,
      usage: undefined,
    })
  })

  test('createAssistantMessage with model and usage', () => {
    const content = [createTextBlock('Response')]
    const usage = { input_tokens: 100, output_tokens: 50 }
    const message = createAssistantMessage(content, testUuid, testTimestamp, {
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
      usage,
    })
    expect(message).toEqual({
      role: 'assistant',
      content,
      uuid: testUuid,
      timestamp: testTimestamp,
      model: 'claude-opus-4-6',
      stop_reason: 'end_turn',
      usage: { input_tokens: 100, output_tokens: 50 },
    })
  })

  test('createSystemMessage creates system message', () => {
    const content = [createTextBlock('System instruction')]
    const message = createSystemMessage(content, testUuid, testTimestamp)
    expect(message).toEqual({
      role: 'system',
      content,
      uuid: testUuid,
      timestamp: testTimestamp,
    })
  })
})

// ============================================================================
// Type Guard Tests
// ============================================================================

describe('AgentMessage type guards', () => {
  const testUuid = '123e4567-e89b-12d3-a456-426614174000'
  const testTimestamp = 1694868000000

  test('isUserMessage correctly identifies user messages', () => {
    const userMsg = createUserMessage([createTextBlock('Hello')], testUuid, testTimestamp)
    const assistantMsg = createAssistantMessage([createTextBlock('Hi')], testUuid, testTimestamp)
    const systemMsg = createSystemMessage([createTextBlock('System')], testUuid, testTimestamp)

    expect(isUserMessage(userMsg)).toBe(true)
    expect(isUserMessage(assistantMsg)).toBe(false)
    expect(isUserMessage(systemMsg)).toBe(false)
  })

  test('isAssistantMessage correctly identifies assistant messages', () => {
    const userMsg = createUserMessage([createTextBlock('Hello')], testUuid, testTimestamp)
    const assistantMsg = createAssistantMessage([createTextBlock('Hi')], testUuid, testTimestamp)
    const systemMsg = createSystemMessage([createTextBlock('System')], testUuid, testTimestamp)

    expect(isAssistantMessage(userMsg)).toBe(false)
    expect(isAssistantMessage(assistantMsg)).toBe(true)
    expect(isAssistantMessage(systemMsg)).toBe(false)
  })

  test('isSystemMessage correctly identifies system messages', () => {
    const userMsg = createUserMessage([createTextBlock('Hello')], testUuid, testTimestamp)
    const assistantMsg = createAssistantMessage([createTextBlock('Hi')], testUuid, testTimestamp)
    const systemMsg = createSystemMessage([createTextBlock('System')], testUuid, testTimestamp)

    expect(isSystemMessage(userMsg)).toBe(false)
    expect(isSystemMessage(assistantMsg)).toBe(false)
    expect(isSystemMessage(systemMsg)).toBe(true)
  })
})

// ============================================================================
// Content Block Type Guard Tests
// ============================================================================

describe('AgentMessage content block type guards', () => {
  test('isTextBlock correctly identifies text blocks', () => {
    const textBlock = createTextBlock('Hello')
    const imageBlock = createImageBlock('image/png', 'data')
    const toolUseBlock = createToolUseBlock('id', 'name', {})

    expect(isTextBlock(textBlock)).toBe(true)
    expect(isTextBlock(imageBlock)).toBe(false)
    expect(isTextBlock(toolUseBlock)).toBe(false)
  })

  test('isImageBlock correctly identifies image blocks', () => {
    const textBlock = createTextBlock('Hello')
    const imageBlock = createImageBlock('image/png', 'data')

    expect(isImageBlock(textBlock)).toBe(false)
    expect(isImageBlock(imageBlock)).toBe(true)
  })

  test('isToolUseBlock correctly identifies tool use blocks', () => {
    const textBlock = createTextBlock('Hello')
    const toolUseBlock = createToolUseBlock('id', 'name', {})
    const toolResultBlock = createToolResultBlock('id', 'result')

    expect(isToolUseBlock(textBlock)).toBe(false)
    expect(isToolUseBlock(toolUseBlock)).toBe(true)
    expect(isToolUseBlock(toolResultBlock)).toBe(false)
  })

  test('isToolResultBlock correctly identifies tool result blocks', () => {
    const textBlock = createTextBlock('Hello')
    const toolUseBlock = createToolUseBlock('id', 'name', {})
    const toolResultBlock = createToolResultBlock('id', 'result')

    expect(isToolResultBlock(textBlock)).toBe(false)
    expect(isToolResultBlock(toolUseBlock)).toBe(false)
    expect(isToolResultBlock(toolResultBlock)).toBe(true)
  })

  test('isThinkingBlock correctly identifies thinking blocks', () => {
    const textBlock = createTextBlock('Hello')
    const thinkingBlock = createThinkingBlock('Thinking...')

    expect(isThinkingBlock(textBlock)).toBe(false)
    expect(isThinkingBlock(thinkingBlock)).toBe(true)
  })
})

// ============================================================================
// Complex Message Composition Tests
// ============================================================================

describe('AgentMessage complex composition', () => {
  const testUuid = '123e4567-e89b-12d3-a456-426614174000'
  const testTimestamp = 1694868000000

  test('assistant message with multiple content blocks', () => {
    const content: AgentContentBlock[] = [
      createThinkingBlock('I need to check the file'),
      createToolUseBlock('tool_1', 'read', { path: '/test.txt' }),
      createTextBlock('Let me read the file...'),
    ]
    const message = createAssistantMessage(content, testUuid, testTimestamp)
    expect(message.content).toHaveLength(3)
    expect(message.content[0]!.type).toBe('thinking')
    expect(message.content[1]!.type).toBe('tool_use')
    expect(message.content[2]!.type).toBe('text')
  })

  test('user message with tool result', () => {
    const content: AgentContentBlock[] = [
      createToolResultBlock('tool_1', 'File content here'),
      createTextBlock('What do you think about this?'),
    ]
    const message = createUserMessage(content, testUuid, testTimestamp)
    expect(message.content).toHaveLength(2)
    expect(message.content[0]!.type).toBe('tool_result')
    expect(message.content[1]!.type).toBe('text')
  })

  test('complete agent conversation flow', () => {
    // User message
    const userMsg = createUserMessage(
      [createTextBlock('Read the file')],
      testUuid,
      testTimestamp,
    )

    // Assistant response with tool use
    const assistantMsg = createAssistantMessage(
      [createToolUseBlock('tool_1', 'read', { path: '/test.txt' })],
      testUuid,
      testTimestamp + 1000,
      { model: 'claude-opus-4-6' },
    )

    // User with tool result
    const userMsg2 = createUserMessage(
      [createToolResultBlock('tool_1', 'File content')],
      testUuid,
      testTimestamp + 2000,
    )

    // Final assistant response
    const assistantMsg2 = createAssistantMessage(
      [createTextBlock('The file contains...')],
      testUuid,
      testTimestamp + 3000,
      { stop_reason: 'end_turn', usage: { input_tokens: 200, output_tokens: 50 } },
    )

    const conversation: AgentMessage[] = [
      userMsg,
      assistantMsg,
      userMsg2,
      assistantMsg2,
    ]

    // Verify conversation structure
    expect(conversation).toHaveLength(4)
    expect(isUserMessage(conversation[0]!)).toBe(true)
    expect(isAssistantMessage(conversation[1]!)).toBe(true)
    expect(isUserMessage(conversation[2]!)).toBe(true)
    expect(isAssistantMessage(conversation[3]!)).toBe(true)

    // Verify assistant messages have model info
    const assistant1 = conversation[1] as AgentAssistantMessage
    const assistant2 = conversation[3] as AgentAssistantMessage
    expect(assistant1.model).toBe('claude-opus-4-6')
    expect(assistant2.stop_reason).toBe('end_turn')
    expect(assistant2.usage).toEqual({ input_tokens: 200, output_tokens: 50 })
  })
})
