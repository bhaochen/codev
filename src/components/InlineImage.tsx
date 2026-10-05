import { Buffer } from 'buffer'
import * as React from 'react'
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useSettings } from '../hooks/useSettings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import type { DOMElement } from '../ink/dom.js'
import {
  getGraphicsConstraintGeneration,
  getPlacementRowLimit,
  setGraphicsPlacement,
  subscribeGraphicsConstraints,
} from '../ink/graphicsPlacement.js'
import { Box, RawAnsi } from '../ink.js'
import type { GraphicsOverlay } from '../utils/terminalGraphics.js'
import {
  allocateKittyImageId,
  getCellPixelSize,
  getGraphicsGeneration,
  hasMeasuredCellSize,
  isCellGeometryStale,
  registerKittyVirtualImage,
  renderGraphicsOverlay,
  resolveGraphicsProtocol,
  subscribeGraphicsCapability,
  unregisterKittyVirtualImage,
} from '../utils/terminalGraphics.js'
import { maxRowsForViewport } from '../utils/imageLayout.js'
import { logForDebugging } from '../utils/debug.js'
import {
  applyWithBatch,
  beginImageRender,
  createImageRenderToken,
  endImageRender,
} from './inlineImageBatch.js'

/** Distinguishes concurrent placements; only needs to be unique per process. */
let nextPlacementId = 0

/**
 * Left gutter of the transcript response rail, plus a little breathing room, so
 * a full-width image is not clipped by the frame it sits in.
 */
const TRANSCRIPT_GUTTER_COLUMNS = 8

/**
 * How long to wait before looking again when a graphic was withheld.
 *
 * Long enough that a drag does not re-encode per frame, while ensuring a
 * withheld native image is retried promptly after terminal geometry settles.
 */
const GRAPHICS_RETRY_MS = 120

type Props = {
  /** Base64-encoded image bytes, as produced by the read tools. */
  base64: string
  /**
   * The summary line this preview accompanies (file size and so on). Rendered
   * on its own when the image cannot be shown, and above it when it can.
   */
  children: React.ReactNode
  maxRows?: number
}

/**
 * Renders an image inline in the transcript, above its summary line.
 *
 * Image pixels use a native terminal graphics protocol. Kitty/Ghostty image
 * anchors are written as transcript cells so they scroll with the text; other
 * protocols are placed over reserved cells outside Ink's renderer. A terminal
 * without a supported protocol or measured pixel geometry shows only the
 * summary, never a block-glyph approximation.
 */
export function InlineImage({
  base64,
  children,
  maxRows,
}: Props): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  // `/config` → "Display images". Off means the summary line stands alone: no
  // decode, no encode, no placement — and any graphic already on screen is
  // taken down, because unmounting the box below unregisters the placement and
  // the renderer erases the pixels it recorded for it on the next frame.
  const imagesEnabled = useSettings().inlineImagesEnabled !== false
  const [overlay, setOverlay] = useState<GraphicsOverlay | null>(null)
  // Reconciliation, not an edge. Every reason a graphic is withheld is
  // temporary — a resize is in flight, the first geometry probe has not
  // answered, the measurement moved while this was encoding — but each is
  // announced by something that can be dropped: a reply lost in a resize burst,
  // a probe coalesced into one already out, a deadline that lapses with nobody
  // watching the clock. Waiting to be told is what left an image absent for
  // the rest of the session after a zoom. Instead, when the render
  // that just finished is not the one that should be on screen, come back and
  // look. The condition is self-limiting: it can only hold while the geometry
  // is unsettled, and that has a deadline of its own.
  const [withheld, setWithheld] = useState(false)
  const [attempt, setAttempt] = useState(0)

  // Both dimensions are dependencies: a resize re-renders the image to the new
  // window rather than letting the previous block wrap or clip.
  const maxColumns = Math.max(1, columns - TRANSCRIPT_GUTTER_COLUMNS)
  // Aspect ratio couples the axes, so a row budget that ignores the window
  // silently caps width too. Scale with the viewport unless a caller pins it.
  const rowBudget = maxRows ?? maxRowsForViewport(rows)

  const placementId = useRef<string | null>(null)
  if (placementId.current === null) {
    placementId.current = `inline-image-${nextPlacementId++}`
  }
  // One Kitty id for the life of this image. Re-encoding the same pixels then
  // yields the same payload, which is not mistaken for a different image — a
  // fresh id per encode made every resize or re-measure look like a change.
  const kittyImageId = useRef<number | null>(null)
  if (kittyImageId.current === null) {
    kittyImageId.current = allocateKittyImageId()
  }
  // This image's identity among renders landing together; see inlineImageBatch.
  const renderToken = useRef<number | null>(null)
  if (renderToken.current === null) {
    renderToken.current = createImageRenderToken()
  }
  // Whether the render started by the effect below has yet to land.
  const renderPending = useRef(false)
  // How many rows the renderer found available last time this image was too
  // tall to draw. Without it the component would keep re-encoding the same
  // oversized box, be withheld every frame, and never produce a native image.
  const constraintGeneration = useSyncExternalStore(
    subscribeGraphicsConstraints,
    getGraphicsConstraintGeneration,
    getGraphicsConstraintGeneration,
  )
  const rowLimit = getPlacementRowLimit(placementId.current)
  const effectiveRowBudget =
    rowLimit === undefined ? rowBudget : Math.min(rowBudget, rowLimit)
  const boxRef = useRef<DOMElement | null>(null)
  // The capability probes resolve a round-trip after startup, and cell geometry
  // is re-measured on every resize. Tracking their generation means an image
  // encoded against stale information re-encodes as soon as better arrives,
  // instead of staying wrong for the rest of the session.
  const capabilityGeneration = useSyncExternalStore(
    subscribeGraphicsCapability,
    getGraphicsGeneration,
    getGraphicsGeneration,
  )

  useEffect(() => {
    const token = renderToken.current!
    if (!imagesEnabled) {
      // Clearing the state is what removes the box, and removing the box is
      // what erases the pixels. Doing it here rather than by returning early
      // from render keeps the hook order stable.
      setOverlay(null)
      setWithheld(false)
      return
    }
    // Guards a setState after unmount, and an earlier decode resolving after a
    // later one and overwriting it.
    let active = true
    renderPending.current = true
    // Registered in the effect, never during render: a render React throws away
    // would leave an entry nothing ends, and every image would wait out the cap.
    beginImageRender(token)
    void (async () => {
      try {
        const data = Buffer.from(base64, 'base64')

        // Only native graphics protocols are used for image pixels. If the
        // terminal or its geometry is not ready, keep the summary without
        // substituting a Unicode approximation.
        const wantsGraphics = resolveGraphicsProtocol() !== 'none'
        // Asked and answered before spending anything on an encode that
        // `renderGraphicsOverlay` would refuse anyway — and, unlike its own
        // guard, visible here, so the retry below knows the image is temporarily
        // withheld.
        const unsettled =
          wantsGraphics && hasMeasuredCellSize() && isCellGeometryStale()
        const overlay =
          !wantsGraphics || unsettled
            ? null
            : await renderGraphicsOverlay(
                data,
                maxColumns,
                effectiveRowBudget,
                undefined,
                kittyImageId.current!,
              )
        if (!active) return

        // Encoding is asynchronous, so a zoom can land inside it and leave the
        // payload already the wrong size for its box. The renderer withholds a
        // placement whose geometry disagrees with the current cell, which is
        // correct and would otherwise stand until something else happened to
        // announce. One more pass settles it.
        const cell = getCellPixelSize()
        const outdated =
          overlay !== null &&
          (overlay.cellWidth !== cell.width || overlay.cellHeight !== cell.height)
        // Lands together with the other images rendering right now, so a batch
        // of reads, or every image re-encoding after a resize, changes the
        // transcript once instead of once per image.
        applyWithBatch(token, () => {
          if (!active) return
          renderPending.current = false
          setOverlay(overlay)
          setWithheld(unsettled || outdated)
        })
      } catch (error) {
        logForDebugging(
          `InlineImage: native image failed — ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
        if (!active) return
        renderPending.current = false
        endImageRender(token)
        setOverlay(null)
        setWithheld(false)
      }
    })()
    return () => {
      active = false
      renderPending.current = false
      endImageRender(token)
    }
  }, [
    base64,
    maxColumns,
    effectiveRowBudget,
    capabilityGeneration,
    constraintGeneration,
    attempt,
    imagesEnabled,
  ])

  // The other half of the reconciliation above. Terminates by construction:
  // `withheld` can only be true while the cell geometry is unsettled or a
  // payload disagrees with it, and both resolve on their own — the stale mark
  // carries a deadline, and a re-encode against the current cell matches it.
  //
  // It only looks again once nothing is still rendering. A render under way
  // lands by itself, and restarting it throws its encode away: after a resize,
  // every encode slower than the retry interval was restarted over and over,
  // and the images stayed absent for seconds.
  useEffect(() => {
    if (!withheld || !imagesEnabled) return
    let timer: ReturnType<typeof setTimeout>
    const retry = (): void => {
      if (renderPending.current) {
        timer = setTimeout(retry, GRAPHICS_RETRY_MS)
        return
      }
      setAttempt(n => n + 1)
    }
    timer = setTimeout(retry, GRAPHICS_RETRY_MS)
    return () => clearTimeout(timer)
  }, [withheld, attempt, imagesEnabled])

  // Register the encoded payload for the renderer to draw over the box above.
  useLayoutEffect(() => {
    const id = placementId.current!
    const node = boxRef.current
    if (overlay?.placeholderLines && overlay.eraseSequence) {
      setGraphicsPlacement(id, null)
      registerKittyVirtualImage(
        id,
        overlay.sequence,
        overlay.eraseSequence,
      )
      return () => {
        unregisterKittyVirtualImage(id)
      }
    }
    if (!overlay || !node) {
      setGraphicsPlacement(id, null)
      return
    }
    // Register during the layout phase. Ink defers its terminal frame to a
    // microtask after layout effects, while passive effects run later. A
    // passive registration can therefore miss the only frame caused by this
    // state update and leave the native image absent until some unrelated
    // animation happens to repaint the transcript.
    //
    // Use the geometry captured by the encoder rather than reading it again
    // here. Zoom can land between encode and commit; relabelling an old-sized
    // payload with the new cell size would defeat the placement guard.
    setGraphicsPlacement(id, {
      node,
      sequence: overlay.sequence,
      eraseSequence: overlay.eraseSequence,
      rows: overlay.rows,
      columns: overlay.columns,
      cellWidth: overlay.cellWidth,
      cellHeight: overlay.cellHeight,
    })
    return () => {
      setGraphicsPlacement(id, null)
    }
  }, [overlay])

  const reservationLines = useMemo(
    () =>
      overlay
        ? (overlay.placeholderLines ??
          Array.from({ length: overlay.rows }, () =>
            ' '.repeat(overlay.columns),
          ))
        : [],
    [overlay],
  )

  if (!imagesEnabled || !overlay) return children

  return (
    <Box flexDirection="column">
      {children}
      {/* Kitty placeholders are scrollable image anchors; other protocols use
          blank cells for their out-of-band native image placement. */}
      <Box
        ref={boxRef}
        width={overlay.columns}
        height={overlay.rows}
        flexShrink={0}
      >
        <RawAnsi lines={reservationLines} width={overlay.columns} />
      </Box>
    </Box>
  )
}

/**
 * How many plots one notebook read previews. A notebook of training curves can
 * hold dozens of figures; rendering them all would bury the rest of the
 * transcript.
 */
const MAX_NOTEBOOK_PREVIEWS = 4

/** Shorter than a standalone image read, since several may stack. */
const NOTEBOOK_PREVIEW_ROWS = 24

/**
 * Structural shape of the notebook cell outputs read below.
 *
 * Declared locally and guarded at runtime because `src/types/notebook.js` is
 * absent from this tree — importing the nominal types would not compile, and
 * the payload arrives from a parsed `.ipynb` on disk, so it is untrusted
 * regardless.
 */
type NotebookCellLike = {
  outputs?: ReadonlyArray<
    { image?: { image_data?: unknown } | undefined } | undefined
  >
}

/** Base64 payloads of the first `limit` image outputs across all cells. */
export function collectNotebookImages(
  cells: readonly NotebookCellLike[] | undefined,
  limit: number = MAX_NOTEBOOK_PREVIEWS,
): string[] {
  const found: string[] = []
  for (const cell of cells ?? []) {
    for (const output of cell?.outputs ?? []) {
      const data = output?.image?.image_data
      if (typeof data === 'string' && data.length > 0) {
        found.push(data)
        if (found.length >= limit) return found
      }
    }
  }
  return found
}

/**
 * Renders the figures a notebook's cells already carry, beneath its summary.
 *
 * Jupyter stores executed plot output as a base64 `image/png` bundle inside the
 * `.ipynb` itself, so a matplotlib figure is displayable straight from a read —
 * nothing has to be re-executed or saved to a file first.
 */
export function NotebookImages({
  cells,
  children,
}: {
  cells: readonly NotebookCellLike[] | undefined
  children: React.ReactNode
}): React.ReactNode {
  const imagesEnabled = useSettings().inlineImagesEnabled !== false
  const images = useMemo(() => collectNotebookImages(cells), [cells])
  if (!imagesEnabled || images.length === 0) return children

  return (
    <Box flexDirection="column">
      {children}
      {images.map((base64, index) => (
        <InlineImage
          // Payload length disambiguates distinct figures at the same index
          // across re-renders; the index alone would reuse a stale decode.
          key={`${index}:${base64.length}`}
          base64={base64}
          maxRows={NOTEBOOK_PREVIEW_ROWS}
        >
          {null}
        </InlineImage>
      ))}
    </Box>
  )
}
