/**
 * Minimal SSE framing — Phase 5.
 * Raw bytes → SSE events, no OpenAI/Anthropic awareness.
 * Correctly handles chunk boundaries (a Uint8Array chunk ≠ one event).
 */

export type RawSSEEvent = {
  /** Optional event name (from `event:` field) */
  event?: string
  /** Concatenated data lines (from `data:` fields, joined with \n) */
  data: string
}

/**
 * Parse a ReadableStream<Uint8Array> SSE stream into RawSSEEvent.
 * Handles:
 * - \n and \r\n line endings
 * - chunk split in middle of line
 * - multiple data lines per event joined with \n
 * - blank line delimits event
 * - `:` comment lines ignored
 * - `data: [DONE]` preserved as data (caller decides to stop)
 */
export async function* parseSSERaw(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<RawSSEEvent, void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | undefined
  let dataLines: string[] = []

  const dispatch = function* (): Generator<RawSSEEvent> {
    if (dataLines.length === 0) {
      event = undefined
      return
    }
    const data = dataLines.join('\n')
    dataLines = []
    const ev = event
    event = undefined
    yield { event: ev, data }
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        buffer += decoder.decode()
        // flush remaining buffer as lines
        const lines = buffer.split(/\r?\n/)
        for (const line of lines) {
          if (line === '') {
            for (const ev of dispatch()) yield ev
          } else if (line.startsWith('event:')) {
            event = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            // per spec, strip single leading space after colon
            const d = line.slice(5)
            dataLines.push(d.startsWith(' ') ? d.slice(1) : d)
          } else if (line.startsWith(':')) {
            // comment, ignore
          }
        }
        for (const ev of dispatch()) yield ev
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (line === '') {
          for (const ev of dispatch()) yield ev
        } else if (line.startsWith('event:')) {
          event = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          const d = line.slice(5)
          dataLines.push(d.startsWith(' ') ? d.slice(1) : d)
        } else if (line.startsWith(':')) {
          // comment
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * OpenAI-compatible SSE chunk parser built on raw framing.
 * Yields parsed JSON chunks, skips invalid JSON and `[DONE]`.
 * Equivalent to previous `parseOpenAIStream` but now via framing layer.
 */
export async function* parseOpenAIChunksFromSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown> & { choices?: Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }>; usage?: unknown }, void> {
  for await (const ev of parseSSERaw(stream)) {
    const data = ev.data.trim()
    if (data === '' || data === '[DONE]') continue
    try {
      yield JSON.parse(data) as never
    } catch {
      continue
    }
  }
}
