/**
 * Terminal image renderers adapted from ink-picture.
 *
 * Pure functions that convert pixel data into ANSI-escaped strings
 * for display in Ink's RawAnsi component. No Ink/React dependency.
 *
 * Source: https://github.com/endernoke/ink-picture
 */

import chalk from 'chalk'

// --- Types ---

export interface PixelData {
  data: Buffer
  info: {
    width: number
    height: number
    channels: number
  }
}

export type TextImageProtocol = 'halfBlock' | 'braille' | 'ascii'

// --- Protocol detection ---

export interface TerminalCaps {
  supportsUnicode: boolean
  supportsColor: boolean
}

/**
 * Select the best text-based image protocol given terminal capabilities.
 * Prioritises halfBlock (best quality), then braille, then ascii (lowest).
 */
export function getBestTextProtocol(caps: TerminalCaps): TextImageProtocol {
  if (caps.supportsUnicode && caps.supportsColor) return 'halfBlock'
  if (caps.supportsUnicode) return 'braille'
  return 'ascii'
}

// --- ASCII renderer ---

const ASCII_CHARS =
  "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. "

export function renderAscii(
  pixels: PixelData,
  colored: boolean = true,
): string {
  const { data, info } = pixels
  const { width, height, channels } = info

  let result = ''
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = (y * width + x) * channels

      const r = data[pixelIndex]!
      const g = data[pixelIndex + 1]!
      const b = data[pixelIndex + 2]!
      const a = channels === 4 ? (data[pixelIndex + 3] ?? 255) : 255

      const sum = r + g + b + a
      const intensity = sum === 0 ? 0 : sum / (255 * 4)
      const char =
        ASCII_CHARS[
          ASCII_CHARS.length -
            1 -
            Math.floor(intensity * (ASCII_CHARS.length - 1))
        ]!

      result += colored ? chalk.rgb(r, g, b)(char) : char
    }

    result += '\n'
  }

  return result.slice(0, -1)
}

// --- Half-block renderer ---

const HALF_BLOCK = '\u2584'

export function renderHalfBlock(pixels: PixelData): string {
  const { data, info } = pixels
  const { width, height, channels } = info

  let result = ''
  for (let y = 0; y < height - 1; y += 2) {
    for (let x = 0; x < width; x++) {
      const topPixelIndex = (y * width + x) * channels
      const bottomPixelIndex = ((y + 1) * width + x) * channels

      const r = data[topPixelIndex]!
      const g = data[topPixelIndex + 1]!
      const b = data[topPixelIndex + 2]!
      const a = channels === 4 ? (data[topPixelIndex + 3] ?? 255) : 255

      const r2 = data[bottomPixelIndex]!
      const g2 = data[bottomPixelIndex + 1]!
      const b2 = data[bottomPixelIndex + 2]!

      result +=
        a === 0
          ? chalk.reset(' ')
          : chalk.bgRgb(r, g, b).rgb(r2, g2, b2)(HALF_BLOCK)
    }

    result += '\n'
  }

  return result.slice(0, -1)
}

// --- Braille renderer ---

export function renderBraille(pixels: PixelData): string {
  const { data, info } = pixels
  const { width, height, channels } = info

  let result = ''
  for (let y = 0; y < height - 3; y += 4) {
    for (let x = 0; x < width - 1; x += 2) {
      const dot1Index = (y * width + x) * channels
      const dot2Index = ((y + 1) * width + x) * channels
      const dot3Index = ((y + 2) * width + x) * channels
      const dot4Index = (y * width + x + 1) * channels
      const dot5Index = ((y + 1) * width + x + 1) * channels
      const dot6Index = ((y + 2) * width + x + 1) * channels
      const dot7Index = ((y + 3) * width + x) * channels
      const dot8Index = ((y + 3) * width + x + 1) * channels

      const getLuminance = (index: number) => {
        const r = data[index]!
        const g = data[index + 1]!
        const b = data[index + 2]!
        const a = channels === 4 ? (data[index + 3] ?? 255) : 255
        const alpha = a / 255
        const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
        const alphaAdjustedLuminance =
          luminance * alpha + 255 * (1 - alpha)
        return alphaAdjustedLuminance > 128 ? 1 : 0
      }

      const dot1 = getLuminance(dot1Index)
      const dot2 = getLuminance(dot2Index)
      const dot3 = getLuminance(dot3Index)
      const dot4 = getLuminance(dot4Index)
      const dot5 = getLuminance(dot5Index)
      const dot6 = getLuminance(dot6Index)
      const dot7 = getLuminance(dot7Index)
      const dot8 = getLuminance(dot8Index)

      const brailleChar = String.fromCharCode(
        0x2800 +
          (dot8 << 7) +
          (dot7 << 6) +
          (dot6 << 5) +
          (dot5 << 4) +
          (dot4 << 3) +
          (dot3 << 2) +
          (dot2 << 1) +
          dot1,
      )
      result += brailleChar
    }
    result += '\n'
  }

  return result.slice(0, -1)
}

/**
 * Render pixel data as a string using the specified text protocol.
 */
export function renderImage(
  pixels: PixelData,
  protocol: TextImageProtocol,
  colored: boolean = true,
): string {
  switch (protocol) {
    case 'halfBlock':
      return renderHalfBlock(pixels)
    case 'braille':
      return renderBraille(pixels)
    case 'ascii':
      return renderAscii(pixels, colored)
  }
}
