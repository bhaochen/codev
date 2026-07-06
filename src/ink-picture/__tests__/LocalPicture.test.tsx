#!/usr/bin/env bun
/**
 * Visual test: display a local image using ink-picture + Ink.
 *
 * Height is auto-calculated from the original aspect ratio:
 * only width is fixed (60% of terminal columns).
 *
 * Usage:
 *   bun run src/ink-picture/__tests__/LocalPicture.test.tsx
 */

import { Jimp } from "jimp";
import React, { useEffect, useState } from "react";
import { render, Box, Text, useApp } from "ink";
import Image, { InkPictureProvider } from "../index.ts";

const IMAGE_PATH = "/home/yuki/Pictures/Wallpapers/3god.jpg";

function App() {
  const { exit } = useApp();
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const image = await Jimp.read(IMAGE_PATH);
        const origW = image.bitmap.width;
        const origH = image.bitmap.height;
        const cols = process.stdout.columns ?? 80;
        const targetW = Math.floor(cols * 0.6);
        const targetH = Math.floor(targetW * (origH / origW) / 2);
        setDimensions({ width: targetW, height: targetH });
      } catch {
        setErr(true);
      }
    })();
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => exit(), 3000);
    return () => clearTimeout(timer);
  }, [exit]);

  if (err) {
    return <Text color="red">Failed to load image</Text>;
  }

  if (!dimensions) {
    return <Text>Loading...</Text>;
  }

  return (
    <Box flexDirection="column">
      <InkPictureProvider>
        <Image
          src={IMAGE_PATH}
          width={dimensions.width}
          height={dimensions.height}
          alt="3god"
        />
      </InkPictureProvider>
    </Box>
  );
}

const { waitUntilExit } = render(<App />);
await waitUntilExit();
