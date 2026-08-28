import type { RGBColor as RGBColorString } from '../../ink/styles.js'
import type { RGBColor as RGBColorType } from './types.js'

export function getDefaultCharacters(): string[] {
  if (process.env.TERM === 'xterm-ghostty') {
    return ['·', '✢', '✳', '✶', '✻', '*'] // Use * instead of ✽ for Ghostty because the latter renders in a way that's slightly offset
  }
  return process.platform === 'darwin'
    ? ['·', '✢', '✳', '✶', '✻', '✽']
    : ['·', '✢', '*', '✶', '✻', '✽']
}

// Interpolate between two RGB colors
export function interpolateColor(
  color1: RGBColorType,
  color2: RGBColorType,
  t: number, // 0 to 1
): RGBColorType {
  return {
    r: Math.round(color1.r + (color2.r - color1.r) * t),
    g: Math.round(color1.g + (color2.g - color1.g) * t),
    b: Math.round(color1.b + (color2.b - color1.b) * t),
  }
}

// Convert RGB object to rgb() color string for Text component
export function toRGBColor(color: RGBColorType): RGBColorString {
  return `rgb(${color.r},${color.g},${color.b})`
}

// HSL hue (0-360) to RGB, using voice-mode waveform parameters (s=0.7, l=0.6).
export function hueToRgb(hue: number): RGBColorType {
  const h = ((hue % 360) + 360) % 360
  const s = 0.7
  const l = 0.6
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  let r = 0
  let g = 0
  let b = 0
  if (h < 60) {
    r = c
    g = x
  } else if (h < 120) {
    r = x
    g = c
  } else if (h < 180) {
    g = c
    b = x
  } else if (h < 240) {
    g = x
    b = c
  } else if (h < 300) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  }
}

const RGB_CACHE = new Map<string, RGBColorType | null>()

export function parseRGB(colorStr: string): RGBColorType | null {
  const cached = RGB_CACHE.get(colorStr)
  if (cached !== undefined) return cached

  const normalized = colorStr.trim().replace(/^#/, '')
  let result: RGBColorType | null = null

  if (/^[0-9a-fA-F]{3}$/.test(normalized)) {
    // #RGB shorthand
    result = {
      r: parseInt(normalized[0]! + normalized[0]!, 16),
      g: parseInt(normalized[1]! + normalized[1]!, 16),
      b: parseInt(normalized[2]! + normalized[2]!, 16),
    }
  } else if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
    // #RRGGBB
    result = {
      r: parseInt(normalized.slice(0, 2), 16),
      g: parseInt(normalized.slice(2, 4), 16),
      b: parseInt(normalized.slice(4, 6), 16),
    }
  } else {
    const match = colorStr.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/)
    result = match
      ? {
          r: parseInt(match[1]!, 10),
          g: parseInt(match[2]!, 10),
          b: parseInt(match[3]!, 10),
        }
      : null
  }

  RGB_CACHE.set(colorStr, result)
  return result
}
