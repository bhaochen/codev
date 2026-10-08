/**
 * The `edit_block` advertisement: Aider-style SEARCH/REPLACE arguments, offered
 * to models whose `preferredEditFormat` is `edit_block`.
 *
 * The model is shown `{ path, search, replace }` (what its post-training
 * expects) while the real work is done by the existing `Edit` tool:
 *   - {@link applyPreferredEditFormat} swaps the advertised `Edit` schema for
 *     `edit_block` in the request-bound tool list only (execution still holds
 *     `Edit`, so permissions/UI/diagnostics are untouched).
 *   - {@link adaptEditBlockToolUse} maps an incoming `edit_block` tool_use back
 *     to an `Edit` tool_use (`file_path`/`old_string`/`new_string`) before the
 *     call is normalized and dispatched.
 */

import { z } from 'zod/v4'
import { FILE_EDIT_TOOL_NAME } from '../../../tools/FileEditTool/constants.js'
import type { Tool } from '../../../Tool.js'
import { preferredEditFormat } from './editFormat.js'

export const EDIT_BLOCK_TOOL_NAME = 'edit_block'

export const editBlockInputSchema = z.strictObject({
  path: z.string().describe('Path to the file to edit.'),
  search: z
    .string()
    .describe(
      'The exact text to find (the content between <<<<<<< SEARCH and =======). Include 3+ lines of surrounding context when possible so the match is unique.',
    ),
  replace: z
    .string()
    .describe(
      'The replacement text (the content between ======= and >>>>>>> REPLACE).',
    ),
})

const EDIT_BLOCK_DESCRIPTION = `Apply a SEARCH/REPLACE edit to a file.

Use this when your training includes Aider-style edit blocks. Provide the exact text to find in \`search\` (including indentation) and its replacement in \`replace\`. The search text must match exactly; include 3+ lines of surrounding context when possible so the match is unique. Call the tool multiple times for multiple edits.`

/**
 * Advertisement-only tool shape. It is placed in the request's tool list in
 * place of `Edit`; nothing executes it (see the module doc).
 */
export const EditBlockTool = {
  name: EDIT_BLOCK_TOOL_NAME,
  inputSchema: editBlockInputSchema,
  strict: false,
  isEnabled: () => true,
  isReadOnly: () => false,
  async prompt() {
    return EDIT_BLOCK_DESCRIPTION
  },
} as unknown as Tool

/** Swap the advertised `Edit` tool for `edit_block` when the model prefers it. */
export function applyPreferredEditFormat<T extends { name: string }>(
  tools: readonly T[],
  model: string,
): readonly T[] {
  if (preferredEditFormat(model) !== 'edit_block') return tools
  const index = tools.findIndex(tool => tool.name === FILE_EDIT_TOOL_NAME)
  if (index === -1) return tools
  const out = tools.slice()
  out[index] = EditBlockTool as unknown as T
  return out
}

type EditBlockBlock = { name?: unknown; input?: unknown }

/**
 * Map an incoming `edit_block` tool_use to the `Edit` tool_use it stands for.
 * Returns null for any other tool (or an unrecognizable body), so callers can
 * pass every block through unconditionally.
 */
export function adaptEditBlockToolUse(block: EditBlockBlock): {
  name: string
  input: { file_path: string; old_string: string; new_string: string }
} | null {
  if (block.name !== EDIT_BLOCK_TOOL_NAME) return null

  let args: Record<string, unknown>
  if (typeof block.input === 'string') {
    try {
      args = JSON.parse(block.input) as Record<string, unknown>
    } catch {
      return null
    }
  } else if (block.input && typeof block.input === 'object') {
    args = block.input as Record<string, unknown>
  } else {
    return null
  }

  const { path, search, replace } = args
  if (
    typeof path !== 'string' ||
    typeof search !== 'string' ||
    typeof replace !== 'string'
  ) {
    return null
  }

  return {
    name: FILE_EDIT_TOOL_NAME,
    input: { file_path: path, old_string: search, new_string: replace },
  }
}
