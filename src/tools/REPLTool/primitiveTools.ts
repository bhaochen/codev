import type { Tool } from '../../Tool.js'
import { BashTool } from '../BashTool/BashTool.js'
import { FileEditTool } from '../FileEditTool/FileEditTool.js'
import { FileReadTool } from '../FileReadTool/FileReadTool.js'
import { FileWriteTool } from '../FileWriteTool/FileWriteTool.js'
import { GlobTool } from '../GlobTool/GlobTool.js'
import { GrepTool } from '../GrepTool/GrepTool.js'

let _primitiveTools: readonly Tool[] | undefined

/**
 * Primitive tools accessible inside the REPL VM context via callTool().
 * These remain directly callable as normal tools too — REPL is additive,
 * it does not replace them.
 */
export function getReplPrimitiveTools(): readonly Tool[] {
  return (_primitiveTools ??= [
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    BashTool,
  ])
}
