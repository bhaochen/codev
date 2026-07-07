import { z } from 'zod/v4'
import { Jimp } from "jimp";
import { buildTool, type ToolDef } from '../../Tool.js'
import { loadImageFromUrl } from "../../ink-picture/utils/jimpURL.ts";
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { IMAGE_SHOW_TOOL_NAME, DESCRIPTION } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
} from './UI.js'
import type { PixelData, PngData } from "../../ink-picture/renderers/types.js";
import {
  makeKittyTransmitChunks,
  makeKittyPlacement,
} from "../../ink-picture/renderers/kitty.js";
import { renderSixel } from "../../ink-picture/renderers/sixel.js";
import { renderITerm2 } from "../../ink-picture/renderers/iterm2.js";
import { renderHalfBlock } from "../../ink-picture/renderers/halfBlock.js";
import { renderBraille } from "../../ink-picture/renderers/braille.js";
import { renderAscii } from "../../ink-picture/renderers/ascii.js";
import generateKittyId from "../../ink-picture/utils/generateKittyId.js";

// ── Utility functions (kept for standalone UI and external use) ──

export const CELL_WIDTH = 8;
export const CELL_HEIGHT = 16;

export interface ImageDimensions {
  width: number;        // 字符宽度
  height: number;       // 字符高度
  pixelWidth: number;   // 像素宽度
  pixelHeight: number;  // 像素高度
}

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
    return Jimp.read(path);
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

// ── Protocol detection ──

type Protocol = 'kitty' | 'sixel' | 'iterm2' | 'halfBlock' | 'braille' | 'ascii'

function detectProtocol(): Protocol {
  const termProgram = process.env.TERM_PROGRAM
  const term = process.env.TERM

  // Kitty protocol — stores image in terminal GPU memory, survives screen clears
  if (termProgram === 'ghostty' || termProgram === 'kitty' || term?.includes('kitty')) {
    return 'kitty'
  }

  // Sixel
  if (term?.includes('sixel') || termProgram === 'ghostty' || termProgram === 'vscode') {
    return 'sixel'
  }

  // iTerm2 inline images
  if (termProgram === 'iTerm.app' || termProgram === 'WezTerm' || termProgram === 'WarpTerminal') {
    return 'iterm2'
  }

  // Text-based fallback
  const colorterm = process.env.COLORTERM
  const supportsColor = colorterm === 'truecolor' || !!colorterm ||
    term?.includes('truecolor') || term?.includes('256color')
  const supportsUnicode = true // all modern terminals

  if (supportsUnicode && supportsColor) return 'halfBlock'
  if (supportsUnicode) return 'braille'
  return 'ascii'
}

type JimpInstance = Awaited<ReturnType<typeof Jimp.read>>

async function renderImage(image: JimpInstance, dims: ImageDimensions): Promise<void> {
  const protocol = detectProtocol()

  image.cover({ w: dims.pixelWidth, h: dims.pixelHeight })

  const pixels: PixelData = {
    data: image.bitmap.data,
    info: { width: image.bitmap.width, height: image.bitmap.height, channels: 4 },
  }

  switch (protocol) {
    case 'kitty': {
      const pngBuf = await image.getBuffer("image/png")
      const b64 = pngBuf.toString('base64')
      const imgId = generateKittyId()
      const chunks = makeKittyTransmitChunks(imgId, b64)
      for (const chunk of chunks) {
        process.stdout.write(chunk)
      }
      process.stdout.write('\n')
      process.stdout.write(makeKittyPlacement(imgId, 1, dims.width, dims.height))
      process.stdout.write('\n')
      break
    }
    case 'sixel': {
      const output = renderSixel(pixels)
      process.stdout.write(output)
      process.stdout.write('\n')
      break
    }
    case 'iterm2': {
      const pngBuf = await image.getBuffer("image/png")
      const pngData: PngData = {
        data: pngBuf,
        info: { width: image.bitmap.width, height: image.bitmap.height },
      }
      const output = renderITerm2(pngData, { width: dims.pixelWidth, height: dims.pixelHeight })
      process.stdout.write(output)
      process.stdout.write('\n')
      break
    }
    case 'halfBlock': {
      const output = renderHalfBlock(pixels)
      process.stdout.write('\n')
      process.stdout.write(output)
      process.stdout.write('\n')
      break
    }
    case 'braille': {
      const output = renderBraille(pixels)
      process.stdout.write('\n')
      process.stdout.write(output)
      process.stdout.write('\n')
      break
    }
    case 'ascii': {
      const output = renderAscii(pixels, {
        colored: !!(process.env.COLORTERM || process.env.TERM?.includes('truecolor')),
      })
      process.stdout.write('\n')
      process.stdout.write(output)
      process.stdout.write('\n')
      break
    }
  }
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
    src: z.string().describe('The image source that was displayed'),
    success: z.boolean().describe('Whether the image was displayed successfully'),
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

      // Render the image directly to terminal using ink-picture
      await renderImage(image, dims)

      return {
        data: {
          src,
          success: true,
        } satisfies Output,
      }
    } catch (error) {
      return {
        data: {
          src,
          success: false,
        } satisfies Output,
      }
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
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
} satisfies ToolDef<InputSchema, Output>)
