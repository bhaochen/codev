/**
 * RLM Tool — Recursive Language Model execution via Python sandbox.
 *
 * The root agent writes a prompt; the tool spawns a Python worker, packs the cwd
 * into `context`, and runs the RLM engine loop: model writes ```repl``` blocks,
 * the sandbox executes them, and the engine terminates on answer or limit.
 *
 * Distinct from the REPLTool (JavaScript VM). RLM mode must be enabled via /rlm.
 */

import { z } from 'zod/v4'
import { buildTool, type ToolUseContext } from '../../Tool.js'
import type {
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/index.mjs'
import { lazySchema } from '../../utils/lazySchema.js'
import { RLM_TOOL_NAME } from './constants.js'
import { rlmController } from './controller.js'
import type { AdapterDeps } from './adapter.js'
import { createEngine, type RlmProgress } from './engine.js'
import { packCwd } from './pack-cwd.js'
import { renderToolUseProgressMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    prompt: z
      .string()
      .describe(
        'What to study or answer using the RLM Python sandbox. ' +
        'Be focused — one sub-question per call. The packed working directory is in `context`.',
      ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type RLMInput = z.infer<InputSchema>

type RLMOutput = {
  answer: string
  iterations: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  lastStdout: string
}

export const RLMTool = buildTool({
  name: RLM_TOOL_NAME,
  searchHint: 'rlm recursive language model python sandbox analyze codebase delegate sub-llm',
  maxResultSizeChars: 100_000,
  strict: true,

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  async description() {
    return 'Recursive Language Model sandbox — study a codebase or question using a persistent Python REPL with sub-LLM delegation, search, and context awareness. Use when the task benefits from recursive decomposition over a large codebase or multi-step analysis.'
  },
  async prompt() {
    return `Use the RLM tool for tasks that benefit from recursive decomposition — exploring a codebase, analyzing multiple files, delegating sub-questions to sub-LLMs.

The RLM sandbox:
- Packs the current working directory into \`context\` (file tree with content)
- Runs Python in a persistent REPL across turns
- Provides search/grep_context/outline for context exploration
- Supports sub-LLM delegation (llm_query, llm_batch, rlm_query, rlm_batch)
- Has access to a \`context\` list of files to explore

Pass a focused, self-contained prompt. The engine runs multiple turns internally and returns a final answer. For file edits, use the direct tools (Read/Write/Edit) instead.`
  },

  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return true
  },

  userFacingName() {
    return 'RLM'
  },

  renderToolUseMessage(input: Partial<RLMInput>) {
    const prompt = input.prompt ?? ''
    const preview = prompt.length > 80 ? prompt.slice(0, 77) + '...' : prompt
    return `RLM: ${preview}`
  },

  mapToolResultToToolResultBlockParam(
    content: RLMOutput,
    toolUseID: string,
  ): ToolResultBlockParam {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: content.answer,
    }
  },

  async call(input: RLMInput, context: ToolUseContext, _canUseTool, _parentMessage, onProgress?) {
    if (!rlmController.isEnabled()) {
      return { data: { answer: 'RLM mode is disabled. Run /rlm to enable.', iterations: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, lastStdout: '' } satisfies RLMOutput }
    }

    const signal = rlmController.begin()
    const model = context.options.mainLoopModel

    const adapter: AdapterDeps = {
      model,
      signal,
      requestTimeoutMs: rlmController.getConfig().requestTimeoutMs,
      getToolPermissionContext: async () => ({
        allowedTools: [],
        deniedTools: [],
        customInstructions: [],
        additionalWorkingDirectories: [],
      }),
      querySource: 'rlm' as any,
    }

    try {
      const packProgress: RlmProgress = { type: 'rlm_progress', phase: 'start', detail: 'packing cwd' }
      onProgress?.({
        toolUseID: context.toolUseId ?? '',
        data: packProgress as any,
      })

      const contextPayload = await packCwd(process.cwd())
      onProgress?.({
        toolUseID: context.toolUseId ?? '',
        data: { type: 'rlm_progress', phase: 'start', detail: `packed ${contextPayload.length} files` },
      })

      const config = rlmController.getConfig()
      const cwd = process.cwd()
      const engine = createEngine({
        config,
        adapter,
        cwd,
        signal,
        onEvent: (e: RlmProgress) => {
          onProgress?.({
            toolUseID: context.toolUseId ?? '',
            data: e as any,
          })
        },
      })

      const result = await engine({
        rootPrompt: input.prompt,
        context: contextPayload,
        depth: 0,
      })

      const output: RLMOutput = {
        answer: result.answer,
        iterations: result.iterations,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        lastStdout: result.lastStdout,
      }
      return { data: output }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { data: { answer: `RLM error: ${msg}`, iterations: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, lastStdout: '' } satisfies RLMOutput }
    } finally {
      rlmController.end()
    }
  },

  renderToolUseProgressMessage,
})
