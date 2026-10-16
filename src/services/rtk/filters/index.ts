/**
 * RTK Compression Filters — Per-tool-type content compressors.
 *
 * Each filter handles a specific tool output type:
 * - Bash output: truncate long output, preserve exit code and errors
 * - Grep results: limit match count, preserve file paths
 * - Git diff: compress context lines, preserve changed lines
 * - File read: preserve structure, truncate very long files
 * - Directory listing: collapse redundant entries
 */
import type { RTKFilter, RTKToolContext, CompressionResult } from '../RTKCompressor.js'

// ============================================================================
// Bash Output Filter
// ============================================================================

export class BashOutputFilter implements RTKFilter {
  id = 'bash-output'
  private maxLines = 100
  private maxChars = 10000

  matches(context: RTKToolContext): boolean {
    return context.toolName === 'bash' || context.toolName === 'BashTool'
  }

  compress(context: RTKToolContext, content: string): CompressionResult {
    const lines = content.split('\n')
    const wasTruncated = lines.length > this.maxLines || content.length > this.maxChars

    let compressed = content
    if (lines.length > this.maxLines) {
      const head = lines.slice(0, 50).join('\n')
      const tail = lines.slice(-50).join('\n')
      compressed = `${head}\n... [${lines.length - 100} lines truncated] ...\n${tail}`
    }

    if (compressed.length > this.maxChars) {
      compressed = compressed.slice(0, this.maxChars) + '\n... [truncated]'
    }

    // Preserve error information
    if (context.isError && context.exitCode !== undefined) {
      compressed = `[exit: ${context.exitCode}] ${compressed}`
    }

    return {
      content: compressed,
      compressed: wasTruncated,
      strategy: this.id,
      originalBytes: new TextEncoder().encode(content).length,
      outputBytes: new TextEncoder().encode(compressed).length,
      truncated: wasTruncated,
    }
  }
}

// ============================================================================
// Grep Result Filter
// ============================================================================

export class GrepResultFilter implements RTKFilter {
  id = 'grep-result'
  private maxMatches = 50

  matches(context: RTKToolContext): boolean {
    return context.toolName === 'grep' || context.toolName === 'GrepTool'
  }

  compress(context: RTKToolContext, content: string): CompressionResult {
    const lines = content.split('\n').filter(l => l.trim())
    const wasTruncated = lines.length > this.maxMatches

    let compressed = content
    if (wasTruncated) {
      const shown = lines.slice(0, this.maxMatches).join('\n')
      compressed = `${shown}\n... [${lines.length - this.maxMatches} more matches]`
    }

    return {
      content: compressed,
      compressed: wasTruncated,
      strategy: this.id,
      originalBytes: new TextEncoder().encode(content).length,
      outputBytes: new TextEncoder().encode(compressed).length,
      truncated: wasTruncated,
    }
  }
}

// ============================================================================
// Git Diff Filter
// ============================================================================

export class GitDiffFilter implements RTKFilter {
  id = 'git-diff'
  private contextLines = 3

  matches(context: RTKToolContext): boolean {
    const command = context.toolInput?.command
    return context.toolName === 'bash' && typeof command === 'string' && command.includes('git diff')
  }

  compress(context: RTKToolContext, content: string): CompressionResult {
    // For git diff, we preserve all changes but reduce context
    const lines = content.split('\n')
    const compressed = lines.filter(line => {
      // Keep diff headers, added/removed lines, and limited context
      return line.startsWith('diff --git') ||
             line.startsWith('@@') ||
             line.startsWith('+') ||
             line.startsWith('-') ||
             line.startsWith(' ') && line.trim().length > 0
    }).join('\n')

    const wasTruncated = compressed.length < content.length

    return {
      content: compressed,
      compressed: wasTruncated,
      strategy: this.id,
      originalBytes: new TextEncoder().encode(content).length,
      outputBytes: new TextEncoder().encode(compressed).length,
      truncated: wasTruncated,
    }
  }
}

// ============================================================================
// File Read Filter
// ============================================================================

export class FileReadFilter implements RTKFilter {
  id = 'file-read'
  private maxLines = 500

  matches(context: RTKToolContext): boolean {
    return context.toolName === 'read_file' || 
           context.toolName === 'ReadTool' ||
           context.toolName === 'file_read'
  }

  compress(context: RTKToolContext, content: string): CompressionResult {
    const lines = content.split('\n')
    const wasTruncated = lines.length > this.maxLines

    let compressed = content
    if (wasTruncated) {
      const head = lines.slice(0, 250).join('\n')
      const tail = lines.slice(-250).join('\n')
      compressed = `${head}\n... [${lines.length - 500} lines truncated — use offset/limit to read specific sections] ...\n${tail}`
    }

    return {
      content: compressed,
      compressed: wasTruncated,
      strategy: this.id,
      originalBytes: new TextEncoder().encode(content).length,
      outputBytes: new TextEncoder().encode(compressed).length,
      truncated: wasTruncated,
    }
  }
}

// ============================================================================
// Directory Listing Filter
// ============================================================================

export class DirectoryListingFilter implements RTKFilter {
  id = 'directory-listing'
  private maxEntries = 30

  matches(context: RTKToolContext): boolean {
    return context.toolName === 'list_dir' || 
           context.toolName === 'GlobTool' ||
           context.toolName === 'ls'
  }

  compress(context: RTKToolContext, content: string): CompressionResult {
    const lines = content.split('\n').filter(l => l.trim())
    const wasTruncated = lines.length > this.maxEntries

    let compressed = content
    if (wasTruncated) {
      const shown = lines.slice(0, this.maxEntries).join('\n')
      compressed = `${shown}\n... [${lines.length - this.maxEntries} more entries]`
    }

    return {
      content: compressed,
      compressed: wasTruncated,
      strategy: this.id,
      originalBytes: new TextEncoder().encode(content).length,
      outputBytes: new TextEncoder().encode(compressed).length,
      truncated: wasTruncated,
    }
  }
}

// ============================================================================
// Default Filter (fallback)
// ============================================================================

export class DefaultFilter implements RTKFilter {
  id = 'default'
  private maxChars = 50000

  matches(context: RTKToolContext): boolean {
    return true  // Catch-all
  }

  compress(context: RTKToolContext, content: string): CompressionResult {
    const wasTruncated = content.length > this.maxChars

    let compressed = content
    if (wasTruncated) {
      compressed = content.slice(0, this.maxChars) + '\n... [truncated — use specific tools to access full content]'
    }

    return {
      content: compressed,
      compressed: wasTruncated,
      strategy: this.id,
      originalBytes: new TextEncoder().encode(content).length,
      outputBytes: new TextEncoder().encode(compressed).length,
      truncated: wasTruncated,
    }
  }
}

// ============================================================================
// Filter Registry
// ============================================================================

export function createDefaultFilters(): RTKFilter[] {
  return [
    new BashOutputFilter(),
    new GrepResultFilter(),
    new GitDiffFilter(),
    new FileReadFilter(),
    new DirectoryListingFilter(),
    new DefaultFilter(),  // Must be last
  ]
}
