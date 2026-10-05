/**
 * Per-project working-tree snapshots stored in a separate shadow Git repo.
 * Snapshot operations never read or update the project's Git index or refs.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { formatPatch, structuredPatch } from 'diff'
import { execFileNoThrow } from '../../utils/execFileNoThrow.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { logError } from '../../utils/log.js'

const MAX_SNAPSHOT_FILE_BYTES = 2 * 1024 * 1024
const MAX_DIFF_FILE_BYTES = 200 * 1024
const MAX_HASH_LENGTH = 64
const GC_INTERVAL_MS = 60 * 60 * 1000
const GC_INITIAL_DELAY_MS = 60_000

export type SnapshotEntry = {
  hash: string
  date: string
  message: string
}

export type FileDiffStatus = 'added' | 'deleted' | 'modified'

export type FileDiff = {
  file: string
  status: FileDiffStatus
  binary: boolean
  additions: number
  deletions: number
  patch: string
  truncated?: boolean
}

type GitResult = { stdout: string; stderr: string; code: number }

function getSnapshotGitDir(projectCwd: string): string {
  const root =
    process.env.CODEV_SNAPSHOT_DIR?.trim() ||
    join(getClaudeConfigHomeDir(), 'snapshots')
  const projectKey = createHash('sha256')
    .update(resolve(projectCwd))
    .digest('hex')
  return join(root, projectKey, '.git')
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  )
}

async function gitRun(
  gitDir: string,
  projectCwd: string,
  args: string[],
  input?: string,
): Promise<GitResult> {
  return execFileNoThrow(
    'git',
    [
      `--git-dir=${gitDir}`,
      `--work-tree=${resolve(projectCwd)}`,
      '-c',
      'core.longpaths=true',
      '-c',
      'core.symlinks=true',
      '-c',
      'core.autocrlf=false',
      '-c',
      'core.quotepath=false',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.untrackedCache=false',
      '-c',
      'user.name=Codev Snapshot',
      '-c',
      'user.email=snapshot@codev.local',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      useCwd: false,
      timeout: 120_000,
      preserveOutputOnError: true,
      env: gitEnvironment(),
      ...(input !== undefined ? { stdin: 'pipe', input } : {}),
    },
  )
}

function assertGitSuccess(result: GitResult, operation: string): string {
  if (result.code !== 0) {
    throw new Error(`${operation} failed: ${result.stderr.trim() || result.code}`)
  }
  return result.stdout
}

const locks = new Map<string, Promise<unknown>>()

async function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const result = previous.then(run, run)
  locks.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  )
  return result
}

const gcStarted = new Set<string>()

function startGc(gitDir: string, projectCwd: string): void {
  if (gcStarted.has(gitDir)) return
  gcStarted.add(gitDir)
  const collect = (): void => {
    void withLock(gitDir, async () => {
      const result = await gitRun(gitDir, projectCwd, [
        'gc',
        '--prune=7.days',
        '--quiet',
      ])
      if (result.code !== 0) {
        logError(`snapshot gc failed: ${result.stderr.trim()}`)
      }
    }).catch(error => logError(error))
  }
  const initial = setTimeout(collect, GC_INITIAL_DELAY_MS)
  initial.unref?.()
  const recurring = setInterval(collect, GC_INTERVAL_MS)
  recurring.unref?.()
}

async function ensureSnapshotRepo(projectCwd: string): Promise<string> {
  const gitDir = getSnapshotGitDir(projectCwd)
  try {
    await stat(join(gitDir, 'HEAD'))
  } catch {
    await mkdir(gitDir, { recursive: true })
    const init = await gitRun(gitDir, projectCwd, ['init', '--quiet'])
    assertGitSuccess(init, 'initialize snapshot repository')
    for (const [key, value] of [
      ['core.fsmonitor', 'false'],
      ['core.untrackedCache', 'false'],
    ]) {
      const configured = await gitRun(gitDir, projectCwd, [
        'config',
        key,
        value,
      ])
      assertGitSuccess(configured, `configure snapshot repository (${key})`)
    }
  }
  startGc(gitDir, projectCwd)
  return gitDir
}

function literalPathspecs(paths: readonly string[]): string | undefined {
  return paths.length === 0
    ? undefined
    : `${paths.map(path => `:(literal)${path}`).join('\0')}\0`
}

async function stageChanges(
  gitDir: string,
  projectCwd: string,
): Promise<void> {
  const listed = await gitRun(gitDir, projectCwd, [
    'ls-files',
    '--modified',
    '--deleted',
    '--others',
    '--exclude-standard',
    '-z',
  ])
  if (listed.code !== 0) {
    throw new Error(`enumerate snapshot files failed: ${listed.stderr.trim()}`)
  }

  const candidates = [...new Set(listed.stdout.split('\0').filter(Boolean))]
  const stage: string[] = []
  const oversized: string[] = []
  await Promise.all(
    candidates.map(async file => {
      try {
        const details = await lstat(join(projectCwd, file))
        if (!details.isFile() && !details.isSymbolicLink()) return
        if (details.size > MAX_SNAPSHOT_FILE_BYTES) oversized.push(file)
        else stage.push(file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          stage.push(file)
          return
        }
        throw error
      }
    }),
  )

  const largePathspecs = literalPathspecs(oversized)
  if (largePathspecs !== undefined) {
    const untrack = await gitRun(
      gitDir,
      projectCwd,
      [
        'rm',
        '--cached',
        '--force',
        '--ignore-unmatch',
        '--pathspec-from-file=-',
        '--pathspec-file-nul',
      ],
      largePathspecs,
    )
    assertGitSuccess(untrack, 'exclude oversized snapshot files')
  }

  const pathspecs = literalPathspecs(stage)
  if (pathspecs !== undefined) {
    const add = await gitRun(
      gitDir,
      projectCwd,
      ['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'],
      pathspecs,
    )
    assertGitSuccess(add, 'stage snapshot files')
  }
}

export async function trackSnapshot(
  projectCwd: string,
  label?: string,
): Promise<SnapshotEntry> {
  const gitDir = await ensureSnapshotRepo(projectCwd)
  return withLock(gitDir, async () => {
    await stageChanges(gitDir, projectCwd)
    const safeLabel = label?.trim().replace(/\s+/g, ' ').slice(0, 120)
    const message = safeLabel
      ? `snapshot: ${safeLabel}`
      : `snapshot: ${new Date().toISOString()}`
    const commit = await gitRun(gitDir, projectCwd, [
      'commit',
      '-m',
      message,
      '--allow-empty',
      '--quiet',
    ])
    assertGitSuccess(commit, 'save snapshot')
    const hash = assertGitSuccess(
      await gitRun(gitDir, projectCwd, ['rev-parse', 'HEAD']),
      'resolve saved snapshot',
    ).trim()
    const date = assertGitSuccess(
      await gitRun(gitDir, projectCwd, ['show', '-s', '--format=%cI', hash]),
      'read snapshot date',
    ).trim()
    return { hash, date, message }
  })
}

export async function listSnapshots(
  projectCwd: string,
  limit = 20,
): Promise<SnapshotEntry[]> {
  const gitDir = await ensureSnapshotRepo(projectCwd)
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))
  return withLock(gitDir, async () => {
    const log = await gitRun(gitDir, projectCwd, [
      'log',
      `--max-count=${safeLimit}`,
      '--format=%H%x09%cI%x09%s',
    ])
    const output = assertGitSuccess(log, 'list snapshots').trim()
    return output
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [hash = '', date = '', ...message] = line.split('\t')
        return { hash, date, message: message.join('\t') }
      })
  })
}

function assertValidHash(hash: string): string {
  const trimmed = hash.trim()
  if (!new RegExp(`^[0-9a-fA-F]{4,${MAX_HASH_LENGTH}}$`).test(trimmed)) {
    throw new Error(`invalid snapshot hash: ${hash}`)
  }
  return trimmed
}

async function resolveCommit(
  gitDir: string,
  projectCwd: string,
  hash: string,
): Promise<string> {
  const resolved = await gitRun(gitDir, projectCwd, [
    'rev-parse',
    '--verify',
    `${assertValidHash(hash)}^{commit}`,
  ])
  return assertGitSuccess(resolved, `resolve snapshot ${hash}`).trim()
}

export async function revertSnapshot(
  projectCwd: string,
  hash: string,
): Promise<SnapshotEntry> {
  const gitDir = await ensureSnapshotRepo(projectCwd)
  return withLock(gitDir, async () => {
    const commit = await resolveCommit(gitDir, projectCwd, hash)
    assertGitSuccess(
      await gitRun(gitDir, projectCwd, ['read-tree', commit]),
      'prepare snapshot restore',
    )
    assertGitSuccess(
      await gitRun(gitDir, projectCwd, ['checkout-index', '-a', '-f']),
      'restore snapshot files',
    )
    const [date, message] = await Promise.all([
      gitRun(gitDir, projectCwd, ['show', '-s', '--format=%cI', commit]),
      gitRun(gitDir, projectCwd, ['show', '-s', '--format=%s', commit]),
    ])
    return {
      hash: commit,
      date: assertGitSuccess(date, 'read snapshot date').trim(),
      message: assertGitSuccess(message, 'read snapshot label').trim(),
    }
  })
}

type DiffRow = {
  file: string
  status: FileDiffStatus
  binary: boolean
  additions: number
  deletions: number
}

async function collectDiffRows(
  gitDir: string,
  projectCwd: string,
  refs: string[],
): Promise<DiffRow[]> {
  const [statusResult, numstatResult] = await Promise.all([
    gitRun(gitDir, projectCwd, [
      'diff',
      '--name-status',
      '--no-renames',
      '-z',
      ...refs,
      '--',
      '.',
    ]),
    gitRun(gitDir, projectCwd, [
      'diff',
      '--numstat',
      '--no-renames',
      '-z',
      ...refs,
      '--',
      '.',
    ]),
  ])
  const statusOutput = assertGitSuccess(statusResult, 'read snapshot diff status')
  const numstatOutput = assertGitSuccess(numstatResult, 'read snapshot diff stats')
  const statuses = new Map<string, FileDiffStatus>()
  const statusParts = statusOutput.split('\0').filter(Boolean)
  for (let index = 0; index + 1 < statusParts.length; index += 2) {
    const code = statusParts[index] ?? ''
    const file = statusParts[index + 1] ?? ''
    statuses.set(
      file,
      code.startsWith('A')
        ? 'added'
        : code.startsWith('D')
          ? 'deleted'
          : 'modified',
    )
  }
  return numstatOutput
    .split('\0')
    .filter(Boolean)
    .flatMap(entry => {
      const firstTab = entry.indexOf('\t')
      const secondTab = entry.indexOf('\t', firstTab + 1)
      if (firstTab < 0 || secondTab < 0) return []
      const additions = entry.slice(0, firstTab)
      const deletions = entry.slice(firstTab + 1, secondTab)
      const file = entry.slice(secondTab + 1)
      if (!file) return []
      const binary = additions === '-' && deletions === '-'
      return [{
        file,
        status: statuses.get(file) ?? 'modified',
        binary,
        additions: binary ? 0 : Number.parseInt(additions, 10) || 0,
        deletions: binary ? 0 : Number.parseInt(deletions, 10) || 0,
      }]
    })
}

async function appendUntrackedRows(
  gitDir: string,
  projectCwd: string,
  rows: DiffRow[],
): Promise<DiffRow[]> {
  const listed = await gitRun(gitDir, projectCwd, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
  ])
  if (listed.code !== 0) {
    throw new Error(`enumerate untracked snapshot files failed: ${listed.stderr.trim()}`)
  }
  const known = new Set(rows.map(row => row.file))
  const additions = await Promise.all(
    listed.stdout
      .split('\0')
      .filter(file => file && !known.has(file))
      .map(async file => {
        try {
          const details = await lstat(join(projectCwd, file))
          if (
            (!details.isFile() && !details.isSymbolicLink()) ||
            details.size > MAX_SNAPSHOT_FILE_BYTES
          ) {
            return null
          }
          const contents = await readFile(join(projectCwd, file))
          const binary = contents.includes(0)
          const text = contents.toString('utf8')
          const lineCount = text
            ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
            : 0
          return {
            file,
            status: 'added' as const,
            binary,
            additions: binary ? 0 : lineCount,
            deletions: 0,
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        }
      }),
  )
  return [
    ...rows,
    ...additions.filter((row): row is NonNullable<typeof row> => row !== null),
  ]
}

async function getTextAtSnapshot(
  gitDir: string,
  projectCwd: string,
  hash: string,
  file: string,
): Promise<string> {
  const result = await gitRun(gitDir, projectCwd, ['show', `${hash}:${file}`])
  return assertGitSuccess(result, `read ${file} from snapshot`)
}

async function buildDiffs(
  gitDir: string,
  projectCwd: string,
  rows: DiffRow[],
  beforeHash: string,
  after: (file: string) => Promise<string>,
): Promise<FileDiff[]> {
  return Promise.all(
    rows.map(async row => {
      if (row.binary) {
        return { ...row, patch: '' }
      }
      const before =
        row.status === 'added'
          ? ''
          : await getTextAtSnapshot(gitDir, projectCwd, beforeHash, row.file)
      const afterText =
        row.status === 'deleted' ? '' : await after(row.file)
      if (
        Buffer.byteLength(before) + Buffer.byteLength(afterText) >
        MAX_DIFF_FILE_BYTES
      ) {
        return {
          ...row,
          patch: `(diff elided: file contents exceed ${MAX_DIFF_FILE_BYTES} byte diff budget)`,
          truncated: true,
        }
      }
      const patch = formatPatch(
        structuredPatch(row.file, row.file, before, afterText, '', ''),
      )
      return { ...row, patch }
    }),
  )
}

export async function snapshotDiff(
  projectCwd: string,
  hash: string,
): Promise<FileDiff[]> {
  const gitDir = await ensureSnapshotRepo(projectCwd)
  return withLock(gitDir, async () => {
    const commit = await resolveCommit(gitDir, projectCwd, hash)
    const rows = await appendUntrackedRows(
      gitDir,
      projectCwd,
      await collectDiffRows(gitDir, projectCwd, [commit]),
    )
    return buildDiffs(gitDir, projectCwd, rows, commit, async file => {
      const content = await readFile(join(projectCwd, file))
      if (content.byteLength > MAX_SNAPSHOT_FILE_BYTES) {
        throw new Error(`current file exceeds snapshot size limit: ${file}`)
      }
      return content.toString('utf8')
    })
  })
}

export async function snapshotDiffBetween(
  projectCwd: string,
  baseHash: string,
  targetHash: string,
): Promise<FileDiff[]> {
  const gitDir = await ensureSnapshotRepo(projectCwd)
  return withLock(gitDir, async () => {
    const [base, target] = await Promise.all([
      resolveCommit(gitDir, projectCwd, baseHash),
      resolveCommit(gitDir, projectCwd, targetHash),
    ])
    const rows = await collectDiffRows(gitDir, projectCwd, [base, target])
    return buildDiffs(gitDir, projectCwd, rows, base, file =>
      getTextAtSnapshot(gitDir, projectCwd, target, file),
    )
  })
}
