import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverWorkflows,
  getProjectWorkflowsDir,
  loadWorkflow,
} from '../loader.js'

async function makeTempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'codev-wf-loader-'))
}

async function writeWorkflow(
  root: string,
  fileName: string,
  code: string,
): Promise<void> {
  const dir = join(root, '.claude', 'workflows')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, fileName), code)
}

describe('discoverWorkflows', () => {
  test('empty directories yield nothing', async () => {
    const project = await makeTempProject()
    const configHome = await makeTempProject()
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configHome
    try {
      const { workflows, errors } = await discoverWorkflows({ cwd: project })
      expect(workflows).toEqual([])
      expect(errors).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
      await rm(project, { recursive: true, force: true })
      await rm(configHome, { recursive: true, force: true })
    }
  })

  test('finds .workflow.ts files; project overrides global on name clash', async () => {
    const project = await makeTempProject()
    const configHome = await makeTempProject()
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configHome
    try {
      const def = `export default {
        name: 'echo',
        startAt: 'reply',
        nodes: { reply: { kind: 'compute', run: () => 'x' } },
        edges: [],
      }`
      await writeWorkflow(project, 'echo.workflow.ts', def)
      // global copy must be shadowed by the project one
      await writeFile(join(configHome, 'workflows', 'echo.workflow.ts'), def, { flag: 'a' })
        .catch(() => {})
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync(join(configHome, 'workflows'), { recursive: true })
      writeFileSync(join(configHome, 'workflows', 'echo.workflow.ts'), def)

      const { workflows, errors } = await discoverWorkflows({ cwd: project })
      expect(errors).toEqual([])
      expect(workflows).toHaveLength(1)
      expect(workflows[0]?.name).toBe('echo')
      expect(workflows[0]?.scope).toBe('project')
      expect(workflows[0]?.path.startsWith(getProjectWorkflowsDir(project))).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
      await rm(project, { recursive: true, force: true })
      await rm(configHome, { recursive: true, force: true })
    }
  })

  test('duplicate stems within one scope are reported as errors', async () => {
    const project = await makeTempProject()
    const configHome = await makeTempProject()
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configHome
    try {
      const def = `export default { name: 'dup', startAt: 'n',
        nodes: { n: { kind: 'compute', run: () => 1 } }, edges: [] }`
      await writeWorkflow(project, 'dup.workflow.ts', def)
      await writeWorkflow(project, 'dup.workflow.js', def)
      const { workflows, errors } = await discoverWorkflows({ cwd: project })
      expect(workflows).toHaveLength(1)
      expect(errors).toHaveLength(1)
      expect(errors[0]?.message).toContain('duplicate workflow name')
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = prev
      await rm(project, { recursive: true, force: true })
      await rm(configHome, { recursive: true, force: true })
    }
  })
})

describe('loadWorkflow', () => {
  test('loads and validates a good definition', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codev-wf-load-'))
    try {
      const path = join(dir, 'ok.workflow.ts')
      await writeFile(
        path,
        `export default { name: 'ok', startAt: 'n',
          nodes: { n: { kind: 'compute', run: () => 1 } }, edges: [] }`,
      )
      const wf = await loadWorkflow(path)
      expect(wf.name).toBe('ok')
      expect(wf.maxSteps).toBe(100)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('surfaces graph validation errors at load time', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codev-wf-load-'))
    try {
      const path = join(dir, 'broken.workflow.ts')
      await writeFile(
        path,
        `export default { name: 'broken', startAt: 'n',
          nodes: { n: { kind: 'compute', run: () => 1 } },
          edges: [{ from: 'n', to: 'ghost' }] }`,
      )
      expect(async () => loadWorkflow(path)).toThrow(/unknown target node/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('rejects modules without a workflow-shaped default export', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codev-wf-load-'))
    try {
      const path = join(dir, 'junk.workflow.ts')
      await writeFile(path, 'export default 42')
      expect(async () => loadWorkflow(path)).toThrow(/default export/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
