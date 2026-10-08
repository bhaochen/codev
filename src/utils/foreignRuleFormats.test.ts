import { describe, expect, test } from 'bun:test'
import {
  classifyForeignRule,
  CLINE_DIALECT,
  COPILOT_INSTRUCTIONS_DIALECT,
  CURSOR_DIALECT,
  dialectForPath,
  NATIVE_DIALECT,
  normalizeRulePatterns,
  WINDSURF_DIALECT,
} from './foreignRuleFormats.js'

describe('normalizeRulePatterns', () => {
  test('returns none for empty input', () => {
    expect(normalizeRulePatterns(undefined)).toEqual({ kind: 'none' })
    expect(normalizeRulePatterns('')).toEqual({ kind: 'none' })
  })

  test('strips a trailing /** from each pattern', () => {
    expect(normalizeRulePatterns('src/**')).toEqual({
      kind: 'patterns',
      paths: ['src'],
    })
  })

  test('an all-** set means unconditional', () => {
    expect(normalizeRulePatterns('**')).toEqual({ kind: 'all' })
    expect(normalizeRulePatterns(['**', '**'])).toEqual({ kind: 'all' })
  })

  test('accepts an array of patterns', () => {
    expect(normalizeRulePatterns(['a', 'b/**'])).toEqual({
      kind: 'patterns',
      paths: ['a', 'b'],
    })
  })
})

describe('classifyForeignRule', () => {
  test('native rules keep paths semantics and ignore activation markers', () => {
    expect(classifyForeignRule({ paths: 'src/**' }, NATIVE_DIALECT)).toEqual({
      kind: 'conditional',
      paths: ['src'],
    })
    expect(classifyForeignRule({}, NATIVE_DIALECT)).toEqual({ kind: 'always' })
    // alwaysApply must not promote a native rule (honorsActivationMarkers false)
    expect(classifyForeignRule({ alwaysApply: true }, NATIVE_DIALECT)).toEqual({
      kind: 'always',
    })
  })

  test('cursor: alwaysApply wins, globs scope, unscoped is dormant', () => {
    expect(classifyForeignRule({ alwaysApply: true }, CURSOR_DIALECT)).toEqual({
      kind: 'always',
    })
    expect(classifyForeignRule({ globs: 'src/**' }, CURSOR_DIALECT)).toEqual({
      kind: 'conditional',
      paths: ['src'],
    })
    expect(classifyForeignRule({}, CURSOR_DIALECT).kind).toBe('inert')
  })

  test('copilot: applyTo scopes, unscoped is dormant', () => {
    expect(
      classifyForeignRule({ applyTo: '**' }, COPILOT_INSTRUCTIONS_DIALECT),
    ).toEqual({ kind: 'always' })
    expect(
      classifyForeignRule({ applyTo: 'src/**' }, COPILOT_INSTRUCTIONS_DIALECT),
    ).toEqual({ kind: 'conditional', paths: ['src'] })
    expect(classifyForeignRule({}, COPILOT_INSTRUCTIONS_DIALECT).kind).toBe(
      'inert',
    )
  })

  test('cline: unscoped is always', () => {
    expect(classifyForeignRule({}, CLINE_DIALECT)).toEqual({ kind: 'always' })
  })

  test('windsurf: trigger drives activation', () => {
    expect(
      classifyForeignRule({ trigger: 'always_on' }, WINDSURF_DIALECT),
    ).toEqual({ kind: 'always' })
    expect(classifyForeignRule({ trigger: 'manual' }, WINDSURF_DIALECT).kind).toBe(
      'inert',
    )
    expect(
      classifyForeignRule({ trigger: 'model_decision' }, WINDSURF_DIALECT).kind,
    ).toBe('inert')
    expect(
      classifyForeignRule({ trigger: 'glob' }, WINDSURF_DIALECT).kind,
    ).toBe('inert')
    expect(classifyForeignRule({}, WINDSURF_DIALECT)).toEqual({
      kind: 'always',
    })
  })
})

describe('dialectForPath', () => {
  test('detects each tool by location, native otherwise', () => {
    expect(dialectForPath('.cursor/rules/a.mdc').id).toBe('cursor')
    expect(dialectForPath('.cursor/rules/sub/a.md').id).toBe('cursor')
    expect(
      dialectForPath('.github/instructions/a.instructions.md').id,
    ).toBe('copilot-instructions')
    expect(dialectForPath('.windsurf/rules/a.md').id).toBe('windsurf')
    expect(dialectForPath('.clinerules/a.md').id).toBe('cline')
    expect(dialectForPath('CLAUDE.md').id).toBe('claude')
    expect(dialectForPath('.claude/rules/a.md').id).toBe('claude')
  })

  test('is path-separator agnostic', () => {
    expect(dialectForPath('proj\\.cursor\\rules\\a.mdc').id).toBe('cursor')
  })
})
