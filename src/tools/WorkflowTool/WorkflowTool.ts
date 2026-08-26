import { z } from 'zod/v4'
import type { Tool } from '../../Tool.js'
import { buildTool } from '../../Tool.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getWorkflowRuntime } from '../../workflows/runtime.js'
import { initBundledWorkflows } from './bundled/index.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import { getPrompt } from './prompt.js'
import { renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z.enum([
      'list',
      'start',
      'status',
      'pause',
      'resume',
      'cancel',
      'answer',
      'submit',
    ]),
    /** start: workflow name. */
    name: z.string().optional(),
    /** start: run input as a JSON object string. */
    input_json: z.string().optional(),
    /** answer: checkpoint payload as any JSON string. */
    value_json: z.string().optional(),
    /** submit: structured output of the current step. */
    output: z.unknown().optional(),
  }),
)
// Materialize bundled workflows once when the tool module loads (moved here
// from tools.ts: its compile step miscompiles 'return require(...)' branches).
initBundledWorkflows()

type InputSchema = ReturnType<typeof inputSchema>

export type Input = z.infer<InputSchema>

export type WorkflowToolOutput = {
  ok: boolean
  result?: unknown
  error?: string
}

function parseJsonOrThrow(text: string | undefined, field: string): unknown {
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(
      `${field} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export const WorkflowTool: Tool<InputSchema, WorkflowToolOutput> = buildTool({
  name: WORKFLOW_TOOL_NAME,
  searchHint: 'list/start/submit multi-step workflows',
  maxResultSizeChars: 100_000,
  shouldDefer: true,

  userFacingName() {
    return 'Workflow'
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },

  isReadOnly(input) {
    return input.action === 'list' || input.action === 'status'
  },

  toAutoClassifierInput(input) {
    return `workflow ${input.action}${input.name ? `: ${input.name}` : ''}`
  },

  async validateInput(input) {
    if (input.action === 'start' && !input.name) {
      return { result: false, message: 'action "start" requires "name"', errorCode: 9 }
    }
    if (input.action === 'submit' && input.output === undefined) {
      return { result: false, message: 'action "submit" requires "output"', errorCode: 9 }
    }
    if (input.action === 'answer' && input.value_json === undefined) {
      return {
        result: false,
        message: 'action "answer" requires "value_json"',
        errorCode: 9,
      }
    }
    return { result: true }
  },

  async description() {
    return 'Operate multi-step workflows (list/start/pause/resume/cancel/answer/submit)'
  },

  async prompt() {
    return getPrompt()
  },

  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [
        {
          type: 'text' as const,
          text: jsonStringify(data),
        },
      ],
    }
  },

  renderToolUseMessage,

  async call(input, context) {
    const runtime = getWorkflowRuntime()
    try {
      switch (input.action) {
        case 'list': {
          const { discoverWorkflows } = await import('../../workflows/loader.js')
          const discovered = await discoverWorkflows()
          const stored = await runtime.listStoredRuns({
            statuses: ['running', 'paused', 'waiting'],
          })
          return {
            data: {
              ok: true,
              result: {
                workflows: discovered.workflows.map(wf => ({
                  name: wf.name,
                  scope: wf.scope,
                })),
                loadErrors: discovered.errors,
                activeRunsInSession: stored.map(run => ({
                  id: run.id,
                  name: run.workflowName,
                  status: run.status,
                })),
              },
            },
          }
        }
        case 'start': {
          const inputObj = parseJsonOrThrow(input.input_json, 'input_json')
          const runInput =
            inputObj !== undefined && typeof inputObj === 'object' && inputObj !== null
              ? (inputObj as Record<string, unknown>)
              : input.input_json !== undefined
                ? { task: String(inputObj) }
                : {}
          const message = await runtime.start(input.name!, runInput)
          const started = runtime.getStatus()
          if (started && context?.setAppState) {
            const { trackWorkflowRun } = await import(
              '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
            )
            trackWorkflowRun(context.setAppState, started)
          }
          return { data: { ok: true, result: message } }
        }
        case 'status':
          return { data: { ok: true, result: runtime.getStatus() } }
        case 'pause':
          return { data: { ok: true, result: runtime.requestPause() } }
        case 'resume':
          return { data: { ok: true, result: runtime.resume() } }
        case 'cancel':
          return { data: { ok: true, result: runtime.cancel() } }
        case 'answer': {
          const value = parseJsonOrThrow(input.value_json, 'value_json')
          return { data: { ok: true, result: runtime.answer(value) } }
        }
        case 'submit': {
          const submitted = runtime.handleSubmit(input.output)
          return submitted.ok
            ? { data: { ok: true, result: submitted.message } }
            : { data: { ok: false, error: submitted.message } }
        }
      }
    } catch (error) {
      return {
        data: {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
      }
    }
  },
})
