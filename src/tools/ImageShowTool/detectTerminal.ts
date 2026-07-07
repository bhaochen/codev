import type { TerminalInfo } from '../../ink-picture/InkPictureProvider.js'

/**
 * Detect terminal image protocol capabilities using environment variables only.
 * This is the reliable path — no ANSI escape queries, no stdin hijacking.
 *
 * Based on the timg-era approach (commit baaa9e3) where detectImageProtocol()
 * used TERM, TERM_PROGRAM, and KITTY_WINDOW_ID to pick the protocol.
 */
export function detectTerminalCaps(): Partial<TerminalInfo> {
  const term = process.env.TERM ?? ''
  const termProgram = process.env.TERM_PROGRAM ?? ''

  const supportsUnicode = true // all modern terminals
  const colorterm = process.env.COLORTERM ?? ''
  const supportsColor =
    colorterm === 'truecolor' ||
    !!colorterm ||
    term.includes('truecolor') ||
    term.includes('256color')

  // --- Kitty graphics ---
  const supportsKittyGraphics =
    termProgram === 'ghostty' ||
    termProgram === 'kitty' ||
    term.includes('kitty') ||
    term.includes('ghostty') ||
    !!process.env.KITTY_WINDOW_ID

  // --- Sixel graphics ---
  const supportsSixelGraphics =
    term.includes('sixel') ||
    termProgram === 'ghostty' ||
    termProgram === 'vscode' ||
    (supportsKittyGraphics && termProgram === 'foot')

  // --- iTerm2 inline images ---
  let supportsITerm2Graphics = false
  if (termProgram === 'iTerm.app') {
    supportsITerm2Graphics = true
  } else if (termProgram === 'WezTerm') {
    // WezTerm supports iTerm2 inline from 20220319
    const ver = process.env.TERM_PROGRAM_VERSION ?? ''
    const date = parseInt(ver.split('-')[0], 10)
    if (!Number.isNaN(date) && date >= 20220319) {
      supportsITerm2Graphics = true
    }
  } else if (termProgram === 'WarpTerminal') {
    // Warp supports iTerm2 inline from v0.2025.03.05.08.02
    const ver = process.env.TERM_PROGRAM_VERSION ?? ''
    const match = ver.match(/v?(\d+)\.(\d+)\.(\d+)/)
    if (match) {
      const [, year, month, day] = match.map(Number)
      if (
        year > 2025 ||
        (year === 2025 && month > 3) ||
        (year === 2025 && month === 3 && day >= 5)
      ) {
        supportsITerm2Graphics = true
      }
    }
  } else if (termProgram === 'vscode' && supportsSixelGraphics) {
    // VS Code can do iTerm2 if it supports Sixel
    supportsITerm2Graphics = true
  } else if (!!process.env.KONSOLE_VERSION && supportsKittyGraphics) {
    // Konsole uses Kitty; also supports iTerm2 from 22.04
    const konsoleVer = parseInt(process.env.KONSOLE_VERSION, 10)
    if (!Number.isNaN(konsoleVer) && konsoleVer >= 220400) {
      supportsITerm2Graphics = true
    }
  }

  return {
    supportsUnicode,
    supportsColor,
    supportsKittyGraphics,
    supportsSixelGraphics,
    supportsITerm2Graphics,
  }
}
