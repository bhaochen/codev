import { readFile } from 'fs/promises'
import { homedir } from 'os'
import React from 'react'
import { z } from 'zod/v4'
import { RawAnsi, Text } from '../../ink.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import {
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

/** Read a local file and return its buffer + detected format */
async function readLocalImage(url: string): Promise<{ buffer: Buffer; format: string } | null> {
  try {
    const format = detectFormat(url)
    const buffer = await readFile(url)
    return { buffer, format }
  } catch {
    return null
  }
}

/** Download an image from URL and return its buffer + detected format */
async function fetchImage(url: string): Promise<{ buffer: Buffer; format: string } | null> {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Codev/1.0)',
      },
      redirect: 'follow',
    })

    if (!response.ok) {
      logForDebugging(`ImageShow: HTTP ${response.status} for ${url}`)
      return null
    }

    const contentType = response.headers.get('content-type') ?? ''
    const format = detectFormat(url !== contentType ? url : contentType)

    const reader = response.body?.getReader()
    if (!reader) return null

    const chunks: Uint8Array[] = []
    let totalSize = 0
    const MAX_SIZE = 10_000_000

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalSize += value.byteLength
      if (totalSize > MAX_SIZE) {
        logForDebugging(`ImageShow: image too large (${totalSize} bytes) for ${url}`)
        reader.cancel()
        return null
      }
      chunks.push(value)
    }

    const combinedLength = chunks.reduce((acc, c) => acc + c.byteLength, 0)
    const combined = new Uint8Array(combinedLength)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.byteLength
    }

    return { buffer: Buffer.from(combined.buffer), format }
  } catch (err) {
    logForDebugging(`ImageShow: fetch error ${err} for ${url}`)
    return null
  }
}

/** Load image: local file or remote URL */
async function loadImage(url: string): Promise<{ buffer: Buffer; format: string } | null> {
  // Expand ~ to home directory
  const normalizedUrl = url.startsWith('~')
    ? url.replace(/^~(?=$|\/)/, homedir())
    : url
  if (normalizedUrl.startsWith('file://') || normalizedUrl.startsWith('/') || normalizedUrl.startsWith('.')) {
    const path = normalizedUrl.startsWith('file://') ? normalizedUrl.slice(7) : normalizedUrl
    return readLocalImage(path)
  }
  return fetchImage(normalizedUrl)
}

/**
 * React component that renders timg Unicode-block output within Ink's
 * virtual DOM so Ink knows the image dimensions and the cursor stays
 * in sync with the terminal.
 */
function TimgDisplay({ output }: { output: string }): React.ReactNode {
  // Strip cursor hide/show sequences that timg adds
  const cleaned = output.replace(/\x1b\[\?25[hl]/g, '')
  const lines = cleaned.split('\n').filter(l => l.length > 0)
  if (lines.length === 0) {
    return null
  }
  // Measure visible width (strip ANSI escape codes)
  const ansiStrip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
  const width = Math.max(...lines.map(l => ansiStrip(l).length))
  return <RawAnsi lines={lines} width={width} />
}

function getToolUseSummary(input: Partial<Input>): string | null {
  return input?.url ? `Show: ${input.url.split('/').pop() ?? input.url}` : null
}

export const ImageShowTool = buildTool({
  name: IMAGE_TOOL_NAME,
  description:
    'Display an image (PNG/JPEG/GIF/WebP) directly in the terminal. ' +
    'Renders with timg Unicode-block characters within Ink\'s virtual DOM ' +
    'so the cursor stays in sync and the image scrolls with conversation content. ' +
    'Supports both URLs (https://) and local file paths.',

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
    return `ImageShow displays a PNG/JPEG/GIF/WebP image directly in the terminal using timg Unicode-block rendering. Supports local file paths (e.g. /tmp/image.png) and HTTPS URLs (e.g. https://example.com/image.png). The image is rendered within Ink's virtual DOM so the cursor stays in sync.`
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
      timgOutput?: string
    },
    _progressMessages,
    _options,
  ): React.ReactNode {
    if (!content.success) {
      return null
    }

    if (content.timgOutput) {
      return <TimgDisplay output={content.timgOutput} />
    }

    return <Text dimColor>{content.message}</Text>
  },

  async call(input: Input): Promise<{
    data: {
      success: boolean
      message: string
      imageData?: { base64: string; mediaType: string }
      base64?: string
      timgOutput?: string
    }
  }> {
    const url = input.url
    const alt = input.alt ?? url.split('/').pop() ?? 'image'

    logForDebugging(`ImageShow: loading ${url}`)

    const result = await loadImage(url)

    if (!result) {
      return {
        data: {
          success: false,
          message: `Failed to load image from: ${url}`,
        },
      }
    }

    const { buffer, format } = result

    const mediaType =
      format === 'jpeg'
        ? 'image/jpeg'
        : format === 'gif'
          ? 'image/gif'
          : format === 'webp'
            ? 'image/webp'
            : 'image/png'

    logForDebugging(`ImageShow: loaded ${buffer.length} byte ${format} image`)

    // Always render via timg Unicode blocks within Ink's virtual DOM.
    // RawAnsi in renderToolResultMessage renders the output so Ink knows
    // the image dimensions and the cursor stays in sync.
    const timgOutput = renderImageWithTimgSync(buffer, format) ?? undefined
    if (timgOutput) {
      logForDebugging('ImageShow: generated timg Unicode-block output')
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
        timgOutput,
      },
    }
  },
}) satisfies ToolDef<any, any>
