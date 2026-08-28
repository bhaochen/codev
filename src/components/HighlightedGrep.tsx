import { memo, useMemo } from 'react'
import { Ansi, Box, NoSelect, Text, useTheme } from '../ink.js'
import { expectColorFile } from './StructuredDiff/colorDiff.js'
import sliceAnsi from '../utils/sliceAnsi.js'

// Parse ripgrep content-mode output (path:num:code, or path:code when -n is
// off) into per-file groups. Blank lines and ripgrep's `--` block separators
// are kept as standalone separators so context gaps render cleanly.
type ParsedLine = { filePath: string; lineNumber: number | null; code: string }
type ParsedGroup = { filePath: string; lines: ParsedLine[] }

function parseGrepContent(content: string): {
  groups: ParsedGroup[]
  separators: string[]
} {
  const raw = content.split('\n')
  const groups: ParsedGroup[] = []
  const separators: string[] = []
  let current: ParsedGroup | null = null
  for (const rawLine of raw) {
    const trimmed = rawLine.trim()
    if (trimmed === '' || trimmed === '--') {
      separators.push(rawLine)
      current = null
      continue
    }
    const firstColon = rawLine.indexOf(':')
    if (firstColon <= 0) {
      separators.push(rawLine)
      current = null
      continue
    }
    const filePath = rawLine.slice(0, firstColon)
    const rest = rawLine.slice(firstColon + 1)
    const m = rest.match(/^(\d+):([\s\S]*)$/)
    let lineNumber: number | null = null
    let code: string
    if (m) {
      lineNumber = parseInt(m[1]!, 10)
      code = m[2]!
    } else {
      code = rest
    }
    if (!current || current.filePath !== filePath) {
      current = { filePath, lines: [] }
      groups.push(current)
    }
    current.lines.push({ filePath, lineNumber, code })
  }
  return { groups, separators }
}

// Renders Search/Grep `content`-mode results with the same syntax highlighting
// and gutter style as Read's HighlightedCode, but preserving ripgrep's real
// line numbers. Falls back to plain text when syntax highlighting is disabled.
export const HighlightedGrep = memo(function HighlightedGrep({
  content,
  dim = false,
}: {
  content?: string
  dim?: boolean
}): React.ReactNode {
  const [theme] = useTheme()
  const ColorFile = expectColorFile()

  const parsed = useMemo(
    () => (content ? parseGrepContent(content) : null)
    [content],
  )

  if (!parsed) return null
  const { groups, separators } = parsed

  return (
    <Box flexDirection="column">
      {groups.map((group, gi) => {
        const maxDigits = group.lines.reduce(
          (max, l) => Math.max(max, (l.lineNumber ?? 0).toString().length),
          1,
        )
        const gutterWidth = maxDigits + 2
        return (
          <Box key={gi} flexDirection="column">
            <Text dimColor>{group.filePath}</Text>
            {group.lines.map((l, li) => {
              let contentAnsi: string = l.code
              if (ColorFile) {
                const cf = new ColorFile(l.code, group.filePath)
                const out = cf.render(theme, 1000, dim)
                if (out && out.length > 0) {
                  contentAnsi = sliceAnsi(out[0]!, 3)
                }
              }
              const gutterText =
                l.lineNumber != null
                  ? ' ' + String(l.lineNumber).padStart(maxDigits) + ' '
                  : ' '.repeat(gutterWidth)
              return (
                <Box key={li} flexDirection="row">
                  <NoSelect fromLeftEdge={true}>
                    <Text dimColor>{gutterText}</Text>
                  </NoSelect>
                  <Text>
                    <Ansi>{contentAnsi}</Ansi>
                  </Text>
                </Box>
              )
            })}
          </Box>
        )
      })}
      {separators.map((s, i) => (
        <Text key={'sep-' + i} dimColor>
          {s}
        </Text>
      ))}
    </Box>
  )
})
