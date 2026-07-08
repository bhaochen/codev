import { execFileSync } from 'child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { z } from 'zod/v4'
import { Jimp } from "jimp";
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { whichSync } from '../../utils/which.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { IMAGE_SHOW_TOOL_NAME, DESCRIPTION } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
} from './UI.js'

// ── Constants ──

export const CELL_WIDTH = 8;
export const CELL_HEIGHT = 16;

// ── Types ──

export interface ImageDimensions {
  width: number;        // 字符宽度
  height: number;       // 字符高度
  pixelWidth: number;   // 像素宽度
  pixelHeight: number;  // 像素高度
}

export interface ImageShowOutput {
  src: string
  success: boolean
  width?: number
  height?: number
  pixelWidth?: number
  pixelHeight?: number
  kittySequence?: string
}

// ── Utilities ──

export function getImagePath(args: string[]): string {
  return args[0] || "/home/yuki/Pictures/Wallpapers/3god.jpg";
}

export function isUrl(path: string): boolean {
  return path.startsWith("http://") || path.startsWith("https://");
}

/**
 * Download a URL to a temporary file, return the path.
 * Caller should delete the file after use.
 */
export async function downloadToTemp(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ImageShowTool/1.0)',
      'Accept': 'image/*',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buffer = Buffer.from(await res.arrayBuffer())
  const hash = crypto.createHash('md5').update(url).digest('hex')
  const tmp = `/tmp/img_${hash}`
  fs.writeFileSync(tmp, buffer)
  return tmp
}

export async function loadImage(path: string) {
  if (isUrl(path)) {
    // Download to temp file, then read with Jimp
    const tmp = await downloadToTemp(path)
    try {
      return await Jimp.read(fs.readFileSync(tmp))
    } finally {
      fs.unlinkSync(tmp)
    }
  } else {
    // Read file to Buffer first, then pass to Jimp.read().
    // Jimp v1.x has inconsistent path resolution in some runtimes
    // (Bun, ESM contexts), so this avoids relying on Jimp's internal
    // file detection by feeding the raw buffer directly.
    const buffer = fs.readFileSync(path);
    return Jimp.read(buffer);
  }
}

export function calculateDimensions(
  imageWidth: number,
  imageHeight: number,
  terminalRows: number
): ImageDimensions {
  // Height = 16.18% of terminal height; width derived from aspect ratio.
  const targetH_chars = Math.floor(terminalRows * 0.1618);
  const targetH_pixels = targetH_chars * CELL_HEIGHT;
  const minW_chars = 3;

  // Pixel width from aspect ratio, then back-compute char width to guarantee
  // pixelWidth === width * CELL_WIDTH — no rounding gap between the
  // placeholder Box and the actual Kitty image.
  const targetW_pixels = Math.floor(targetH_pixels * (imageWidth / imageHeight));
  const targetW_chars = Math.max(Math.ceil(targetW_pixels / CELL_WIDTH), minW_chars);
  const finalPixelWidth = targetW_chars * CELL_WIDTH;

  return {
    width: targetW_chars,
    height: targetH_chars,
    pixelWidth: finalPixelWidth,
    pixelHeight: targetH_pixels,
  };
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
    width: z.number().optional(),
    height: z.number().optional(),
    pixelWidth: z.number().optional(),
    pixelHeight: z.number().optional(),
    kittySequence: z.string().optional(),
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
  // Kitty 协议序列是带内数据，并发写入终端会互相覆盖导致图片不显示
  isConcurrencySafe() {
    return false
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
    let tmpFile: string | undefined
    try {
      // For URLs: download to temp file so timg can read it directly
      let imagePath = src
      if (isUrl(src)) {
        tmpFile = await downloadToTemp(src)
        imagePath = tmpFile
      }

      // Read with Jimp for dimension calculation (from buffer, no MIME restriction)
      const image = await Jimp.read(fs.readFileSync(imagePath))
      const rows = process.stdout.rows ?? 24
      const dims = calculateDimensions(
        image.bitmap.width,
        image.bitmap.height,
        rows,
      )

      // Generate full-resolution Kitty protocol sequence via timg
      let kittySequence: string | undefined
      try {
        const timgPath = whichSync('timg')
        if (timgPath) {
          kittySequence = execFileSync(
            timgPath,
            ['-p', 'kitty', '-g', `${dims.width}x${dims.height}`, imagePath],
            {
              encoding: 'utf8',
              timeout: 30000,
              maxBuffer: 50 * 1024 * 1024,
            },
          )
        }
      } catch {
        // timg not available — fall back to text display
      }

      return {
        data: {
          src,
          success: true,
          ...dims,
          kittySequence,
        } satisfies ImageShowOutput,
      }
    } catch (error) {
      console.error(`[ImageShowTool] Failed to display ${src}:`, error)
      return {
        data: {
          src,
          success: false,
        } satisfies ImageShowOutput,
      }
    } finally {
      if (tmpFile) {
        try { fs.unlinkSync(tmpFile) } catch {}
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
            : `Failed to display image: ${output.src}`,
        },
      ],
    }
  },
} satisfies ToolDef<InputSchema, ImageShowOutput>)
