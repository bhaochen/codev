import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import {
  getGlobalConfig,
  isConfigReadingAllowed,
} from '../../utils/config.js'
import { AGENT_TOOL_NAME } from '../AgentTool/constants.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'

export const REPL_TOOL_NAME = 'REPL'

/**
 * REPL mode is default-on for interactive CLI sessions.
 * Set REPL to false in /config, or CODEV_REPL=0/CLAUDE_CODE_REPL=0,
 * to disable.
 */
export function isReplModeEnabled(): boolean {
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_REPL)) return false
  if (isEnvDefinedFalsy(process.env.CODEV_REPL)) return false
  if (isEnvTruthy(process.env.CLAUDE_CODE_REPL)) return true
  if (isEnvTruthy(process.env.CODEV_REPL)) return true
  if (!isConfigReadingAllowed()) return true
  return getGlobalConfig().replEnabled ?? true
}

/**
 * Tools that are only accessible via REPL when REPL mode is enabled.
 * When REPL mode is on, these tools are hidden from Claude's direct use,
 * forcing Claude to use REPL for batch operations.
 */
export const REPL_ONLY_TOOLS = new Set([
  FILE_READ_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  BASH_TOOL_NAME,
])
