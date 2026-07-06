import { homedir } from 'os'
import React from 'react'
import { z } from 'zod/v4'
import { Jimp } from 'jimp'
import { Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import Image, { InkPictureProvider, type TerminalInfo } from 'src/ink-picture/index.ts'
import { loadImageFromUrl } from 'src/ink-picture/utils/jimpURL.ts'

const IMAGE_TOOL_NAME = 'ImageShow'

const inputSchema = () =>
  z.strictObject({
    url: z
      .string()
      .describe(
        'Image URL (https://...) or local file path (e.g. /tmp/image.png). ' +
          'Supported formats: PNG, JPEG, GIF, WebP.',
      ),
    alt: z
      .string()
      .optional()
      .describe('Alt text shown as link when image cannot be displayed.'),
  })

type Input = z.infer<ReturnType<typeof inputSchema>>

/** Standard terminal cell size in pixels */
const CELL_WIDTH = 8
const CELL_HEIGHT = 16

/**
 * Lightweight synchronous Kitty graphics protocol detection.
 * Uses only env vars — no module dependencies, no async queries.
 */
function detectKittySync(): boolean {
  return !!(
    process.env.TERM?.includes('kitty') ||
    process.env.KITTY_WINDOW_ID ||
    process.env.TERM_PROGRAM === 'kitty' ||
    process.env.TERM_PROGRAM === 'ghostty' ||
    process.env.TERM_PROGRAM === 'WezTerm' ||
    process.env.TERM_PROGRAM === 'konsole' ||
    process.env.TERM_PROGRAM === 'foot'
  )
}

function getToolUseSummary(input: Partial<Input>): string | null {
  return input?.url ? `Show: ${input.url.split('/').pop() ?? input.url}` : null
}

/** Normalize image source path: expand ~, strip file:// */
function normalizeSrc(url: string): string {
  let src = url
  if (src.startsWith('~')) {
    src = src.replace(/^~(?=$|\/)/, homedir())
  }
  if (src.startsWith('file://')) {
    src = src.slice(7)
  }
  return src
}

/** Load image from local path or URL, returning Jimp instance */
async function loadImage(src: string): Promise<Jimp> {
  if (src.startsWith('http://') || src.startsWith('https://')) {
    return loadImageFromUrl(src)
  }
  return Jimp.read(src)
}

export const ImageShowTool = buildTool({
  name: IMAGE_TOOL_NAME,
  description:
    'Display an image (PNG/JPEG/GIF/WebP) directly in the terminal. ' +
    'Renders with full-resolution via Kitty Graphics Protocol when supported, ' +
    'with automatic fallback to text-based rendering (half-block, braille, ascii).',

  getToolUseSummary,
  getActivityDescription(input) {
    return input?.url ? `Showing image: ${input.url}` : 'Showing image'
  },

  isEnabled() {
    return true
  },

  get inputSchema() {
    return inputSchema()
  },

  async validateInput(input) {
    if (!input?.url) {
      return { result: false, message: 'Missing url', errorCode: 1 }
    }
    return { result: true }
  },

  async prompt(_options): Promise<string> {
    return `ImageShow displays a PNG/JPEG/GIF/WebP image directly in the terminal using Unicode-block rendering. Supports local file paths (e.g. /tmp/image.png) and HTTPS URLs (e.g. https://example.com/image.png). The image is rendered within Ink's virtual DOM so the cursor stays in sync.`
  },

  async checkPermissions(): Promise<{ behavior: 'allow' }> {
    return { behavior: 'allow' }
  },

  isReadOnly() {
    return true
  },

  isConcurrencySafe() {
    return true
  },

  mapToolResultToToolResultBlockParam(
    content: {
      success: boolean
      message: string
      imageData?: { base64: string; mediaType: string }
    },
    toolUseID: string,
  ) {
    if (content.success && content.imageData) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: [
          {
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              data: content.imageData.base64,
              media_type: content.imageData.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
            },
          },
        ],
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: [
        {
          type: 'text' as const,
          text: content.message,
        },
      ],
    }
  },

  renderToolResultMessage(
    content: {
      success: boolean
      message: string
      src?: string
      alt?: string
      naturalWidth?: number
      naturalHeight?: number
      base64?: string
    },
    _progressMessages,
    _options,
  ): React.ReactNode {
    if (!content.success) {
      return null
    }

    if (content.src) {
      const cols = process.stdout.columns ?? 80
      const rows = process.stdout.rows ?? 40

      // Target: 60% of terminal width
      const targetW_chars = Math.floor(cols * 0.6)
      const targetW_pixels = targetW_chars * CELL_WIDTH

      // Compute height from original aspect ratio if available
      let pixelHeight: number
      let imgHeight: number

      if (content.naturalWidth && content.naturalHeight) {
        const targetH_pixels = Math.floor(
          targetW_pixels * (content.naturalHeight / content.naturalWidth),
        )
        const minH_pixels = 3 * CELL_HEIGHT
        pixelHeight = Math.max(targetH_pixels, minH_pixels)
        imgHeight = Math.ceil(pixelHeight / CELL_HEIGHT)
      } else {
        // Fallback: 40% of terminal height
        imgHeight = Math.floor(rows * 0.4)
        pixelHeight = imgHeight * CELL_HEIGHT
      }

      // Use the already-loaded PNG buffer to avoid a second file read
      // inside the Image component. This is more reliable in the compiled binary.
      const imageSrc = content.base64
        ? Buffer.from(content.base64, 'base64')
        : content.src

      // Sync terminal info prevents InkPictureProvider's async terminal
      // query from delaying the first render and ensures the correct
      // protocol is used from frame one.
      const terminalInfo: Partial<TerminalInfo> = {
        supportsKittyGraphics: detectKittySync(),
        supportsUnicode: true,
      }

      return (
        <InkPictureProvider terminalInfo={terminalInfo}>
          <Image
            src={imageSrc}
            width={targetW_chars}
            height={imgHeight}
            pixelWidth={targetW_pixels}
            pixelHeight={pixelHeight}
            alt={content.alt}
          />
        </InkPictureProvider>
      )
    }

    return <Text dimColor>{content.message}</Text>
  },

  async call(input: Input): Promise<{
    data: {
      success: boolean
      message: string
      imageData?: { base64: string; mediaType: string }
      base64?: string
      src?: string
      alt?: string
      naturalWidth?: number
      naturalHeight?: number
    }
  }> {
    const url = input.url
    const alt = input.alt ?? url.split('/').pop() ?? 'image'

    const src = normalizeSrc(url)
    logForDebugging(`ImageShow: loading ${url}`)

    try {
      const image = await loadImage(src)
      const naturalWidth = image.bitmap.width
      const naturalHeight = image.bitmap.height

      const buffer = await image.getBuffer('image/png')

      if (buffer.length > 10_000_000) {
        logForDebugging(`ImageShow: image too large (${buffer.length} bytes)`)
        return {
          data: {
            success: false,
            message: `Image too large (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Max 10 MB.`,
          },
        }
      }

      logForDebugging(`ImageShow: loaded ${buffer.length} byte PNG, ${naturalWidth}x${naturalHeight}`)

      return {
        data: {
          success: true,
          message: `Displayed: ${alt} (${buffer.length} bytes, PNG, ${naturalWidth}x${naturalHeight})`,
          imageData: {
            base64: buffer.toString('base64'),
            mediaType: 'image/png',
          },
          base64: buffer.toString('base64'),
          src,
          alt,
          naturalWidth,
          naturalHeight,
        },
      }
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      logForDebugging(`ImageShow: load error ${errMsg} for ${url}`)
      return {
        data: {
          success: false,
          message: `Failed to fetch: ${url} (${errMsg})`,
        },
      }
    }
  },
}) satisfies ToolDef<any, any>
