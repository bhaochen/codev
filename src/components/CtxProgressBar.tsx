import { Box, Text } from '../ink.js'

const CONTEXT_BAR_WIDTH = 20

type ContextFillBand = 'green' | 'orange' | 'red'

interface ContextBarCell {
  ch: string
  isFill: boolean
  isMarker: boolean
}

interface CtxProgressBarProps {
  currentTokens: number
  contextWindowTokens: number
  compactionTargetTokens: number
  utilizationPct: number
}

function contextFillBand(utilizationPct: number): ContextFillBand {
  const pct = Math.min(100, utilizationPct)
  if (pct < 40) return 'green'
  if (pct < 60) return 'orange'
  return 'red'
}

function contextBarCells(
  currentTokens: number,
  contextWindowTokens: number,
  compactionTargetTokens: number,
): ContextBarCell[] {
  const filled = Math.min(
    CONTEXT_BAR_WIDTH,
    Math.floor(
      (currentTokens * CONTEXT_BAR_WIDTH) / Math.max(1, contextWindowTokens),
    ),
  )

  const markerIndex = Math.max(
    0,
    Math.min(
      CONTEXT_BAR_WIDTH - 1,
      Math.ceil(
        (compactionTargetTokens * CONTEXT_BAR_WIDTH) /
          Math.max(1, contextWindowTokens),
      ) - 1,
    ),
  )

  const cells: ContextBarCell[] = []
  for (let i = 0; i < CONTEXT_BAR_WIDTH; i++) {
    if (i === markerIndex) {
      cells.push({ ch: '|', isFill: false, isMarker: true })
    } else if (i < filled) {
      cells.push({ ch: '=', isFill: true, isMarker: false })
    } else {
      cells.push({ ch: '-', isFill: false, isMarker: false })
    }
  }
  return cells
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`
  }
  return `${tokens}`
}

function bandColor(band: ContextFillBand): string {
  switch (band) {
    case 'green':
      return '#22c55e'
    case 'orange':
      return '#f59e0b'
    case 'red':
      return '#ef4444'
  }
}

export function CtxProgressBar({
  currentTokens,
  contextWindowTokens,
  compactionTargetTokens,
  utilizationPct,
}: CtxProgressBarProps) {
  if (contextWindowTokens <= 0) return null

  const band = contextFillBand(utilizationPct)
  const color = bandColor(band)
  const pct = Math.min(100, Math.max(0, Math.round(utilizationPct)))
  const cells = contextBarCells(
    currentTokens,
    contextWindowTokens,
    compactionTargetTokens,
  )
  const formattedWindow = formatTokenCount(contextWindowTokens)

  return (
    <Box>
      <Text dimColor>ctx [</Text>
      {cells.map((cell, i) => {
        let cellColor: string
        if (cell.isMarker) {
          cellColor = '#a78bfa'
        } else if (cell.isFill) {
          cellColor = color
        } else {
          cellColor = undefined
        }
        return (
          <Text key={i} color={cellColor} dimColor={!cellColor}>
            {cell.ch}
          </Text>
        )
      })}
      <Text dimColor>] </Text>
      <Text color={color}>{pct}%</Text>
      <Text dimColor> [{formattedWindow}]</Text>
    </Box>
  )
}
