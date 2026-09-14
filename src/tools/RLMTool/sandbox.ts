/**
 * PythonSandbox — owns one `python3 worker.py` subprocess and the JSONL stdio pump.
 *
 * The pump multiplexes two concerns on one pipe:
 *   1. request/response (exec, load_context, shutdown), keyed by `id`;
 *   2. mid-exec sub-LLM interrupts (llm_query/rlm_query), serviced in-process by handlers
 *      the engine installs — the worker never sees API keys.
 *
 * Ported from rlm.pi/pi-plugin/rlm/src/sandbox/sandbox.ts (trimmed to this port's bridge).
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isInterrupt,
  isWorkerMessage,
  type ParentMessage,
  type ReplResult,
  type WorkerMessage,
  type WorkerRequest,
  type WorkerResponse,
} from './protocol.js'
import { pinContext, type PinnedContext } from './context-file.js'
import { REJECT, serviceInterrupt, type ReplyBody, type SubcallHandlers } from './interrupts.js'

export type { SubcallHandlers } from './interrupts.js'

/** Payload shapes for requests that carry per-type fields.
 *  `Omit<WorkerRequest, 'id'>` doesn't distribute over the union — it computes a single
 *  type with only the common keys (`type`), losing `code`/`path`/`json`. Use this union directly. */
type RequestPayload =
  | { readonly type: 'exec'; readonly code: string }
  | { readonly type: 'load_context'; readonly path: string; readonly index?: number; readonly json: boolean }
  | { readonly type: 'shutdown' }

/** Event-loop guard: frames are model/summary-sized by construction; payloads travel via temp
 *  files, never the wire. Anything near this cap is a runaway producer — drop it. */
const MAX_FRAME_CHARS = 8_000_000

export interface SandboxOptions {
  /** Sandbox recursion depth label (passed to the worker, used in interrupt routing). */
  readonly depth?: number
  /** v5 role separation: "child" sandboxes install a delegation-only scaffold (no
   *  search/grep_context/outline — retrieval belongs to the root). */
  readonly surface?: 'root' | 'child'
  /** Per-repl-block wall-clock timeout inside the worker (seconds). */
  readonly execTimeoutS?: number
  /** Parent-side watchdog per request (ms); on breach the worker is SIGKILLed. */
  readonly requestTimeoutMs?: number
  /** Python executable. */
  readonly python?: string
  /** Handlers for sub-LLM interrupts. Defaults reject. */
  readonly handlers?: Partial<SubcallHandlers>
  /** AbortSignal — immediate SIGKILL on abort, bypassing the shutdown handshake. */
  readonly signal?: AbortSignal
  /** Worker startup wait before init failure (ms). */
  readonly initTimeoutMs?: number
}

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), 'py', 'worker.py')
const STDERR_TAIL_CHARS = 8_192
/** How often to refresh the parent request watchdog (and ping the worker) during silent host work. */
export const SANDBOX_WATCHDOG_HEARTBEAT_MS = 30_000
/** How long dispose() waits for a clean worker exit before escalating to SIGKILL. */
const SHUTDOWN_GRACE_MS = 50

// The sandbox runs untrusted model-authored code; it must never inherit provider secrets.
const SENSITIVE_ENV = /API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|ANTHROPIC|OPENAI|_KEY$/i

function sanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !SENSITIVE_ENV.test(k)) env[k] = v
  }
  return env
}

type Pending = {
  readonly resolve: (res: WorkerResponse) => void
  readonly reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  readonly requestType: string
}

export class PythonSandbox {
  private proc: ChildProcessWithoutNullStreams
  private buf = ''
  private scanOffset = 0
  private seq = 0
  private readonly pending = new Map<string, Pending>()
  private handlers: SubcallHandlers
  private readonly requestTimeoutMs: number
  private readonly initTimeoutMs: number
  /** Bounded stderr tail (chunks, newest last) — avoids rebuilding the buffer per chunk. */
  private readonly stderrTail: string[] = []
  private stderrLen = 0

  /** Bounded tail of everything written to stderr, oldest chunks already dropped. */
  private get stderr(): string {
    return this.stderrTail.join('')
  }

  /** Record a diagnostic on the same bounded tail as real worker stderr. */
  private appendStderr(text: string): void {
    this.stderrTail.push(text)
    this.stderrLen += text.length
    while (this.stderrLen > STDERR_TAIL_CHARS && this.stderrTail.length > 1) {
      this.stderrLen -= (this.stderrTail.shift() ?? '').length
    }
  }
  private disposed = false
  private ready: Promise<void>

  private constructor(opts: SandboxOptions) {
    this.handlers = { ...REJECT, ...opts.handlers }
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 20 * 60_000
    this.initTimeoutMs = opts.initTimeoutMs ?? 30_000
    const python = opts.python ?? 'python3'
    const workerArgs = [
      '-X', 'utf8=1',
      '-u', WORKER_PATH,
      '--depth', String(opts.depth ?? 1),
      '--surface', opts.surface === 'child' ? 'child' : 'root',
      '--timeout', String(opts.execTimeoutS ?? 600),
    ]
    this.proc = spawn(python, workerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: sanitizedEnv(),
      windowsHide: true,
    })

    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk: string) => this.onData(chunk))
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk: string) => this.appendStderr(chunk))

    // A dead worker's pipe fails the write ASYNCHRONOUSLY: node emits 'error' on the stream, and
    // an EventEmitter 'error' with no listener is an uncaughtException. Record and swallow: the
    // real reason is already surfaced by failAll on 'exit'.
    const swallowPipeError = (stream: string) => (err: NodeJS.ErrnoException): void => {
      this.appendStderr(`[rlm] worker ${stream} ${err.code ?? 'error'}: ${err.message}\n`)
    }
    this.proc.stdin.on('error', swallowPipeError('stdin'))
    this.proc.stdout.on('error', swallowPipeError('stdout'))
    this.proc.stderr.on('error', swallowPipeError('stderr'))

    this.proc.on('error', (err: NodeJS.ErrnoException) => {
      const hint =
        err.code === 'ENOENT' ? ` ('${python}' not found — is Python installed and on PATH?)` : ''
      this.failAll(new Error(`failed to start sandbox${hint}: ${err.message}`))
    })
    this.proc.on('exit', (code, signal) =>
      this.failAll(
        new Error(
          `worker exited (${signal !== null ? `signal ${signal}` : `code ${code}`}); ` +
            `stderr=${this.stderr.trim()}`,
        ),
      ),
    )

    this.ready = this.waitForInit()

    if (opts.signal) {
      if (opts.signal.aborted) {
        this.disposed = true
        this.proc.kill('SIGKILL')
        this.failAll(new Error('sandbox aborted'))
      } else {
        opts.signal.addEventListener(
          'abort',
          () => {
            if (!this.disposed) {
              this.disposed = true
              try {
                this.proc.kill('SIGKILL')
              } catch {
                /* already dead */
              }
              this.failAll(new Error('sandbox aborted'))
            }
          },
          { once: true },
        )
      }
    }
  }

  /** Spawn a sandbox and wait until the worker reports it is initialized. */
  static async spawn(opts: SandboxOptions = {}): Promise<PythonSandbox> {
    const sandbox = new PythonSandbox(opts)
    await sandbox.ready
    return sandbox
  }

  /**
   * Load a payload whose pin this sandbox does not own — it acquires and releases one itself.
   */
  async loadContext(payload: unknown): Promise<number> {
    const pinned = await pinContext(payload)
    try {
      return await this.loadContextPinned(pinned)
    } finally {
      await pinned.release()
    }
  }

  /**
   * Load from a pin the CALLER owns and will release. Keeping ownership outside means a run and
   * every child that inherits its payload share one serialization and one file.
   */
  async loadContextPinned(pinned: PinnedContext): Promise<number> {
    const res = await this.request({ type: 'load_context', path: pinned.path, json: pinned.json })
    if (!res.ok) throw new Error(res.error ?? 'load_context failed')
    return res.index ?? 0
  }

  /**
   * Continuation handoff (engine chain): re-install a successor run's sub-call handlers on
   * THIS live worker so a chained engine run can adopt it without a respawn.
   */
  installHandlers(handlers: SubcallHandlers): void {
    this.handlers = { ...REJECT, ...handlers }
  }

  async exec(code: string, signal?: AbortSignal): Promise<ReplResult> {
    const res = await this.request({ type: 'exec', code }, signal)
    if (!res.ok) throw new Error(res.error ?? 'exec failed')
    return {
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
      finalAnswer: res.final_answer ?? null,
      answerContent: res.answer_content ?? '',
      raised: res.raised ?? false,
      executionTimeMs: Math.round((res.execution_time ?? 0) * 1000),
      varNames: res.var_names ?? [],
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    // Handshake only a live worker. The watchdog SIGKILLs before a caller's catch calls
    // dispose(), and writing the shutdown frame to a process that is already dead is exactly
    // what produced the EPIPE that killed the host.
    if (this.workerAlive) {
      this.send({ id: '_shutdown', type: 'shutdown' })
      await once(this.proc, 'exit', { signal: AbortSignal.timeout(SHUTDOWN_GRACE_MS) }).catch(
        () => {
          /* did not exit in time — SIGKILL below */
        },
      )
    }
    if (this.proc.exitCode === null) this.proc.kill('SIGKILL')
    this.failAll(new Error('sandbox disposed'))
  }

  // ---- internals -------------------------------------------------------------------------

  private waitForInit(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('worker did not start in time')), this.initTimeoutMs)
      this.pending.set('_init', {
        resolve: (res) => {
          clearTimeout(timer)
          if (res.ok) resolve()
          else reject(new Error(res.error ?? 'worker init failed'))
        },
        reject,
        timer,
        requestType: 'init',
      })
    })
  }

  private request(payload: RequestPayload, signal?: AbortSignal): Promise<WorkerResponse> {
    if (this.disposed) return Promise.reject(new Error('sandbox disposed'))
    if (signal?.aborted) return Promise.reject(new Error('repl execution aborted'))
    if (!this.workerAlive) {
      return Promise.reject(
        new Error(`worker is not running (${this.exitDescription()}); request '${payload.type}' not sent`),
      )
    }
    const id = `r${++this.seq}`
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timer = this.createWatchdog(id, payload.type, reject)
      // Cancel == kill. The worker may be parked inside `_drain_until` with no other way out;
      // `proc.on("exit") -> failAll` settles this request and a manager's catch recreates the
      // sandbox. REPL variables are lost — the documented price of interrupting.
      const onAbort = (): void => {
        this.pending.delete(id)
        clearTimeout(timer)
        try {
          this.proc.kill('SIGKILL')
        } catch {
          /* already dead */
        }
        reject(new Error('repl execution aborted — REPL variables were reset'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const settled = <T>(value: T): T => {
        signal?.removeEventListener('abort', onAbort)
        return value
      }
      this.pending.set(id, { resolve: settled(resolve), reject: settled(reject), timer, requestType: payload.type })
      this.send({ id, ...payload })
    })
  }

  private createWatchdog(
    id: string,
    requestType: string,
    reject: (err: Error) => void,
  ): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      this.pending.delete(id)
      this.proc.kill('SIGKILL')
      reject(
        new Error(
          `request '${requestType}' exceeded ${this.requestTimeoutMs}ms with no progress; worker killed`,
        ),
      )
    }, this.requestTimeoutMs)
  }

  private touchPending(): void {
    for (const [id, p] of this.pending) {
      if (id === '_init') continue
      clearTimeout(p.timer)
      p.timer = this.createWatchdog(id, p.requestType, p.reject)
    }
  }

  /** Refresh the parent-side request watchdog and ping the worker during long mid-exec work. */
  refreshWatchdog(): void {
    this.touchPending()
    if (this.hasPendingRequest()) this.send({ type: 'heartbeat' })
  }

  /** True when an exec/load_context/shutdown (not the init handshake) is in flight. */
  private hasPendingRequest(): boolean {
    for (const id of this.pending.keys()) {
      if (id !== '_init') return true
    }
    return false
  }

  private send(msg: ParentMessage): void {
    // Never write to a corpse. The write would fail asynchronously and, historically, take the
    // host process with it. MUST NOT throw — `reply()` calls this from serviceInterrupt's catch.
    if (!this.workerAlive) {
      this.appendStderr(`[rlm] dropped '${msg.type}' frame: worker ${this.exitDescription()}\n`)
      return
    }
    const frame = JSON.stringify(msg)
    if (frame.length > MAX_FRAME_CHARS) {
      this.appendStderr(`[rlm] dropped '${msg.type}' frame: ${frame.length} chars exceed the frame cap\n`)
      return
    }
    this.proc.stdin.write(`${frame}\n`)
  }

  /** False once the worker is gone — exited, signalled, or its stdin torn down. */
  private get workerAlive(): boolean {
    return (
      this.proc.exitCode === null &&
      this.proc.signalCode === null &&
      this.proc.stdin.writable
    )
  }

  /** How the worker went away, for diagnostics. */
  private exitDescription(): string {
    if (this.proc.signalCode !== null) return `killed by ${this.proc.signalCode}`
    if (this.proc.exitCode !== null) return `exited with code ${this.proc.exitCode}`
    return 'stdin closed'
  }

  private onData(chunk: string): void {
    this.buf += chunk
    // Untrusted-stream guard: a worker that stops emitting newlines would otherwise balloon
    // this buffer without bound and stall the pump.
    if (this.buf.length > MAX_FRAME_CHARS) {
      this.appendStderr(`\n[protocol] stdout buffer exceeded ${MAX_FRAME_CHARS} chars without a newline — truncated\n`)
      this.buf = ''
      this.scanOffset = 0
    }
    let nl: number
    while ((nl = this.buf.indexOf('\n', this.scanOffset)) >= 0) {
      const line = this.buf.slice(this.scanOffset, nl).trim()
      this.scanOffset = nl + 1
      if (line) {
        try {
          const message = JSON.parse(line) as unknown
          if (isWorkerMessage(message)) this.dispatch(message)
          else this.appendStderr(`\n[protocol] skipped invalid stdout message: ${line.slice(0, 200)}`)
        } catch {
          this.appendStderr(`\n[protocol] skipped non-JSON stdout line: ${line.slice(0, 200)}`)
        }
      }
    }
    // Drop the processed prefix to avoid O(n²) growth across chunks.
    if (this.scanOffset > 0) {
      this.buf = this.buf.slice(this.scanOffset)
      this.scanOffset = 0
    }
  }

  private dispatch(msg: WorkerMessage): void {
    if (isInterrupt(msg)) {
      this.touchPending()
      void serviceInterrupt(msg, this.handlers, (rid, body) => this.reply(rid, body))
      return
    }
    const p = this.pending.get(msg.id)
    if (!p) return
    this.pending.delete(msg.id)
    clearTimeout(p.timer)
    p.resolve(msg)
  }

  private reply(rid: string, body: ReplyBody): void {
    if (!this.disposed) this.send({ type: 'llm_reply', rid, ...body })
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
  }
}