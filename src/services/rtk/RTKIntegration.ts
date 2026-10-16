/**
 * RTK Integration — Hook into recordTranscript to compress tool results.
 *
 * Integration point: After cleanMessagesForLogging (which filters and transforms
 * messages for persistence), before insertMessageChain (which writes to storage).
 *
 * Design:
 * - Original messages are NOT modified — compressed copies are created
 * - Original content is stored as artifact with reference
 * - Both compressed and original are persisted (compressed for model context,
 *   original for debugging/audit)
 * - Compression is traceable: strategy, sizes, and artifact ref are recorded
 */
import type { Message } from '../../types/message.js'
import type { RTKToolContext, CompressionResult } from './RTKCompressor.js'
import { RTKCompressor, InMemoryArtifactStore } from './RTKCompressor.js'
import { createDefaultFilters } from './filters/index.js'
import { getSessionId } from '../../bootstrap/state.js'

// Singleton instances
let compressor: RTKCompressor | null = null

function getCompressor(): RTKCompressor {
  if (!compressor) {
    compressor = new RTKCompressor(new InMemoryArtifactStore())
    for (const filter of createDefaultFilters()) {
      compressor.registerFilter(filter)
    }
  }
  return compressor
}

/**
 * Extract tool result content from a message for compression.
 * Returns null if the message has no compressible tool results.
 */
function extractToolResultContext(message: Message): RTKToolContext | null {
  if (message.type !== 'user') return null
  const content = message.message?.content
  if (!Array.isArray(content)) return null

  const toolResultBlock = content.find(
    (block): block is { type: 'tool_result'; tool_use_id: string; content: string | Array<{ type: string; text?: string }>; is_error?: boolean } =>
      block.type === 'tool_result',
  )
  if (!toolResultBlock) return null

  const rawContent = typeof toolResultBlock.content === 'string'
    ? toolResultBlock.content
    : Array.isArray(toolResultBlock.content)
      ? toolResultBlock.content.map(b => b.text ?? '').join('\n')
      : ''

  // Determine tool name from context (this is simplified — production should
  // pass actual tool name from the execution context)
  const toolName = inferToolName(rawContent)
  const isError = toolResultBlock.is_error ?? false

  return {
    toolName,
    isError,
    originalContent: rawContent,
    sessionId: getSessionId() as string,
    toolUseId: toolResultBlock.tool_use_id,
  }
}

/**
 * Infer tool name from content patterns.
 * Production: pass actual tool name from ToolUseContext.
 */
function inferToolName(content: string): string {
  // Simple heuristics — replace with actual tool metadata in production
  if (content.startsWith('exit:') || content.includes('$ ')) return 'bash'
  if (content.startsWith('diff --git') || content.includes('@@')) return 'git-diff'
  if (content.includes('├──') || content.includes('└──')) return 'list-dir'
  return 'unknown'
}

/**
 * Compress tool results in a message array.
 * Returns new messages with compressed tool results + artifact references.
 * Original messages are preserved unchanged.
 */
export function compressMessages(messages: Message[]): {
  messages: Message[]
  compressedCount: number
  totalSavingsBytes: number
} {
  const comp = getCompressor()
  let compressedCount = 0
  let totalSavingsBytes = 0

  const compressedMessages = messages.map(message => {
    // extractToolResultContext only produces a context for user messages (and
    // returns null otherwise); narrowing here lets the compiler see the
    // `.message` member that only user/assistant messages carry.
    if (message.type !== 'user') return message
    const context = extractToolResultContext(message)
    if (!context) return message

    const result = comp.compress(context)
    if (!result.compressed) return message

    compressedCount++
    totalSavingsBytes += result.originalBytes - result.outputBytes

    // Create compressed message — preserve original, add compressed version
    // The compressed version goes into the model-visible content
    // The original is preserved in the artifact store
    return {
      ...message,
      message: {
        ...message.message,
        content: Array.isArray(message.message.content)
          ? message.message.content.map(block =>
              block.type === 'tool_result'
                ? {
                    ...block,
                    content: result.content + (result.rawOutputRef ? `\n[full output: ${result.rawOutputRef}]` : ''),
                  }
                : block,
            )
          : message.message.content,
      },
    }
  })

  return {
    messages: compressedMessages,
    compressedCount,
    totalSavingsBytes,
  }
}

/**
 * Hook for recordTranscript — call after cleanMessagesForLogging,
 * before insertMessageChain.
 */
export function rtkCompressMessages(messages: Message[]): Message[] {
  const result = compressMessages(messages)
  if (result.compressedCount > 0) {
    // In production: log compression stats via SessionLogger
    // logger.debug(`RTK: compressed ${result.compressedCount} tool results, saved ${result.totalSavingsBytes} bytes`)
  }
  return result.messages
}
