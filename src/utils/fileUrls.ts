import { fileURLToPath, pathToFileURL } from 'url'
import { resolve } from 'path'
import { getCwd } from './cwd.js'

export function resolveLocalFileTarget(input: string, cwd: string = getCwd()): { path: string; url: string } {
  const value = input.trim()
  const path = value.toLowerCase().startsWith('file:')
    ? fileURLToPath(new URL(value))
    : resolve(cwd, value)
  return { path, url: pathToFileURL(path).href }
}
