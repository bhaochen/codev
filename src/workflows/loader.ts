import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { defineWorkflow } from './definition.js'
import type { NormalizedWorkflow } from './types.js'

export const WORKFLOW_FILE_PATTERN = /\.workflow\.(?:ts|tsx|mjs|js)$/

export function getProjectWorkflowsDir(cwd: string = process.cwd()): string {
  return join(cwd, '.claude', 'workflows')
}

export function getGlobalWorkflowsDir(): string {
  return join(getClaudeConfigHomeDir(), 'workflows')
}

export type WorkflowScope = 'project' | 'global'

export type DiscoveredWorkflow = {
  /** File stem: `echo` for `echo.workflow.ts`. Doubles as the command name. */
  name: string
  path: string
  scope: WorkflowScope
}

export type LoadError = {
  path: string
  message: string
}

async function scanWorkflowsDir(dir: string, scope: WorkflowScope): Promise<DiscoveredWorkflow[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found: DiscoveredWorkflow[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !WORKFLOW_FILE_PATTERN.test(entry.name)) continue
    found.push({
      name: entry.name.replace(WORKFLOW_FILE_PATTERN, ''),
      path: join(dir, entry.name),
      scope,
    })
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Discover workflow files in the project and global directories. On name
 * conflicts the project file wins; duplicates within one scope are reported
 * as load errors rather than silently resolved.
 */
export async function discoverWorkflows(options: {
  cwd?: string
} = {}): Promise<{ workflows: DiscoveredWorkflow[]; errors: LoadError[] }> {
  const errors: LoadError[] = []
  const [project, global] = await Promise.all([
    scanWorkflowsDir(getProjectWorkflowsDir(options.cwd), 'project'),
    scanWorkflowsDir(getGlobalWorkflowsDir(), 'global'),
  ])

  const byName = new Map<string, DiscoveredWorkflow>()
  for (const item of [...global, ...project]) {
    const existing = byName.get(item.name)
    if (existing && existing.scope === item.scope) {
      errors.push({
        path: item.path,
        message: `duplicate workflow name "${item.name}" in ${item.scope} directory`,
      })
      continue
    }
    byName.set(item.name, item)
  }
  return { workflows: [...byName.values()], errors }
}

/**
 * Load and validate a single workflow module. The file's default export may
 * be a raw definition object or the result of calling defineWorkflow() in
 * the file; both are validated here so authoring mistakes fail at load time.
 */
export async function loadWorkflow(path: string): Promise<NormalizedWorkflow> {
  let mod: Record<string, unknown>
  try {
    mod = (await import(path)) as Record<string, unknown>
  } catch (error) {
    throw new Error(`Failed to import ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const def = mod.default as NormalizedWorkflow | undefined
  if (
    def === null ||
    typeof def !== 'object' ||
    typeof (def as Partial<NormalizedWorkflow>).name !== 'string' ||
    typeof (def as Partial<NormalizedWorkflow>).startAt !== 'string' ||
    def.nodes === undefined ||
    def.edges === undefined
  ) {
    throw new Error(
      `${path}: default export must be a workflow definition (defineWorkflow({ ... })) with name, startAt, nodes, and edges`,
    )
  }
  return defineWorkflow(def)
}
