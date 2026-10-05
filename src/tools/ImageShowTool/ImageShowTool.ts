import fs from 'node:fs'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { IMAGE_SHOW_TOOL_NAME, DESCRIPTION } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
} from './UI.js'

// ── Types ──

export interface ImageShowOutput {
  src: string
  success: boolean
  /** Raw image bytes, base64-encoded, for the transcript renderer. */
  base64?: string
  /** Byte length of the decoded image, for the summary line. */
  bytes?: number
  /** Why the image could not be loaded. */
  error?: string
}

// ── Utilities ──

export function isUrl(path: string): boolean {
  return path.startsWith('http://') || path.startsWith('https://')
}

/**
 * Largest image the tool will load.
 *
 * The result is base64-encoded into the tool result and held in the transcript
 * for the life of the session, and the renderer decodes and rescales it again
 * on every mount. A hundred-megabyte source would cost several times that, so
 * the ceiling is a guard rather than a limit anyone reaches in practice.
 */
export const MAX_IMAGE_BYTES = 48 * 1024 * 1024

/**
 * Load image bytes from a local path or an HTTP(S) URL.
 *
 * A URL is fetched straight into memory rather than staged through a temp file:
 * the bytes are all the result needs, since rendering happens in-process from
 * the base64 payload. That removes the temp-file dance the previous mechanism
 * needed to hand a path to an external converter.
 */
export async function loadImageBytes(src: string): Promise<Buffer> {
  if (isUrl(src)) {
    const res = await fetch(src, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Codev/1.0)',
        Accept: 'image/*',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buffer = Buffer.from(await res.arrayBuffer())
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(
        `image is ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit`,
      )
    }
    return buffer
  }

  const stats = fs.statSync(src)
  if (!stats.isFile()) throw new Error(`not a file: ${src}`)
  if (stats.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `image is ${(stats.size / 1024 / 1024).toFixed(1)}MB, over the ${MAX_IMAGE_BYTES / 1024 / 1024}MB limit`,
    )
  }
  return fs.readFileSync(src)
}

// ── Tool definition ──

const inputSchema = lazySchema(() =>
  z.strictObject({
    src: z.string().describe('Image source — local file path or HTTPS URL'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    src: z.string(),
    success: z.boolean(),
    base64: z.string().optional(),
    bytes: z.number().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const ImageShowTool = buildTool({
  name: IMAGE_SHOW_TOOL_NAME,
  searchHint: 'display an image in the terminal',
  maxResultSizeChars: 10_000,
  shouldDefer: false,
  async description(input) {
    const { src } = input as { src: string }
    try {
      const url = new URL(src)
      return `Codev wants to display image from ${url.hostname}`
    } catch {
      return `Codev wants to display image: ${src}`
    }
  },
  userFacingName() {
    return 'Image'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const { src } = input as { src: string }
    try {
      const url = new URL(src)
      return `Showing image from ${url.hostname}`
    } catch {
      return `Showing image: ${src}`
    }
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async checkPermissions(_input, _context): Promise<PermissionDecision> {
    return {
      behavior: 'allow',
      updatedInput: _input,
      decisionReason: { type: 'other', reason: 'ImageShowTool is read-only' },
    }
  },
  async prompt(_options) {
    return DESCRIPTION
  },
  async validateInput(input) {
    const { src } = input
    if (!src || src.trim().length === 0) {
      return {
        result: false,
        message: 'Error: "src" is required and cannot be empty.',
        meta: { reason: 'missing_src' },
        errorCode: 1,
      }
    }
    return { result: true }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call({ src }) {
    try {
      const buffer = await loadImageBytes(src)
      if (buffer.byteLength === 0) throw new Error('image is empty')
      return {
        data: {
          src,
          success: true,
          base64: buffer.toString('base64'),
          bytes: buffer.byteLength,
        } satisfies ImageShowOutput,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        data: {
          src,
          success: false,
          error: message,
        } satisfies ImageShowOutput,
      }
    }
  },
  mapToolResultToToolResultBlockParam(output: ImageShowOutput, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        {
          type: 'text',
          text: output.success
            ? `Image displayed: ${output.src}`
            : `Failed to display image: ${output.src}${output.error ? ` (${output.error})` : ''}`,
        },
      ],
    }
  },
} satisfies ToolDef<InputSchema, ImageShowOutput>)
