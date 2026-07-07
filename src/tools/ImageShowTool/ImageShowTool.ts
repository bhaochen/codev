import { execFileSync } from 'child_process'
import fs from 'node:fs'
import { z } from 'zod/v4'
import { Jimp } from "jimp";
import { buildTool, type ToolDef } from '../../Tool.js'
import { loadImageFromUrl } from "../../ink-picture/utils/jimpURL.ts";
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

export async function loadImage(path: string) {
  if (isUrl(path)) {
    return loadImageFromUrl(path);
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
  terminalCols: number
): ImageDimensions {
  const targetW_chars = Math.floor(terminalCols * 0.1618);
  const targetW_pixels = targetW_chars * CELL_WIDTH;
  const targetH_pixels = Math.floor(targetW_pixels * (imageHeight / imageWidth));
  const minH_pixels = 3 * CELL_HEIGHT;
  const finalH_pixels = Math.max(targetH_pixels, minH_pixels);
  const targetH_chars = Math.ceil(finalH_pixels / CELL_HEIGHT);

  return {
    width: targetW_chars,
    height: targetH_chars,
    pixelWidth: targetW_pixels,
    pixelHeight: finalH_pixels,
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
      const image = await loadImage(src)
      const cols = process.stdout.columns ?? 80
      const dims = calculateDimensions(
        image.bitmap.width,
        image.bitmap.height,
        cols,
      )

      // Generate full-resolution Kitty protocol sequence via timg
      let kittySequence: string | undefined
      try {
        const timgPath = whichSync('timg')
        if (timgPath) {
          // Pipe image to timg via stdin, capture Kitty protocol output
          const pngBuffer = await image.getBuffer("image/png")
          kittySequence = execFileSync(
            timgPath,
            ['-p', 'kitty', '-g', `${dims.width}x${dims.height}`, '-'],
            {
              input: pngBuffer,
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
