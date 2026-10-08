import { describe, expect, test } from 'bun:test'
import {
  isToolInputValidationError,
  TOOL_INPUT_VALIDATION_ERROR_PREFIX,
} from './toolValidationError.js'

describe('isToolInputValidationError', () => {
  test('matches the wrapped form toolExecution emits', () => {
    expect(
      isToolInputValidationError(
        `<tool_use_error>${TOOL_INPUT_VALIDATION_ERROR_PREFIX}bad args</tool_use_error>`,
      ),
    ).toBe(true)
  })

  test('matches the bare form', () => {
    expect(
      isToolInputValidationError(`${TOOL_INPUT_VALIDATION_ERROR_PREFIX}bad args`),
    ).toBe(true)
  })

  test('matches a text-block array', () => {
    expect(
      isToolInputValidationError([
        { type: 'text', text: `${TOOL_INPUT_VALIDATION_ERROR_PREFIX}bad` },
      ] as never),
    ).toBe(true)
  })

  test('does not match when the phrase is quoted mid-message', () => {
    expect(
      isToolInputValidationError(
        `the server replied: ${TOOL_INPUT_VALIDATION_ERROR_PREFIX}not really`,
      ),
    ).toBe(false)
  })

  test('is false for empty or unrelated content', () => {
    expect(isToolInputValidationError('')).toBe(false)
    expect(isToolInputValidationError('boom')).toBe(false)
    expect(isToolInputValidationError(undefined)).toBe(false)
  })
})
