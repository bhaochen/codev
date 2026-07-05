import { readFile } from 'fs/promises'
import { homedir } from 'os'
import React, { useContext, useEffect } from 'react'
import { z } from 'zod/v4'
import { RawAnsi, Text } from '../../ink.js'
import { wrapForMultiplexer } from '../../ink/termio/osc.js'
import { TerminalWriteContext } from '../../ink/useTerminalNotification.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  detectImageProtocol,
  renderImageWithTimgSync,
} from '../../utils/terminalImage.js'

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

/** Detect format from URL/file extension */
function detectFormat(url: string): string {
  const clean = url.split('?')[0]!.split('#')[0]!
  const ext = clean.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    return ext === 'jpg' ? 'jpeg' : ext
  }
  return 'png'
}

function getToolUseSummary(input: Partial<Input>): string | null {
  return input?.url ? `Show: ${input.url.split('/').pop() ?? input.url}` : null
}

/**
 * Renders a Kitty-protocol image by writing the escape sequence directly
 * to the terminal via writeRaw, bypassing Ink's virtual DOM. Reserves
 * vertical space with empty RawAnsi lines so Ink doesn't overwrite the
 * image area.
 */
function KittyImage({
  kittyOutput,
  imageRows,
  offset = 4,
}: {
  kittyOutput: string
  imageRows: number
  offset?: number
}) {
  const writeRaw = useContext(TerminalWriteContext)

  useEffect(() => {
    if (writeRaw && kittyOutput) {
      writeRaw(`\x1b[${imageRows + offset}A${kittyOutput}\x1b[${imageRows + offset}B`)
    }
  }, [kittyOutput, imageRows, offset, writeRaw])

  const width = process.stdout.columns ?? 80
  const lines = new Array<string>(imageRows).fill('')
  return <RawAnsi lines={lines} width={width} />
}

export const ImageShowTool = buildTool({
  name: IMAGE_TOOL_NAME,
  description:
    'Display an image (PNG/JPEG/GIF/WebP) directly in the terminal. ' +
    'Uses the Kitty graphics protocol via timg for native quality when the ' +
    'terminal supports it, with a Unicode-block fallback for universal compatibility. ' +
    'The block-mode output is rendered within Ink\'s virtual DOM so the cursor ' +
    'stays in sync and the image scrolls with conversation content.',

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
    return `ImageShow displays a PNG/JPEG/GIF/WebP image directly in the terminal. Uses the Kitty graphics protocol via timg when the terminal supports it (Kitty, Ghostty, WezTerm, foot), or falls back to timg Unicode-block rendering for universal terminal compatibility. Supports local file paths (e.g. /tmp/image.png) and HTTPS URLs (e.g. https://example.com/image.png). The image is shown inline above the tool result.`
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
      kittyOutput?: string
      timgOutput?: string
      imageRows?: number
    },
    _progressMessages,
    _options,
  ): React.ReactNode {
    if (!content.success) {
      return null
    }

    // Kitty protocol: bypass Ink's virtual DOM via writeRaw and reserve
    // space with empty RawAnsi lines.
    if (content.kittyOutput && content.imageRows && content.imageRows > 0) {
      return (
        <KittyImage
          kittyOutput={content.kittyOutput}
          imageRows={content.imageRows}
        />
      )
    }

    // Block-mode fallback when Kitty protocol is not supported.
    if (content.timgOutput) {
      const cleaned = content.timgOutput.replace(/\x1b\[\?25[hl]/g, '')
      const lines = cleaned.split('\n').filter(l => l.length > 0)
      if (lines.length > 0) {
        const ansiStrip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
        const width = Math.max(...lines.map(l => ansiStrip(l).length))
        return <RawAnsi lines={lines} width={width} />
      }
    }

    return <Text dimColor>{content.message}</Text>
  },

  async call(input: Input): Promise<{
    data: {
      success: boolean
      message: string
      imageData?: { base64: string; mediaType: string }
      base64?: string
      format?: string
      kittyOutput?: string
      timgOutput?: string
    }
  }> {
    const url = input.url
    const alt = input.alt ?? url.split('/').pop() ?? 'image'

    logForDebugging(`ImageShow: loading ${url}`)

    // Expand ~ to home directory for local files
    const normalizedUrl = url.startsWith('~')
      ? url.replace(/^~(?=$|\/)/, homedir())
      : url

    let imgResult: { buffer: Buffer; format: string } | null = null

    if (normalizedUrl.startsWith('file://') || normalizedUrl.startsWith('/') || normalizedUrl.startsWith('.')) {
      const path = normalizedUrl.startsWith('file://') ? normalizedUrl.slice(7) : normalizedUrl
      try {
        const format = detectFormat(path)
        const buffer = await readFile(path)
        imgResult = { buffer, format }
      } catch {
        // fall through
      }
    } else {
      try {
        const response = await fetch(normalizedUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Codev/1.0)' },
          redirect: 'follow',
        })
        if (response.ok) {
          const contentType = response.headers.get('content-type') ?? ''
          const format = detectFormat(normalizedUrl !== contentType ? normalizedUrl : contentType)
          const reader = response.body?.getReader()
          if (reader) {
            const chunks: Uint8Array[] = []
            let totalSize = 0
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              totalSize += value.byteLength
              if (totalSize > 10_000_000) {
                reader.cancel()
                break
              }
              chunks.push(value)
            }
            const combined = new Uint8Array(chunks.reduce((acc, c) => acc + c.byteLength, 0))
            let offset = 0
            for (const chunk of chunks) {
              combined.set(chunk, offset)
              offset += chunk.byteLength
            }
            imgResult = { buffer: Buffer.from(combined.buffer), format }
          }
        }
      } catch (err) {
        logForDebugging(`ImageShow: fetch error ${err} for ${normalizedUrl}`)
      }
    }

    if (!imgResult) {
      return {
        data: {
          success: false,
          message: `Failed to load image from: ${url}`,
        },
      }
    }

    const { buffer, format } = imgResult
    const mediaType =
      format === 'jpeg' ? 'image/jpeg'
        : format === 'gif' ? 'image/gif'
          : format === 'webp' ? 'image/webp'
            : 'image/png'

    logForDebugging(`ImageShow: loaded ${buffer.length} byte ${format} image`)

    // Rendering approach:
    // 1. Kitty protocol via timg for native-quality display (when supported)
    // 2. Block-mode via timg as fallback for terminals without Kitty support
    const protocol = detectImageProtocol()
    let kittyOutput: string | undefined
    let timgOutput: string | undefined
    let imageRows = 0

    if (protocol === 'kitty') {
      const rawKitty = renderImageWithTimgSync(buffer, format, undefined, undefined, 'kitty')
      if (rawKitty) {
        // Pass the raw timg output directly through writeRaw — no need to
        // strip cursor sequences since writeRaw bypasses Ink's screen buffer.
        kittyOutput = wrapForMultiplexer(rawKitty.trimEnd())
        const termRows = process.stdout.rows ?? 40
        imageRows = Math.max(10, Math.floor(termRows * 0.5))
        logForDebugging(
          `ImageShow: generated Kitty protocol output, image rows = ${imageRows}`,
        )
      }
      if (imageRows === 0) {
        kittyOutput = undefined
      }
    }

    if (!kittyOutput) {
      timgOutput = renderImageWithTimgSync(buffer, format, undefined, undefined, 'blocks') ?? undefined
      if (timgOutput) {
        logForDebugging('ImageShow: generated block-mode output via timg')
      }
    }

    return {
      data: {
        success: true,
        message: `Displayed: ${alt} (${buffer.length} bytes, ${format})`,
        imageData: {
          base64: buffer.toString('base64'),
          mediaType,
        },
        base64: buffer.toString('base64'),
        format,
        kittyOutput,
        timgOutput,
        imageRows,
      },
    }
  },
}) satisfies ToolDef<any, any>
