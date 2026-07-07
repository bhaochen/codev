import fs from "node:fs";
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { Box, Text } from "../../ink.js";
import type { DOMElement } from "../../ink.js";
import { MessageResponse } from "../../components/MessageResponse.js";
import { useOnRender, InkPictureProvider } from "../../ink-picture/InkPictureProvider.js";
import { cursorForward } from "../../ink-picture/utils/ansiEscapes.js";
import usePosition from "../../ink-picture/hooks/usePosition.js";
import type { ImageShowOutput } from "./ImageShowTool.js";
import { detectTerminalCaps } from "./detectTerminal.js";

// ── Timg-based image display ──
// Writes a pre-generated Kitty protocol sequence (from timg) directly to the
// terminal fd via fs.writeSync, completely bypassing Ink's rendering loop.
// An empty Box placeholder reserves character cells in Ink's virtual DOM so
// the TUI layout stays intact — the actual image is drawn on the terminal
// framebuffer without interference.
//
// To prevent duplicate placements (each Kitty protocol write creates a new
// image at the cursor position):
//   - Position dedup: skip if the component hasn't moved since last write
//   - Delete before write: send \x1b_Ga=d,d=I,i=ID to remove old image first
//   - No periodic polling: remove the 500ms interval that caused duplicates

function TimgDisplay({
  kittySequence,
  width,
  height,
}: {
  kittySequence: string;
  width: number;
  height: number;
}) {
  const containerRef = useRef<DOMElement | null>(null);
  const position = usePosition(containerRef);

  // Extract image ID from timg's Kitty sequence: "a=T,i=645096449,..."
  const imageIdRef = useRef(extractKittyImageId(kittySequence));
  const positionRef = useRef(position);
  positionRef.current = position;
  const dimsRef = useRef({ w: width, h: height });
  dimsRef.current = { w: width, h: height };

  // ── Dedup: skip if position hasn't changed since last write ──
  const hasPlacedRef = useRef(false);
  const lastPosKeyRef = useRef<string | null>(null);

  const displayImage = useCallback(() => {
    const pos = positionRef.current;
    if (!pos) return;

    // Skip entirely if image already placed at this exact position
    const posKey = `${pos.col},${pos.row},${pos.appHeight}`;
    if (hasPlacedRef.current && posKey === lastPosKeyRef.current) return;
    lastPosKeyRef.current = posKey;

    const fd = process.stdout.fd;
    const parts: Buffer[] = [Buffer.from(`\x1b7`)]; // save cursor (DECSC)

    // Delete previous image before placing new one (prevents duplicates)
    const imageId = imageIdRef.current;
    if (hasPlacedRef.current && imageId > 0) {
      parts.push(Buffer.from(`\x1b_Ga=d,d=I,i=${imageId}\x1b\\`));
    }

    // Position cursor at the component's row/col
    const terminalHeight = process.stdout.rows;
    const cursorUpCount = pos.appHeight - pos.row;
    const movementCount =
      pos.appHeight >= terminalHeight ? cursorUpCount - 1 : cursorUpCount;
    if (movementCount > 0) {
      parts.push(Buffer.from(`\x1b[${movementCount}A`));
    }
    parts.push(
      Buffer.from(`\r`),
      Buffer.from(cursorForward(pos.col)),
    );

    // Full timg sequence (transmit + auto-display at cursor)
    parts.push(Buffer.from(kittySequence), Buffer.from(`\x1b8`)); // restore cursor

    fs.writeSync(fd, Buffer.concat(parts));
    hasPlacedRef.current = true;
  }, [kittySequence]);

  // First display: useEffect fires AFTER Ink's frame write (post-commit)
  useEffect(() => {
    if (!position) return;
    displayImage();
  }, [kittySequence, position, displayImage]);

  // Re-display on Ink render: useOnRender fires DURING commit (before Ink
  // writes), so setTimeout(0) defers until after Ink's frame. The dedup
  // check in displayImage prevents writing if position hasn't changed.
  useOnRender(() => {
    setTimeout(() => {
      displayImage();
    }, 0);
  });

  // Empty placeholder for correct TUI layout
  return <Box ref={containerRef} height={height} flexDirection="column" />;
}

/** Extract Kitty image ID from a timg-generated protocol sequence. */
function extractKittyImageId(sequence: string): number {
  const match = sequence.match(/i=(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

// ── Image display component ──
// Uses timg-generated Kitty protocol sequence when available, otherwise
// falls back to a text-only summary.

export function ImageDisplay({
  src,
  width,
  height,
  pixelWidth,
  pixelHeight,
  kittySequence,
}: {
  src: string;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  kittySequence?: string;
}) {
  const terminalInfo = useMemo(() => detectTerminalCaps(), []);
  const supportsKittyGraphics = terminalInfo.supportsKittyGraphics === true;

  if (kittySequence && supportsKittyGraphics) {
    return (
      <Box flexDirection="column">
        <InkPictureProvider terminalInfo={terminalInfo}>
          <TimgDisplay
            kittySequence={kittySequence}
            width={width}
            height={height}
          />
        </InkPictureProvider>
      </Box>
    );
  }

  // Fallback: text-only summary
  return (
    <MessageResponse height={1}>
      <Text dimColor>Image: {src}</Text>
    </MessageResponse>
  );
}

// ── Tool rendering functions ──

export function renderToolUseMessage(
  { src }: { src?: string },
  { verbose }: { theme?: string; verbose: boolean },
): React.ReactNode {
  if (!src) return null;
  if (verbose) return `src: "${src}"`;
  return src;
}

export function renderToolUseProgressMessage(): React.ReactNode {
  return (
    <MessageResponse height={1}>
      <Text dimColor>Rendering image…</Text>
    </MessageResponse>
  );
}

export function renderToolResultMessage(
  output: ImageShowOutput,
  _progressMessages: unknown[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const { src, success, width, height, pixelWidth, pixelHeight, kittySequence } = output;

  if (!success) {
    return (
      <MessageResponse height={1}>
        <Text color="red">Failed to display: {src}</Text>
      </MessageResponse>
    );
  }

  // Render the image when we have dimension data
  if (width && height && pixelWidth && pixelHeight) {
    return (
      <ImageDisplay
        src={src}
        width={width}
        height={height}
        pixelWidth={pixelWidth}
        pixelHeight={pixelHeight}
        kittySequence={kittySequence}
      />
    );
  }

  // Fallback: text-only summary
  return (
    <MessageResponse height={1}>
      <Text>
        Image displayed: <Text bold>{src}</Text>
      </Text>
    </MessageResponse>
  );
}

export function getToolUseSummary(input: { src?: string } | undefined): string | null {
  if (!input?.src) return null;
  return input.src.length > 80 ? input.src.slice(0, 77) + "..." : input.src;
}
