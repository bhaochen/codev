import type { Command, LocalCommandCall } from '../../types/command.js'
import { trackWorkflowRun } from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { getWorkflowRuntime } from '../../workflows/runtime.js'
import { discoverWorkflows, loadWorkflow } from '../../workflows/loader.js'

/**
 * Parse "[task words...] --input-json {...}" into the run input object.
 * The plain text lands under "task"; --input-json keys are merged on top.
 */
export function parseStartArgs(args: string): Record<string, unknown> {
  const marker = '--input-json'
  const idx = args.indexOf(marker)
  if (idx === -1) {
    return args.trim() ? { task: args.trim() } : {}
  }
  const taskText = args.slice(0, idx).trim()
  const jsonText = args.slice(idx + marker.length).trim()
  let extra: unknown
  try {
    extra = JSON.parse(jsonText)
  } catch (error) {
    throw new Error(
      `--input-json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) {
    throw new Error('--input-json must be a JSON object')
  }
  return { ...(taskText ? { task: taskText } : {}), ...(extra as Record<string, unknown>) }
}

function nameFromPath(path: string): string {
  return path
    .split('/')
    .pop()!
    .replace(/\.workflow\.(?:ts|tsx|mjs|js)$/, '')
}

function makeCallFor(workflowName: string): LocalCommandCall {
  return async (args, context) => {
    const runtime = getWorkflowRuntime()
    // Lazy session recovery the first time any workflow command runs.
    await runtime.recover()
    const recovered = runtime.getStatus()
    if (recovered) trackWorkflowRun(context.setAppState, recovered)

    const input = parseStartArgs(args)
    const message = await runtime.start(workflowName, input)
    const status = runtime.getStatus()
    if (status) trackWorkflowRun(context.setAppState, status)
    return { type: 'text', value: message }
  }
}

/** One slash command per discovered workflow file. */
export async function getWorkflowCommands(cwd?: string): Promise<Command[]> {
  const { workflows } = await discoverWorkflows(cwd ? { cwd } : {})
  const commands: Command[] = []
  for (const entry of workflows) {
    let description: string | undefined
    try {
      description = (await loadWorkflow(entry.path)).description
    } catch {
      description = `(broken) ${entry.name}`
    }
    commands.push({
      type: 'local',
      supportsNonInteractive: false,
      name: entry.name,
      kind: 'workflow',
      description: description ?? `Run the "${entry.name}" workflow`,
      argumentHint: '[task] [--input-json {}]',
      load: async () => ({ call: makeCallFor(entry.name) }),
    })
  }
  return commands
}
