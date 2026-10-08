import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { normalizeContentFromAPI } from './messages.js'
import { EDIT_BLOCK_TOOL_NAME } from '../services/llm/protocols/editBlockTool.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'

const editTool = {
  name: FILE_EDIT_TOOL_NAME,
  inputSchema: z.object({
    file_path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
  }),
} as never

describe('normalizeContentFromAPI — edit_block translation', () => {
  test('rewrites an edit_block tool_use into Edit with adapted input', () => {
    const out = normalizeContentFromAPI(
      [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: EDIT_BLOCK_TOOL_NAME,
          input: JSON.stringify({ path: 'a.ts', search: 'old', replace: 'new' }),
        },
      ] as never,
      [editTool],
    )
    expect(out[0]).toMatchObject({
      type: 'tool_use',
      name: FILE_EDIT_TOOL_NAME,
      id: 'toolu_1',
      input: { file_path: 'a.ts', old_string: 'old', new_string: 'new' },
    })
  })

  test('leaves unrelated tool_use blocks unchanged', () => {
    const out = normalizeContentFromAPI(
      [
        {
          type: 'tool_use',
          id: 'toolu_2',
          name: 'Bash',
          input: JSON.stringify({ command: 'ls' }),
        },
      ] as never,
      [editTool],
    )
    expect(out[0]).toMatchObject({ type: 'tool_use', name: 'Bash' })
  })
})
