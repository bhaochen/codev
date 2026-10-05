const DEFAULT_MAX_IMAGE_ROWS = 40
const MIN_IMAGE_ROWS = 16
const MAX_IMAGE_ROWS = 72
const VIEWPORT_ROW_SHARE = 0.75
const VIEWPORT_CHROME_ROWS = 10

/**
 * Bound a native image's cell box so it fits the current viewport while
 * reserving room for the transcript and prompt.
 */
export function maxRowsForViewport(
  viewportRows: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const override = Number.parseInt(env.CODEV_INLINE_IMAGE_ROWS ?? '', 10)
  if (Number.isFinite(override) && override > 0) {
    return Math.min(MAX_IMAGE_ROWS, override)
  }
  if (!Number.isFinite(viewportRows) || viewportRows <= 0) {
    return DEFAULT_MAX_IMAGE_ROWS
  }
  const fitCap = Math.max(1, viewportRows - VIEWPORT_CHROME_ROWS)
  const budget = Math.min(
    MAX_IMAGE_ROWS,
    Math.floor(viewportRows * VIEWPORT_ROW_SHARE),
    fitCap,
  )
  return Math.max(Math.min(MIN_IMAGE_ROWS, fitCap), budget)
}
