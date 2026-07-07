import fs from "node:fs";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box } from "../../ink.js";
import type { DOMElement } from "../../ink.js";
import { useOnRender } from "../../ink-picture/InkPictureProvider.js";
import { cursorForward } from "../../ink-picture/utils/ansiEscapes.js";
import { fetchImage, getPngBuffer } from "../../ink-picture/utils/image.js";
import generateKittyId from "../../ink-picture/utils/generateKittyId.js";
import {
  makeKittyDeletion,
  makeKittyPlacement,
  makeKittyTransmitChunks,
} from "../../ink-picture/renderers/kitty.js";
import usePosition from "../../ink-picture/hooks/usePosition.js";

/**
 * Direct terminal image display that bypasses Ink's rendering loop.
 *
 * Follows the approach from commit f6a6fdc (old timg):
 * - Writes Kitty protocol directly to process.stdout.fd (not through Ink's stdout)
 * - useEffect fires AFTER Ink's frame write (post-commit), so first placement
 *   runs after Ink's initial output
 * - useOnRender + setTimeout(0) handles re-placement on subsequent renders
 *   (useOnRender fires DURING commit, before Ink writes; setTimeout defers
 *    placement until after)
 * - Periodic re-placement via setInterval combats Ink overwrites from other
 *   re-renders (where our subtree may not re-render)
 * - Renders empty Box placeholder in Ink for correct TUI layout
 */
export function DirectImageDisplay({
  src,
  width,
  height,
  pixelWidth,
  pixelHeight,
}: {
  src: string;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
}) {
  const containerRef = useRef<DOMElement | null>(null);
  const position = usePosition(containerRef);

  const [imageData, setImageData] = useState<Buffer | undefined>(undefined);

  // ── Load image via Jimp ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const image = await fetchImage(src);
        if (!image || cancelled) return;
        image.cover({ w: pixelWidth, h: pixelHeight });
        const png = await getPngBuffer(image);
        if (!cancelled) {
          setImageData(png.data);
        }
      } catch {
        // Image load failed — nothing to display
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [src, pixelWidth, pixelHeight]);

  // ── Refs for values used in placement callback (stable identity) ──
  const imageIdRef = useRef<number | undefined>(undefined);
  const positionRef = useRef(position);
  positionRef.current = position;
  const dimsRef = useRef({ w: width, h: height });
  dimsRef.current = { w: width, h: height };

  // ── Transmit image data to terminal GPU memory ──
  // Uses fs.writeSync to bypass Ink's stdout buffering.
  useEffect(() => {
    if (!imageData) return;

    const id = generateKittyId();
    const base64Data = imageData.toString("base64");
    const chunks = makeKittyTransmitChunks(id, base64Data);
    const fd = process.stdout.fd;
    for (const chunk of chunks) {
      fs.writeSync(fd, chunk);
    }
    imageIdRef.current = id;
  }, [imageData]);

  // ── Place image with position-aware cursor movement ──
  const placeImage = useCallback(() => {
    const id = imageIdRef.current;
    if (!id) return;

    const pos = positionRef.current;
    if (!pos) return;

    const { w, h } = dimsRef.current;
    if (h <= 0) return;

    // Calculate cursor-up distance (same logic as cursorUp() in ansiEscapes.ts)
    // Note: terminalHeight is in character rows (process.stdout.rows),
    // NOT terminalInfo.terminalHeight which is in pixels.
    const terminalHeight = process.stdout.rows;
    const cursorUpCount = pos.appHeight - pos.row;
    const movementCount =
      pos.appHeight >= terminalHeight ? cursorUpCount - 1 : cursorUpCount;

    const fd = process.stdout.fd;
    const parts: Buffer[] = [
      Buffer.from(`\x1b7`), // save cursor (DECSC)
    ];
    if (movementCount > 0) {
      parts.push(Buffer.from(`\x1b[${movementCount}A`)); // cursor up to image row
    }
    parts.push(
      Buffer.from(`\r`), // carriage return to col 0
      Buffer.from(cursorForward(pos.col)), // forward to image column
      Buffer.from(makeKittyPlacement(id, 1, w, h)),
      Buffer.from(`\x1b8`), // restore cursor (DECRC)
    );
    fs.writeSync(fd, Buffer.concat(parts));
  }, []);

  // ── First placement: after Ink writes its initial frame ──
  // useEffect fires AFTER React's commit phase (which includes Ink's terminal
  // output). So calling placeImage() directly here runs after Ink's frame write.
  useEffect(() => {
    if (!imageIdRef.current) return;
    if (!position) return;

    placeImage();
  }, [imageData, position, placeImage]);

  // ── Re-place after each React render ──
  // useOnRender fires DURING the commit phase (via Profiler), BEFORE Ink writes
  // its frame to the terminal. So we use setTimeout(0) to defer the placement
  // until after Ink's synchronous frame write completes.
  useOnRender(() => {
    const id = imageIdRef.current;
    if (!id) return;

    setTimeout(() => {
      placeImage();
    }, 0);
  });

  // ── Periodic re-placement to combat Ink overwrites from OTHER re-renders ──
  // When other parts of Codev re-render (e.g. new message arrives), Ink rewrites
  // the entire frame. Our subtree might not re-render, so useOnRender won't fire.
  // This interval ensures the image stays visible.
  useEffect(() => {
    const interval = setInterval(() => {
      placeImage();
    }, 500);

    return () => clearInterval(interval);
  }, [placeImage]);

  // ── Cleanup: delete image from terminal GPU memory ──
  useEffect(() => {
    return () => {
      const id = imageIdRef.current;
      if (id) {
        const fd = process.stdout.fd;
        fs.writeSync(fd, makeKittyDeletion(id));
      }
    };
  }, []);

  // ── Empty placeholder for correct TUI layout ──
  // Renders invisible Box with correct height so Ink reserves the right
  // number of character cells. The actual image is drawn via Kitty protocol.
  return <Box ref={containerRef} height={height} flexDirection="column" />;
}
