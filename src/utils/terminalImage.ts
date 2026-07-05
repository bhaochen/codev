import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Buffer } from 'buffer'
import { env } from './env.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { wrapForMultiplexer } from '../ink/termio/osc.js'
import { which, whichSync } from './which.js'

export type ImageProtocol = 'kitty' | null

/** Is the terminal inside tmux? */
export function isInsideTmux(): boolean {
  return !!process.env.TMUX
}

const KITTY_IMAGE_CHUNK_SIZE = 4096

// Image format codes for Kitty protocol
const KITTY_FORMAT_CODES: Record<string, number> = {
  png: 100,
  jpeg: 101,
  jpg: 101,
  gif: 102,
  webp: 103,
}

/**
 * Detect whether the current terminal supports inline image display via
 * the Kitty graphics protocol. Kitty, WezTerm, Konsole, foot, and
 * Ghostty all support it.
 */
export function supportsImageProtocol(): boolean {
  return detectImageProtocol() !== null
}

/**
 * Detect the best available terminal image protocol.
 * Currently only supports the Kitty protocol.
 *
 * Returns `'kitty'` or `null` if no protocol is available.
 */
export function detectImageProtocol(): ImageProtocol {
  const term = env.terminal ?? ''

  // Explicit TERM check for Kitty (TERM=xterm-kitty or TERM contains kitty)
  if (process.env.TERM?.includes('kitty')) return 'kitty'
  if (process.env.KITTY_WINDOW_ID) return 'kitty'

  // TERM_PROGRAM-based detection
  switch (term) {
    case 'kitty':
    case 'WezTerm':
    case 'konsole':
    case 'ghostty':
    case 'foot':
      return 'kitty'
  }

  return null
}

/**
 * Get the Kitty protocol format code for a given image format string.
 * Defaults to PNG (100) for unknown formats.
 */
function getKittyFormatCode(format: string): number {
  return KITTY_FORMAT_CODES[format.toLowerCase()] ?? 100
}

/**
 * Encode an image buffer into Kitty graphics protocol escape sequences.
 *
 * Large images are split into chunks of KITTY_IMAGE_CHUNK_SIZE bytes
 * to avoid overflowing terminal input buffers.
 *
 * @param buffer - Raw image data
 * @param format - Image format (png, jpeg, gif, webp)
 * @returns Kitty protocol escape sequence
 */
export function encodeKittyImage(buffer: Buffer, format: string): string {
  const f = getKittyFormatCode(format)
  const b64 = buffer.toString('base64')
  const parts: string[] = []

  if (b64.length <= KITTY_IMAGE_CHUNK_SIZE) {
    // Single chunk — no splitting needed
    parts.push(`\x1b_Ga=d,f=${f},m=0;${b64}\x1b\\`)
  } else {
    // Split into multiple chunks
    let offset = 0
    while (offset < b64.length) {
      const chunk = b64.slice(offset, offset + KITTY_IMAGE_CHUNK_SIZE)
      const isLast = offset + KITTY_IMAGE_CHUNK_SIZE >= b64.length
      parts.push(`\x1b_Ga=d,f=${f},m=${isLast ? 0 : 1};${chunk}\x1b\\`)
      offset += KITTY_IMAGE_CHUNK_SIZE
    }
  }

  const sequence = parts.join('')

  // Wrap for tmux/screen multiplexer passthrough if needed
  return wrapForMultiplexer(sequence)
}

/**
 * Generate a terminal image display sequence for an image buffer.
 * Picks the best protocol for the current terminal.
 *
 * @param buffer - Raw image data
 * @param format - Image format (png, jpeg, gif, webp)
 * @returns The escape sequence to write to stdout, or null if no protocol available
 */
export function encodeImageForTerminal(
  buffer: Buffer,
  format: string,
): string | null {
  const protocol = detectImageProtocol()
  if (protocol === 'kitty') {
    return encodeKittyImage(buffer, format)
  }
  return null
}

/**
 * Image protocol capabilities summary (for debugging/logging).
 */
export function getImageProtocolSummary(): string {
  const protocol = detectImageProtocol()
  if (protocol === 'kitty') return 'kitty'
  return 'none'
}

/**
 * Render an image using the `timg` utility with Unicode block characters.
 * Works in any terminal that supports Unicode and 24-bit color (virtually all
 * modern terminals). Falls back gracefully if timg is not installed.
 *
 * The image is rendered using quarter-block characters ("pixelation q") for
 * the best quality-to-compatibility ratio. If timg fails, half-blocks are
 * tried as a fallback.
 *
 * @param buffer - The raw image buffer (decoded)
 * @param format - Image format (png, jpeg, gif, webp)
 * @param columns - Optional terminal width in character columns (auto-detected)
 * @param rows - Optional terminal height in character rows (auto-detected)
 * @returns ANSI escape sequence string for rendering, or null on failure
 */
export async function renderImageWithTimg(
  buffer: Buffer,
  format: string,
  columns?: number,
  rows?: number,
): Promise<string | null> {
  try {
    const timgPath = await which('timg')
    if (!timgPath) return null

    const cols = columns ?? process.stdout.columns ?? 80
    const termRows = rows ?? process.stdout.rows ?? 40
    const tmpDir = mkdtempSync(join(tmpdir(), 'codev-timg-'))
    const ext = format === 'jpeg' ? 'jpg' : format
    const tmpFile = join(tmpDir, `image.${ext}`)
    let result: string | null = null

    // Use at most half the terminal height so the image doesn't dominate
    const maxRows = Math.max(10, Math.floor(termRows * 0.5))

    try {
      writeFileSync(tmpFile, buffer)

      // Try quarter blocks first (4 pixels per cell, better quality)
      const quarter = await execFileNoThrow(
        timgPath,
        ['-p', 'q', '-g', `${cols}x${maxRows}`, tmpFile],
        { timeout: 15000, preserveOutputOnError: true },
      )
      if (quarter.code === 0 && quarter.stdout) {
        result = quarter.stdout
      }

      // Fallback to half blocks (2 pixels per cell, max compatibility)
      if (!result) {
        const half = await execFileNoThrow(
          timgPath,
          ['-p', 'h', '-g', `${cols}x${maxRows}`, tmpFile],
          { timeout: 15000, preserveOutputOnError: true },
        )
        if (half.code === 0 && half.stdout) {
          result = half.stdout
        }
      }
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }

    return result
  } catch {
    return null
  }
}

/**
 * Synchronous version of renderImageWithTimg. Blocks the event loop while
 * spawning timg, which prevents Ink from rendering between the tool call
 * and the image output — eliminating cursor-position races.
 *
 * @see renderImageWithTimg
 */
export function renderImageWithTimgSync(
  buffer: Buffer,
  format: string,
  columns?: number,
  rows?: number,
): string | null {
  try {
    const timgPath = whichSync('timg')
    if (!timgPath) return null

    const cols = columns ?? process.stdout.columns ?? 80
    const termRows = rows ?? process.stdout.rows ?? 40
    const maxRows = Math.max(10, Math.floor(termRows * 0.5))
    const tmpDir = mkdtempSync(join(tmpdir(), 'codev-timg-'))
    const ext = format === 'jpeg' ? 'jpg' : format
    const tmpFile = join(tmpDir, `image.${ext}`)
    let result: string | null = null

    try {
      writeFileSync(tmpFile, buffer)

      // Try quarter blocks first (4 pixels per cell, better quality)
      try {
        const stdout = execFileSync(
          timgPath,
          ['-p', 'q', '-g', `${cols}x${maxRows}`, tmpFile],
          { encoding: 'utf8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
        )
        if (stdout) result = stdout
      } catch {
        // fall through to half blocks
      }

      // Fallback to half blocks (2 pixels per cell, max compatibility)
      if (!result) {
        try {
          const stdout = execFileSync(
            timgPath,
            ['-p', 'h', '-g', `${cols}x${maxRows}`, tmpFile],
            { encoding: 'utf8', timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
          )
          if (stdout) result = stdout
        } catch {
          // ignored
        }
      }
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }

    return result
  } catch {
    return null
  }
}
