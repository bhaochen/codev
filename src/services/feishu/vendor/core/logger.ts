/**
 * Minimal logger — just console output, no file persistence.
 */

export type LogFields = Record<string, unknown>

type Level = 'info' | 'warn' | 'error'

function emit(level: Level, phase: string, event: string, fields: LogFields = {}): void {
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  const tag = level === 'error' ? '✗' : level === 'warn' ? '⚠' : '·'
  const parts: string[] = [`${tag} [${phase}.${event}]`]
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue
    if (typeof v === 'string') {
      parts.push(`${k}=${v.length > 80 ? `${v.slice(0, 80)}…` : v}`)
    } else {
      parts.push(`${k}=${String(v).slice(0, 80)}`)
    }
  }
  fn(parts.join(' '))
}

export const log = {
  info(phase: string, event: string, fields?: LogFields): void {
    emit('info', phase, event, fields)
  },
  warn(phase: string, event: string, fields?: LogFields): void {
    emit('warn', phase, event, fields)
  },
  fail(phase: string, err: unknown, fields?: LogFields): void {
    const message = err instanceof Error ? err.message : String(err)
    emit('error', phase, 'fail', { ...fields, err: message })
  },
}

export function withTrace<T>(_ctx: Record<string, unknown>, fn: () => Promise<T>): Promise<T> {
  return fn()
}

export function reportMetric(_name: string, _value: number, _tags?: Record<string, string>): void {
  // noop
}
