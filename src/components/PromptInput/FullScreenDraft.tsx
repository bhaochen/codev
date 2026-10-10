import { useState } from 'react'
import type { PastedContent } from '../../utils/config.js'
import { expandPastedTextRefs } from '../../history.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import { Box, Text, useInput } from '../../ink.js'

type Props = {
  /** The raw draft (may contain [Pasted text #N ...] placeholders). */
  value: string
  pastedContents: Record<number, PastedContent>
  /** Close the full-screen view (draft is preserved). */
  onDone: () => void
}

/** Header rows + footer hint reserve, kept off the scroll window. */
const CHROME_ROWS = 3
/** Left gutter for line numbers: a few spaces + the number + a space. */
const GUTTER = 6

/**
 * Full-screen read view of the prompt draft.
 *
 * The inline input box can only show a cramped slice, so a long multi-line
 * draft (and, especially, text that was collapsed to `[Pasted text #N +X
 * lines]`) is hard to read there. This renders the whole draft — pasted
 * blocks expanded to their real content — with line numbers and scroll.
 *
 * It is a viewer: editing continues in the normal input box after closing
 * (Ctrl+O or Esc).
 */
export function FullScreenDraft({ value, pastedContents, onDone }: Props) {
  useRegisterOverlay('fullscreen-draft')
  const { rows, columns } = useTerminalSize()

  const expanded = expandPastedTextRefs(value, pastedContents)
  const lines = expanded.split('\n')
  const visibleRows = Math.max(1, rows - CHROME_ROWS)
  const maxScroll = Math.max(0, lines.length - visibleRows)
  const [scrollTop, setScrollTop] = useState(0)
  const top = Math.min(scrollTop, maxScroll)
  const numberWidth = String(lines.length).length
  // Columns left for content after the gutter.
  const contentWidth = Math.max(8, columns - GUTTER - 1)

  useInput((char, key, event) => {
    // Modal: consume every key so nothing leaks to the underlying input box or
    // to global shortcuts (e.g. the ctrl+o transcript toggle).
    event.stopImmediatePropagation()
    if (key.escape || (key.ctrl && char === 'o')) {
      onDone()
      return
    }
    if (key.upArrow) setScrollTop(t => Math.max(0, t - 1))
    else if (key.downArrow) setScrollTop(t => Math.min(maxScroll, t + 1))
    else if (key.pageUp) setScrollTop(t => Math.max(0, t - visibleRows))
    else if (key.pageDown) setScrollTop(t => Math.min(maxScroll, t + visibleRows))
    else if (char === 'g') setScrollTop(0)
    else if (char === 'G') setScrollTop(maxScroll)
  })

  const visibleLines = lines.slice(top, top + visibleRows)

  return (
    <Box flexDirection="column" width="100%" height={rows}>
      <Box>
        <Text bold color="suggestion">
          Draft
        </Text>
        <Text dimColor>
          {'  '}
          {lines.length} line{lines.length === 1 ? '' : 's'} ·{' '}
          {expanded.length} chars
          {top > 0 ? ` · lines ${top + 1}-${top + visibleLines.length}` : ''}
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {visibleLines.map((line, i) => {
          const lineNo = top + i + 1
          const truncated = line.length > contentWidth
          return (
            <Box key={lineNo}>
              <Text dimColor>
                {String(lineNo).padStart(numberWidth)} │{' '}
              </Text>
              <Text>
                {truncated ? line.slice(0, contentWidth) : line}
              </Text>
              {truncated && (
                <Text dimColor>{` …+${line.length - contentWidth}`}</Text>
              )}
            </Box>
          )
        })}
      </Box>
      <Box>
        <Text dimColor>
          {maxScroll > 0
            ? '↑/↓ pageup/pagedown scroll · '
            : ''}
          ctrl+o or esc to close
        </Text>
      </Box>
    </Box>
  )
}
