/**
 * RTK Token Saver — Compress tool results for model context.
 *
 * Design principles:
 * 1. NEVER overwrite original data — compressed content includes reference to original
 * 2. Use tool metadata (tool name, params) for filter selection, not content guessing
 * 3. Preserve error structure — compress but keep exit codes, key exceptions
 * 4. File content compression requires explicit diff baseline
 * 5. All compression is traceable and recoverable
 *
 * Integration point: After tool execution, before constructing model context.
 * Original results remain in session storage; only model-visible content is compressed.
 */

// ============================================================================
// Types
// ============================================================================

export interface CompressionResult {
  /** Compressed content for model context */
  content: string
  /** Whether compression was applied */
  compressed: boolean
  /** Strategy used for compression */
  strategy: string
  /** Original content size in bytes */
  originalBytes: number
  /** Compressed content size in bytes */
  outputBytes: number
  /** Whether content was truncated */
  truncated: boolean
  /** Reference to original content (session storage path or artifact ID) */
  rawOutputRef?: string
}

export interface RTKToolContext {
  /** Tool name (e.g., 'bash', 'read_file', 'grep') */
  toolName: string
  /** Tool input parameters */
  toolInput?: Record<string, unknown>
  /** Whether the tool returned an error */
  isError: boolean
  /** Exit code for shell commands */
  exitCode?: number
  /** Original tool output */
  originalContent: string
  /** Session ID for storing original content */
  sessionId: string
  /** Tool use ID for reference */
  toolUseId: string
}

export interface RTKFilter {
  /** Unique filter identifier */
  id: string
  /** Check if this filter applies to the given tool context */
  matches(context: RTKToolContext): boolean
  /** Compress the content */
  compress(context: RTKToolContext, content: string): CompressionResult
}

// ============================================================================
// Compressor Engine
// ============================================================================

export class RTKCompressor {
  private filters: RTKFilter[] = []
  private artifactStore: ArtifactStore

  constructor(artifactStore: ArtifactStore) {
    this.artifactStore = artifactStore
  }

  registerFilter(filter: RTKFilter): void {
    this.filters.push(filter)
  }

  /**
   * Compress tool result for model context.
   * Stores original content as artifact and returns compressed version with reference.
   */
  compress(context: RTKToolContext): CompressionResult {
    const originalBytes = new TextEncoder().encode(context.originalContent).length

    // Find matching filter
    const filter = this.filters.find(f => f.matches(context))

    if (!filter) {
      // No compression — return as-is
      return {
        content: context.originalContent,
        compressed: false,
        strategy: 'none',
        originalBytes,
        outputBytes: originalBytes,
        truncated: false,
      }
    }

    // Store original content as artifact
    const artifactRef = this.artifactStore.store({
      sessionId: context.sessionId,
      toolUseId: context.toolUseId,
      toolName: context.toolName,
      content: context.originalContent,
      timestamp: Date.now(),
    })

    // Apply compression
    const result = filter.compress(context, context.originalContent)

    return {
      ...result,
      originalBytes,
      rawOutputRef: artifactRef,
    }
  }

  /**
   * Retrieve original content from artifact reference.
   */
  retrieveOriginal(artifactRef: string): string | null {
    return this.artifactStore.retrieve(artifactRef)
  }
}

// ============================================================================
// Artifact Store (for original content)
// ============================================================================

export interface Artifact {
  ref: string
  sessionId: string
  toolUseId: string
  toolName: string
  content: string
  timestamp: number
}

export interface ArtifactStore {
  store(artifact: Omit<Artifact, 'ref'>): string
  retrieve(ref: string): string | null
}

/**
 * Simple in-memory artifact store.
 * Production implementation should use file-based or SQLite storage.
 */
export class InMemoryArtifactStore implements ArtifactStore {
  private artifacts = new Map<string, Artifact>()
  private counter = 0

  store(artifact: Omit<Artifact, 'ref'>): string {
    const ref = `artifact-${++this.counter}-${Date.now()}`
    this.artifacts.set(ref, { ...artifact, ref })
    return ref
  }

  retrieve(ref: string): string | null {
    return this.artifacts.get(ref)?.content ?? null
  }
}
