import WebSocket from 'ws'

/**
 * Minimal Chrome DevTools Protocol client over a single browser-level
 * WebSocket connection. Page targets are driven through flattened sessions
 * (`Target.attachToTarget` with `flatten: true`), so one socket serves the
 * browser and every tab; commands carry an optional `sessionId`.
 */

interface CdpResponse {
  id?: number
  method?: string
  sessionId?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: string }
}

type EventListener = (params: never, sessionId?: string) => void

export class CdpError extends Error {
  constructor(method: string, message: string, data?: string) {
    super(`CDP ${method}: ${message}${data ? ` (${data})` : ''}`)
    this.name = 'CdpError'
  }
}

export class CdpClient {
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; method: string }
  >()
  private listeners = new Map<string, Set<EventListener>>()
  private closeCallbacks = new Set<() => void>()
  private closed = false

  private constructor(private ws: WebSocket) {
    ws.on('message', (data: unknown) => this.handleMessage(String(data)))
    ws.on('close', () => this.handleClose())
    ws.on('error', () => this.handleClose())
  }

  static connect(wsUrl: string, timeoutMs = 10_000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      // CDP messages (full-page observations, screenshots) can be large;
      // raise the frame cap well beyond ws's needs to avoid hard failures.
      const ws = new WebSocket(wsUrl, {
        maxPayload: 256 * 1024 * 1024,
        perMessageDeflate: false,
      })
      const timer = setTimeout(() => {
        ws.terminate()
        reject(new Error(`Timed out connecting to browser at ${wsUrl}`))
      }, timeoutMs)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve(new CdpClient(ws))
      })
      ws.once('error', (error: unknown) => {
        clearTimeout(timer)
        reject(
          new Error(
            `Could not connect to browser DevTools socket: ${error instanceof Error ? error.message : String(error)}`,
          ),
        )
      })
    })
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN
  }

  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (!this.isOpen) {
      return Promise.reject(
        new Error('Browser connection is closed. Reopen the browser with the open action.'),
      )
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: value => {
          clearTimeout(timer)
          resolve(value as T)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.ws.send(
        JSON.stringify({ id, method, params: params ?? {}, sessionId }),
        (error?: Error) => {
          if (error) {
            const entry = this.pending.get(id)
            this.pending.delete(id)
            entry?.reject(new Error(`CDP send failed: ${error.message}`))
          }
        },
      )
    })
  }

  on(method: string, listener: EventListener): void {
    let set = this.listeners.get(method)
    if (!set) {
      set = new Set()
      this.listeners.set(method, set)
    }
    set.add(listener)
  }

  off(method: string, listener: EventListener): void {
    this.listeners.get(method)?.delete(listener)
  }

  onClose(callback: () => void): void {
    this.closeCallbacks.add(callback)
  }

  /**
   * Waits for one occurrence of an event on the given session. Resolves with
   * the event params, or null on timeout (timeouts are an expected outcome
   * for navigation waits, not an error).
   */
  waitForEvent<T>(
    method: string,
    sessionId: string | undefined,
    timeoutMs: number,
    predicate?: (params: T) => boolean,
  ): Promise<T | null> {
    return new Promise(resolve => {
      const listener = ((params: T, eventSessionId?: string) => {
        if (sessionId !== undefined && eventSessionId !== sessionId) return
        if (predicate && !predicate(params)) return
        cleanup()
        resolve(params)
      }) as EventListener
      const timer = setTimeout(() => {
        cleanup()
        resolve(null)
      }, timeoutMs)
      const onConnectionClose = () => {
        cleanup()
        resolve(null)
      }
      const cleanup = () => {
        clearTimeout(timer)
        this.off(method, listener)
        this.closeCallbacks.delete(onConnectionClose)
      }
      this.on(method, listener)
      this.closeCallbacks.add(onConnectionClose)
    })
  }

  close(): void {
    this.closed = true
    try {
      this.ws.close()
    } catch {
      // Socket may already be gone.
    }
    this.handleClose()
  }

  private handleMessage(raw: string): void {
    let message: CdpResponse
    try {
      message = JSON.parse(raw) as CdpResponse
    } catch {
      return
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) {
        entry.reject(
          new CdpError(entry.method, message.error.message, message.error.data),
        )
      } else {
        entry.resolve(message.result)
      }
      return
    }
    if (message.method) {
      const set = this.listeners.get(message.method)
      if (set) {
        for (const listener of set) {
          try {
            listener(message.params as never, message.sessionId)
          } catch {
            // Listener errors must not break message dispatch.
          }
        }
      }
    }
  }

  private handleClose(): void {
    if (this.closed && this.pending.size === 0 && this.closeCallbacks.size === 0) {
      return
    }
    this.closed = true
    for (const [, entry] of this.pending) {
      entry.reject(new Error('Browser connection closed'))
    }
    this.pending.clear()
    const callbacks = [...this.closeCallbacks]
    this.closeCallbacks.clear()
    for (const callback of callbacks) {
      try {
        callback()
      } catch {
        // Close callbacks are best-effort.
      }
    }
  }
}
