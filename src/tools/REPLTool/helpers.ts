/**
 * REPL helpers - reliable file edit/write/read plus diff display, exposed as
 * globals inside the REPL sandbox.
 *
 * The primitive Edit/Write tools require readFileState to be primed (file Read
 * in-session) and throw FILE_UNEXPECTED_MODIFIED / FILE_UNEXPECTEDLY_MODIFIED
 * on stale timestamps, which is flaky inside the REPL. These helpers perform
 * the fs I/O directly in the engine process (always persists) and keep
 * readFileState fresh so the real Read/Edit tools stay consistent afterward.
 */
import { execSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'
import { getPatchForDisplay, getPatchFromContents } from '../../utils/diff.js'
import { getFileModificationTime, writeTextContent } from '../../utils/file.js'
import {
  readFileSyncWithMetadata,
  type LineEndingType,
} from '../../utils/fileRead.js'
import { expandPath } from '../../utils/path.js'

export type ReplHelpers = {
  /** Read a file and return its content (also primes readFileState). */
  readFile: (path: string) => string
  /** Write a file reliably and print an added/removed diff of the change. */
  writeFile: (path: string, content: string) => void
  /** Edit a file reliably (reads fresh, replaces, writes) and print a diff. */
  editFile: (
    path: string,
    oldString: string,
    newString: string,
    opts?: { replaceAll?: boolean },
  ) => void
  /** Display a file's contents with line numbers, like the Read tool. */
  viewFile: (path: string, opts?: { context?: number }) => void
  /** Show the working-tree (or vs ref) diff of a file via git. */
  diffFile: (path: string, ref?: string) => void
  /** Show a unified diff between two strings. */
  showDiff: (before: string, after: string, filePath?: string) => void
}

type HelperDeps = {
  getContext: () => ToolUseContext
  log: (line: string) => void
}

function formatHunks(hunks: { lines: string[] }[] | null | undefined): string {
  if (!hunks || hunks.length === 0) return '(no changes)'
  return hunks.map(h => h.lines.join('\n')).join('\n')
}

export function createReplHelpers(deps: HelperDeps): ReplHelpers {
  const { getContext, log } = deps

  function primeReadState(abs: string, content: string): void {
    try {
      getContext().readFileState.set(abs, {
        content,
        timestamp: getFileModificationTime(abs),
        offset: undefined,
        limit: undefined,
      })
    } catch {
      // readFileState may be unavailable in some contexts; ignore.
    }
  }

  function readFresh(abs: string): string {
    const meta = readFileSyncWithMetadata(abs)
    primeReadState(abs, meta.content)
    return meta.content
  }

  function shellQuote(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'"
  }

  function readFile(path: string): string {
    try {
      const abs = expandPath(path)
      return readFresh(abs)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log('Error reading ' + path + ': ' + msg)
      return ''
    }
  }

  function writeFile(path: string, content: string): void {
    try {
      const abs = expandPath(path)
      mkdirSync(dirname(abs), { recursive: true })
      writeTextContent(abs, content, 'utf8', 'LF' as LineEndingType)
      primeReadState(abs, content)
      const bytes = Buffer.byteLength(content)
      log('Wrote ' + abs + ' (' + bytes + ' bytes)')
      const patch = getPatchFromContents({
        filePath: abs,
        oldContent: '',
        newContent: content,
      })
      log(formatHunks(patch))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log('Error writing ' + path + ': ' + msg)
    }
  }

  function editFile(
    path: string,
    oldString: string,
    newString: string,
    opts?: { replaceAll?: boolean },
  ): void {
    try {
      const abs = expandPath(path)
      let current: string
      try {
        current = readFileSyncWithMetadata(abs).content
      } catch (e) {
        if (oldString === '') {
          writeFile(path, newString)
          return
        }
        const msg = e instanceof Error ? e.message : String(e)
        log('Error: file not found: ' + path + ' (' + msg + ')')
        return
      }
      const replaceAll = opts?.replaceAll ?? false
      const matches = current.split(oldString).length - 1
      if (matches === 0) {
        log('Error: old_string not found in ' + path)
        return
      }
      if (matches > 1 && !replaceAll) {
        log(
          'Error: ' +
            matches +
            ' matches found in ' +
            path +
            "; pass { replaceAll: true } to replace all, or add more context.",
        )
        return
      }
      const newContent = replaceAll
        ? current.replaceAll(oldString, newString)
        : current.replace(oldString, newString)
      mkdirSync(dirname(abs), { recursive: true })
      writeTextContent(abs, newContent, 'utf8', 'LF' as LineEndingType)
      primeReadState(abs, newContent)
      const patch = getPatchForDisplay({
        filePath: abs,
        fileContents: current,
        edits: [
          {
            old_string: oldString,
            new_string: newString,
            replace_all: replaceAll,
          },
        ],
      })
      log('Edited ' + abs)
      log(formatHunks(patch))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log('Error editing ' + path + ': ' + msg)
    }
  }

  function viewFile(path: string, opts?: { context?: number }): void {
    try {
      const abs = expandPath(path)
      const content = readFresh(abs)
      const lines = content.split('\n')
      const width = String(lines.length).length
      const numbered = lines
        .map((ln, i) => {
          const n = String(i + 1).padStart(width, ' ')
          return n + '\t' + ln
        })
        .join('\n')
      log(numbered)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log('Error viewing ' + path + ': ' + msg)
    }
  }

  function isTracked(dir: string, abs: string): boolean {
    try {
      execSync(
        'git -C ' + shellQuote(dir) + ' ls-files --error-unmatch -- ' + shellQuote(abs),
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
      return true
    } catch {
      return false
    }
  }

  function diffFile(path: string, ref?: string): void {
    try {
      const abs = expandPath(path)
      const dir = dirname(abs)
      const refArg = ref ? ref + ' ' : ''
      const cmd =
        'git -C ' +
        shellQuote(dir) +
        ' --no-pager diff --no-color ' +
        refArg +
        '-- ' +
        shellQuote(abs)
      let out = ''
      try {
        out = execSync(cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string }
        if (typeof err.stdout === 'string' && err.stdout.length > 0) {
          out = err.stdout
        } else {
          log('Error running git diff: ' + (err.stderr || String(e)))
          return
        }
      }
      if (out.trim()) {
        log(out)
        return
      }
      // git diff is empty: for an untracked (new) file, show the whole file as
      // additions so the user can see exactly what code was added.
      if (!ref && !isTracked(dir, abs)) {
        const content = readFresh(abs)
        const patch = getPatchFromContents({
          filePath: abs,
          oldContent: '',
          newContent: content,
        })
        log(formatHunks(patch))
        return
      }
      log('(no unstaged changes vs ' + (ref || 'HEAD') + ')')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log('Error diffing ' + path + ': ' + msg)
    }
  }

  function showDiff(before: string, after: string, filePath?: string): void {
    try {
      const patch = getPatchFromContents({
        filePath: filePath || 'a.txt',
        oldContent: before,
        newContent: after,
      })
      log(formatHunks(patch))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      log('Error: ' + msg)
    }
  }

  return { readFile, writeFile, editFile, viewFile, diffFile, showDiff }
}
