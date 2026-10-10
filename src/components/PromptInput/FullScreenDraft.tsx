import { useMemo, useState } from 'react'
import type { PastedContent } from '../../utils/config.js'
import { expandPastedTextRefs } from '../../history.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useRegisterOverlay } from '../../context/overlayContext.js'
import { Box, Text, useInput } from '../../ink.js'

type Props = {
  /** The raw draft (may contain [Pasted text #N ...] placeholders). */
  value: string
  pastedContents?: Record<number, PastedContent>
  /** Called once on close with the (possibly edited) expanded text. */
  onChange: (value: string) => void
  /** Close the full-screen view. */
  onDone: () => void
}

/** Header rows + footer hint reserve, kept off the scroll window. */
const CHROME_ROWS = 3
/** Left gutter for line numbers. */
const GUTTER = 6

/**
 * Full-screen editor for the prompt draft.
 *
 * The inline box only shows a cramped slice, so a long draft — and text
 * collapsed to `[Pasted text #N +X lines]` — is hard to read or edit there.
 * This expands the pasted blocks, shows the whole draft with line numbers, and
 * lets you edit it in place. Edits are held locally and written back once on
 * close (writing back per keystroke would trip the input's auto-truncation,
 * which re-collapses long text into a placeholder).
 */
export function FullScreenDraft({
  value,
  pastedContents = {},
  onChange,
  onDone,
}: Props) {
  useRegisterOverlay('fullscreen-draft')
  const { rows, columns } = useTerminalSize()

  const initial = useMemo(() => {
    try {
      return expandPastedTextRefs(value, pastedContents)
    } catch {
      return value
    }
  }, [value, pastedContents])

  const [text, setText] = useState(initial)
  const [cursor, setCursor] = useState(initial.length)

  const lines = text.split('\n')
  const visibleRows = Math.max(1, rows - CHROME_ROWS)
  const maxScroll = Math.max(0, lines.length - visibleRows)
  const numberWidth = String(lines.length).length
  const contentWidth = Math.max(8, columns - GUTTER - 1)

  // Line the caret is on, kept inside the scroll window.
  const cursorLine = text.slice(0, cursor).split('\n').length - 1
  const [scrollTop, setScrollTop] = useState(0)
  const top = Math.max(0, Math.min(scrollTop, maxScroll))

  const setCaret = (nextText: string, nextCursor: number) => {
    const next = Math.max(0, Math.min(nextCursor, nextText.length))
    const nextLine = nextText.slice(0, next).split('\n').length - 1
    setText(nextText)
    setCursor(next)
    setScrollTop(t => {
      const nextMax = Math.max(0, nextText.split('\n').length - visibleRows)
      const clamped = Math.max(0, Math.min(t, nextMax))
      if (nextLine < clamped) return nextLine
      if (nextLine > clamped + visibleRows - 1) {
        return Math.max(0, nextLine - visibleRows + 1)
      }
      return clamped
    })
  }

  const lineStart = (index: number): number => {
    let pos = 0
    for (let i = 0; i < index && pos <= text.length; i++) {
      const nl = text.indexOf('\n', pos)
      if (nl === -1) return text.length
      pos = nl + 1
    }
    return pos
  }
  const lineEnd = (index: number): number => {
    const start = lineStart(index)
    const nl = text.indexOf('\n', start)
    return nl === -1 ? text.length : nl
  }

  useInput((char, key, event) => {
    // Modal: consume every key so nothing leaks to the underlying prompt or to
    // global shortcuts (e.g. the ctrl+o transcript toggle).
    event.stopImmediatePropagation()
    if (key.escape || (key.ctrl && char.toLowerCase() === 'e')) {
      if (text !== initial) onChange(text)
      onDone()
      return
    }

    // Scroll without moving the caret.
    if (key.pageUp) {
      setScrollTop(t => Math.max(0, t - visibleRows))
      return
    }
    if (key.pageDown) {
      setScrollTop(t => Math.min(maxScroll, t + visibleRows))
      return
    }
    if (char === 'g' && key.ctrl) {
      setScrollTop(0)
      return
    }

    // Caret movement.
    if (key.leftArrow) return setCaret(text, cursor - 1)
    if (key.rightArrow) return setCaret(text, cursor + 1)
    if (key.upArrow) {
      const prevLine = cursorLine - 1
      if (prevLine < 0) return
      const col = cursor - lineStart(cursorLine)
      return setCaret(text, Math.min(lineStart(prevLine) + col, lineEnd(prevLine)))
    }
    if (key.downArrow) {
      const nextLine = cursorLine + 1
      if (nextLine > lines.length - 1) return
      const col = cursor - lineStart(cursorLine)
      return setCaret(
        text,
        Math.min(lineStart(nextLine) + col, lineEnd(nextLine)),
      )
    }
    if (key.home) return setCaret(text, lineStart(cursorLine))
    if (key.end) return setCaret(text, lineEnd(cursorLine))

    // Editing.
    if (key.return) {
      return setCaret(text.slice(0, cursor) + '\n' + text.slice(cursor), cursor + 1)
    }
    if (key.backspace) {
      if (cursor === 0) return
      return setCaret(text.slice(0, cursor - 1) + text.slice(cursor), cursor - 1)
    }
    if (key.delete) {
      if (cursor >= text.length) return
      return setCaret(text.slice(0, cursor) + text.slice(cursor + 1), cursor)
    }
    if (char && !key.ctrl && !key.meta) {
      return setCaret(text.slice(0, cursor) + char + text.slice(cursor), cursor + char.length)
    }
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
          {lines.length} line{lines.length === 1 ? '' : 's'} · {text.length} chars
          {'  '}· ctrl+e or esc to save & close
        </Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {visibleLines.map((line, i) => {
          const lineNo = top + i + 1
          const isCaretLine = top + i === cursorLine
          const truncated = line.length > contentWidth
          return (
            <Box key={lineNo}>
              <Text dimColor>
                {String(lineNo).padStart(numberWidth)} │{' '}
              </Text>
              <Text {...(isCaretLine ? { color: 'suggestion' as const } : {})}>
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
          {maxScroll > 0 ? '↑/↓ move · pageup/pagedown scroll · ' : ''}
          ctrl+e or esc to save & close
        </Text>
      </Box>
    </Box>
  )
}
