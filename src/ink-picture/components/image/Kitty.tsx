import { useStdout } from "src/ink";
import fs from "node:fs";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useOnRender } from "../../InkPictureProvider.js";
import { cursorForward } from "../../utils/ansiEscapes.js";
import { useImage } from "../../hooks/useImage.js";
import { useMeasuredSize } from "../../hooks/useMeasuredSize.js";
import usePosition from "../../hooks/usePosition.js";
import { defaultVisibility } from "../../hooks/useVisibility.js";
import { useTerminalInfo } from "../../InkPictureProvider.js";
import {
  makeKittyDeletion,
  makeKittyPlacement,
  makeKittyTransmitChunks,
} from "../../renderers/kitty.js";
import generateKittyId from "../../utils/generateKittyId.js";
import ImageBox from "../ImageBox.js";
import type { ImageProps } from "./protocol.js";

function KittyImage(props: ImageProps) {
  const terminalInfo = useTerminalInfo();
  const { stdout } = useStdout();
  const { src, width, height, pixelWidth, pixelHeight, alt } = props;

  const { containerRef, resolvedWidth, resolvedHeight } = useMeasuredSize(
    width,
    height,
  );
  const position = usePosition(containerRef);

  // Use external pixel dimensions if provided, otherwise compute from chars
  const actualPixelWidth = pixelWidth ?? resolvedWidth * (terminalInfo?.cellWidth ?? 0);
  const actualPixelHeight = pixelHeight ?? resolvedHeight * (terminalInfo?.cellHeight ?? 0);

  const { imageData, error } = useImage({
    src,
    pixelWidth: actualPixelWidth,
    pixelHeight: actualPixelHeight,
    mode: "png",
  });

  const [imageId, setImageId] = useState<number | undefined>(undefined);
  const shouldCleanupRef = useRef(true);
  const imageIdRef = useRef<number | undefined>(undefined);
  const dimsRef = useRef({ w: resolvedWidth, h: resolvedHeight });
  dimsRef.current = { w: resolvedWidth, h: resolvedHeight };

  // One-time transmit: store image data in terminal GPU memory.
  // Uses fs.writeSync to process.stdout.fd to bypass Ink's stdout buffering.
  useEffect(() => {
    if (!imageData) return;

    const id = generateKittyId();
    const base64Data = imageData.data.toString("base64");
    const chunks = makeKittyTransmitChunks(id, base64Data);
    const fd = process.stdout.fd;
    for (const chunk of chunks) {
      fs.writeSync(fd, chunk);
    }
    imageIdRef.current = id;
    setImageId(id);
  }, [imageData]);

  // Place the image using position-aware cursor movement. This uses the
  // same logic as ink-picture's writeImageToStdout / useDirectRenderer:
  // it saves cursor → cursorUp(appHeight - row) → CR → cursorForward(col)
  // → Kitty placement → restores cursor.
  //
  // The cursorUp formula accounts for Ink's trailing-newline quirk: when
  // content fills the viewport (appHeight >= terminalHeight) Ink omits the
  // extra newline, so we subtract 1 from the movement count.
  useOnRender(() => {
    const id = imageIdRef.current;
    if (!id) return;
    const pos = position;
    if (!pos) return;
    const { w, h } = dimsRef.current;
    if (h <= 0) return;

    // Skip if the image is not fully visible in the viewport
    const visibility = defaultVisibility(pos, stdout.rows, stdout.columns);
    if (visibility !== "full") return;

    // Calculate cursor-up distance using the same logic as cursorUp() in
    // ansiEscapes.ts, inlined here to avoid importing the helper.
    const appHeight = pos.appHeight;
    const terminalHeight = stdout.rows;
    const cursorUpCount = appHeight - pos.row;
    const movementCount =
      appHeight >= terminalHeight ? cursorUpCount - 1 : cursorUpCount;
    if (movementCount <= 0) return;

    // Write directly to the terminal fd, bypassing Ink's stdout (which may
    // buffer, intercept, or be overwritten by Ink's screen refresh cycle).
    const fd = process.stdout.fd;
    const buf = Buffer.concat([
      Buffer.from(`\x1b7`),                           // save cursor (DECSC)
      Buffer.from(`\x1b[${movementCount}A`),          // cursor up to image row
      Buffer.from(`\r`),                               // carriage return to col 0
      Buffer.from(cursorForward(pos.col)),             // forward to image column
      Buffer.from(makeKittyPlacement(id, 1, w, h)),
      Buffer.from(`\x1b8`),                           // restore cursor (DECRC)
    ]);
    fs.writeSync(fd, buf);
  });

  const onExit = useCallback(() => {
    shouldCleanupRef.current = false;
  }, []);

  const onSigInt = useCallback(() => {
    shouldCleanupRef.current = false;
    process.exit();
  }, []);

  useEffect(() => {
    process.on("exit", onExit);
    process.on("SIGINT", onSigInt);
    process.on("SIGTERM", onSigInt);

    return () => {
      process.removeListener("exit", onExit);
      process.removeListener("SIGINT", onSigInt);
      process.removeListener("SIGTERM", onSigInt);
      if (!shouldCleanupRef.current) return;
      if (!imageId) return;
      const fd = process.stdout.fd;
      fs.writeSync(fd, makeKittyDeletion(imageId));
    };
  }, [imageId, onExit, onSigInt]);

  return (
    <ImageBox
      ref={containerRef}
      width={width}
      height={height}
      alt={alt}
      error={error}
      loaded={!!imageId}
    />
  );
}

export default KittyImage;
