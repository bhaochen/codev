import { execa, execaSync } from 'execa'

// `command` is a lookup name, but a shell string lets metacharacters in it run
// as code if a caller ever passes a dynamic value. Argv form, no shell.
async function whichNodeAsync(command: string): Promise<string | null> {
  const file = process.platform === 'win32' ? 'where.exe' : 'which'
  const result = await execa(file, [command], {
    stderr: 'ignore',
    reject: false,
  })
  if (result.exitCode !== 0 || !result.stdout) {
    return null
  }
  // where.exe returns multiple paths separated by newlines; take the first.
  const first = result.stdout.trim().split(/\r?\n/)[0] || null
  return first
}

function whichNodeSync(command: string): string | null {
  try {
    const file = process.platform === 'win32' ? 'where.exe' : 'which'
    const result = execaSync(file, [command], {
      stdio: ['ignore', 'pipe', 'ignore'],
      reject: false,
    })
    if (result.exitCode !== 0 || !result.stdout) return null
    const output = result.stdout.trim()
    return output.split(/\r?\n/)[0] || null
  } catch {
    return null
  }
}

const bunWhich =
  typeof Bun !== 'undefined' && typeof Bun.which === 'function'
    ? Bun.which
    : null

/**
 * Finds the full path to a command executable.
 * Uses Bun.which when running in Bun (fast, no process spawn),
 * otherwise spawns the platform-appropriate command.
 *
 * @param command - The command name to look up
 * @returns The full path to the command, or null if not found
 */
export const which: (command: string) => Promise<string | null> = bunWhich
  ? async command => bunWhich(command)
  : whichNodeAsync

/**
 * Synchronous version of `which`.
 *
 * @param command - The command name to look up
 * @returns The full path to the command, or null if not found
 */
export const whichSync: (command: string) => string | null =
  bunWhich ?? whichNodeSync
