/**
 * Session Logger — Structured, session-aware logging.
 *
 * Instead of raw console.log, all log entries carry structured context:
 * - sessionId: which session this belongs to
 * - agentId: which agent (for multi-agent teams)
 * - turnId: which conversation turn
 * - toolCallId: which tool call (if applicable)
 * - requestId: unique request ID
 *
 * In TUI mode: color by session ID for visual distinction.
 * In headless/JSON mode: structured output without ANSI colors.
 */
import { writeToStderr } from './process.js'

export interface LogContext {
  sessionId?: string
  agentId?: string
  turnId?: string
  toolCallId?: string
  requestId?: string
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Emit ANSI colors only when stderr is an interactive terminal and the user
 * hasn't opted out via NO_COLOR. Headless/JSON mode, pipes, and file output
 * get plain text so we never corrupt machine-readable streams.
 */
function shouldColorize(): boolean {
  if (process.env.NO_COLOR) return false
  return Boolean(process.stderr.isTTY)
}

// Stable color palette for session IDs (16 colors)
const SESSION_COLORS = [
  '\x1b[36m', // cyan
  '\x1b[32m', // green
  '\x1b[33m', // yellow
  '\x1b[35m', // magenta
  '\x1b[34m', // blue
  '\x1b[96m', // bright cyan
  '\x1b[92m', // bright green
  '\x1b[93m', // bright yellow
  '\x1b[95m', // bright magenta
  '\x1b[94m', // bright blue
  '\x1b[91m', // bright red
  '\x1b[90m', // bright black
  '\x1b[31m', // red
  '\x1b[37m', // white
  '\x1b[97m', // bright white
  '\x1b[30m', // black
] as const

const RESET = '\x1b[0m'

export class SessionLogger {
  private context: LogContext
  private color: string | null = null

  constructor(context: LogContext) {
    this.context = context
    if (context.sessionId) {
      this.color = this.getColorForSession(context.sessionId)
    }
  }

  /**
   * Create a child logger with additional context.
   */
  child(additionalContext: LogContext): SessionLogger {
    return new SessionLogger({ ...this.context, ...additionalContext })
  }

  debug(message: string, ...args: unknown[]): void {
    this.log('debug', message, ...args)
  }

  info(message: string, ...args: unknown[]): void {
    this.log('info', message, ...args)
  }

  warn(message: string, ...args: unknown[]): void {
    this.log('warn', message, ...args)
  }

  error(message: string, ...args: unknown[]): void {
    this.log('error', message, ...args)
  }

  private log(level: LogLevel, message: string, ...args: unknown[]): void {
    const prefix = this.buildPrefix(level)
    const formatted = args.length > 0 ? `${message} ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}` : message

    // Only emit ANSI colors when stderr is an interactive TTY and the user
    // hasn't disabled color. Otherwise (headless/JSON mode, pipes, files) emit
    // plain structured text so we never corrupt machine-readable output.
    if (this.color && shouldColorize()) {
      writeToStderr(`${this.color}${prefix}${RESET} ${formatted}\n`)
    } else {
      writeToStderr(`${prefix} ${formatted}\n`)
    }
  }

  private buildPrefix(level: LogLevel): string {
    const parts: string[] = []

    if (this.context.sessionId) {
      parts.push(`[${this.context.sessionId.slice(0, 8)}]`)
    }
    if (this.context.agentId) {
      parts.push(`[${this.context.agentId.slice(0, 8)}]`)
    }
    if (this.context.turnId) {
      parts.push(`[turn:${this.context.turnId.slice(0, 4)}]`)
    }
    if (this.context.toolCallId) {
      parts.push(`[tool:${this.context.toolCallId.slice(0, 4)}]`)
    }

    const levelTag = level.toUpperCase().padEnd(5)
    parts.push(`[${levelTag}]`)

    return parts.join(' ')
  }

  private getColorForSession(sessionId: string): string {
    // Simple hash for stable color assignment
    let hash = 0
    for (let i = 0; i < sessionId.length; i++) {
      hash = ((hash << 5) - hash + sessionId.charCodeAt(i)) | 0
    }
    return SESSION_COLORS[Math.abs(hash) % SESSION_COLORS.length]
  }
}

/**
 * Create a session logger for the given context.
 */
export function createLogger(context: LogContext): SessionLogger {
  return new SessionLogger(context)
}
