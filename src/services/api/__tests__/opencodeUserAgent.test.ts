import { describe, expect, it } from 'bun:test'
import {
  createOpencodeId,
  createSessionId,
  createRequestId,
  OPENCODE_SESSION_RE,
  normalizeToolsForZen,
  aliasHistoryToolCalls,
  restoreToolNames,
  FINGERPRINT_TOOL_DEFINITIONS,
  CORE_TOOLS,
} from '../opencodeUserAgent.js'

describe('OpenCode ID Format', () => {
  it('generates session IDs matching canonical format (ses_ + 12 hex + 14 base62)', () => {
    for (let i = 0; i < 20; i++) {
      const id = createSessionId()
      expect(id).toMatch(OPENCODE_SESSION_RE)
      expect(id).toHaveLength(30)
    }
  })

  it('generates request IDs matching canonical format (msg_ + 12 hex + 14 base62)', () => {
    for (let i = 0; i < 20; i++) {
      const id = createRequestId()
      expect(id).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
      expect(id).toHaveLength(30)
    }
  })

  it('backward-compatible createOpencodeId works for both prefixes', () => {
    const ses = createOpencodeId('ses')
    expect(ses).toMatch(OPENCODE_SESSION_RE)
    const msg = createOpencodeId('msg')
    expect(msg).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  })
})

describe('normalizeToolsForZen', () => {
  it('appends read/shell fingerprint tools when missing', () => {
    const body = { tools: [{ type: 'function', name: 'Edit', description: 'Edit a file', parameters: { type: 'object', properties: {} } }] }
    const result = normalizeToolsForZen(body, 'chat')
    const names = (body.tools as any[]).map((t) => t.function?.name ?? t.name)
    expect(names).toContain('Edit')
    expect(names).toContain('read')
    expect(names).toContain('shell')
    expect(result.appended).toEqual(['read', 'shell'])
    expect(result.aliasMap.size).toBe(0)
  })

  it('aliases a caller tool named read with a different definition', () => {
    const body = {
      tools: [
        { type: 'function', function: { name: 'read', description: 'Custom read tool', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'Edit', description: 'Edit a file', parameters: { type: 'object', properties: {} } } },
      ],
    }
    const result = normalizeToolsForZen(body, 'chat')
    const names = (body.tools as any[]).map((t) => t.function?.name ?? t.name)
    expect(names).toContain('read_client')
    expect(names).toContain('Edit')
    expect(names).toContain('read')
    expect(names).toContain('shell')
    expect(result.aliasMap.get('read_client')).toBe('read')
    expect(result.appended).toEqual(['read', 'shell'])
  })

  it('aliases a caller tool named shell with a different definition', () => {
    const body = {
      tools: [
        { type: 'function', function: { name: 'shell', description: 'Custom shell tool', parameters: { type: 'object', properties: {} } } },
      ],
    }
    const result = normalizeToolsForZen(body, 'chat')
    const names = (body.tools as any[]).map((t) => t.function?.name ?? t.name)
    expect(names).toContain('shell_client')
    expect(names).toContain('read')
    expect(names).toContain('shell')
    expect(result.aliasMap.get('shell_client')).toBe('shell')
  })

  it('does not alias case variants like Read/Bash (upstream accepts them)', () => {
    const body = {
      tools: [
        { type: 'function', function: { name: 'Read', description: 'Claude Code read', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'Bash', description: 'Claude Code bash', parameters: { type: 'object', properties: {} } } },
      ],
    }
    const result = normalizeToolsForZen(body, 'chat')
    const names = (body.tools as any[]).map((t) => t.function?.name ?? t.name)
    expect(names).toContain('Read')
    expect(names).toContain('Bash')
    expect(names).toContain('read')
    expect(names).toContain('shell')
    expect(result.aliasMap.size).toBe(0)
  })

  it('keeps a caller tool that already has the exact fingerprint definition', () => {
    const readDef = FINGERPRINT_TOOL_DEFINITIONS.read
    const body = {
      tools: [
        { type: 'function', function: { name: 'read', description: readDef.description, parameters: readDef.parameters } },
      ],
    }
    const result = normalizeToolsForZen(body, 'chat')
    const names = (body.tools as any[]).map((t) => t.function?.name ?? t.name)
    expect(names).toEqual(['read', 'shell'])
    expect(result.aliasMap.size).toBe(0)
    expect(result.appended).toEqual(['shell'])
  })
})

describe('aliasHistoryToolCalls', () => {
  it('renames prior-turn tool_calls in messages to use aliases', () => {
    const aliasMap = new Map([['read_client', 'read']])
    const body = {
      messages: [
        { role: 'assistant', tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      ],
    }
    aliasHistoryToolCalls(body, aliasMap)
    const msg = (body.messages as any[])[0]
    expect(msg.tool_calls[0].function.name).toBe('read_client')
  })

  it('renames function_call items in input to use aliases', () => {
    const aliasMap = new Map([['shell_client', 'shell']])
    const body = {
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'function_call', call_id: '1', name: 'shell', arguments: '{}' },
        { type: 'function_call_output', call_id: '1', output: 'done' },
      ],
    }
    aliasHistoryToolCalls(body, aliasMap)
    const input = body.input as any[]
    expect(input[1].name).toBe('shell_client')
  })
})

describe('restoreToolNames', () => {
  it('restores aliased tool names in response tool_calls', () => {
    const aliasMap = new Map([['read_client', 'read']])
    const body = {
      messages: [
        { role: 'assistant', tool_calls: [{ id: '1', type: 'function', function: { name: 'read_client', arguments: '{}' } }] },
      ],
    }
    restoreToolNames(body, aliasMap)
    const msg = (body.messages as any[])[0]
    expect(msg.tool_calls[0].function.name).toBe('read')
  })

  it('restores aliased function_call items in input', () => {
    const aliasMap = new Map([['shell_client', 'shell']])
    const body = {
      input: [
        { type: 'function_call', call_id: '1', name: 'shell_client', arguments: '{}' },
      ],
    }
    restoreToolNames(body, aliasMap)
    const input = body.input as any[]
    expect(input[0].name).toBe('shell')
  })

  it('does nothing when aliasMap is empty', () => {
    const body = { messages: [{ role: 'assistant', tool_calls: [{ id: '1', type: 'function', function: { name: 'read', arguments: '{}' } }] }] }
    restoreToolNames(body, new Map())
    const msg = (body.messages as any[])[0]
    expect(msg.tool_calls[0].function.name).toBe('read')
  })
})
