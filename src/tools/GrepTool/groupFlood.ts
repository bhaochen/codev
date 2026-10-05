const FLOOD_FACTOR = 1.5
const FLOOD_MIN_FILES = 4
const MAX_FILES_LISTED = 40
const MAX_ANCHORS_PER_FILE = 12
const MAX_UNPARSED_FRACTION = 0.1

type FileGroup = {
  rawPath: string
  anchors: number[]
}

export type GroupedGrepSummary = {
  content: string
  numLines: number
  numFiles: number
}

export function parseGrepContentLine(
  line: string,
): { path: string; lineNumber: number } | null {
  const match = /^(.+?):(\d+):/.exec(line)
  if (!match) return null
  return { path: match[1]!, lineNumber: Number.parseInt(match[2]!, 10) }
}

function formatAnchors(anchors: number[]): string {
  const shown = anchors.slice(0, MAX_ANCHORS_PER_FILE)
  return shown.join(', ') + (anchors.length > shown.length ? ', …' : '')
}

export function buildGroupedGrepSummary(
  lines: readonly string[],
  limit: number,
  relativize: (path: string) => string,
): GroupedGrepSummary | null {
  if (lines.length <= limit) return null

  const groups = new Map<string, FileGroup>()
  let parsed = 0
  for (const line of lines) {
    const entry = parseGrepContentLine(line)
    if (!entry) continue
    parsed++
    const group = groups.get(entry.path)
    if (group) group.anchors.push(entry.lineNumber)
    else groups.set(entry.path, { rawPath: entry.path, anchors: [entry.lineNumber] })
  }

  if (
    parsed === 0 ||
    (lines.length - parsed) / lines.length > MAX_UNPARSED_FRACTION ||
    (lines.length < limit * FLOOD_FACTOR && groups.size < FLOOD_MIN_FILES)
  ) {
    return null
  }

  const sorted = [...groups.values()].sort(
    (a, b) =>
      b.anchors.length - a.anchors.length ||
      (a.rawPath < b.rawPath ? -1 : a.rawPath > b.rawPath ? 1 : 0),
  )
  const listed = sorted.slice(0, MAX_FILES_LISTED)
  const omitted = sorted.slice(MAX_FILES_LISTED)
  const omittedLines = omitted.reduce((sum, group) => sum + group.anchors.length, 0)
  const out = [
    `${parsed} matching lines across ${groups.size} files exceed the ${limit}-line display limit, so matches are grouped by file instead of shown in full.`,
    '',
    ...listed.map(group => {
      const count = group.anchors.length
      return `${relativize(group.rawPath)} — ${count} ${count === 1 ? 'match' : 'matches'} (lines ${formatAnchors(group.anchors)})`
    }),
  ]
  if (omitted.length > 0) {
    out.push(`… and ${omitted.length} more files (${omittedLines} matches)`)
  }
  out.push(
    '',
    'To see match content, narrow the search (path, glob, or a more specific pattern), or re-run with a higher head_limit / offset pagination.',
  )

  return { content: out.join('\n'), numLines: parsed, numFiles: groups.size }
}
