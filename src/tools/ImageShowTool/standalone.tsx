#!/usr/bin/env bun
/**
 * Standalone visual test: display a local image or URL using ink-picture + Ink.
 *
 * Usage:
 *   bun run src/tools/ImageShowTool/standalone.tsx [path|url]
 *
 * Examples:
 *   bun run src/tools/ImageShowTool/standalone.tsx ~/Pictures/image.png
 *   bun run src/tools/ImageShowTool/standalone.tsx https://example.com/image.jpg
 */

import { useEffect, useState } from "react";
import { render, Box, Text, useApp } from "ink";
import {
  getImagePath,
  isUrl,
  loadImage,
  calculateDimensions,
  type ImageDimensions,
} from "./ImageShowTool.ts";
import { ImageDisplay } from "./UI.js";

const args = process.argv.slice(2);
const IMAGE_PATH = getImagePath(args);

function App() {
  const { exit } = useApp();
  const [dimensions, setDimensions] = useState<ImageDimensions | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const image = await loadImage(IMAGE_PATH);
        const dims = calculateDimensions(
          image.bitmap.width,
          image.bitmap.height,
          process.stdout.rows ?? 24,
        );
        setDimensions(dims);
      } catch (e) {
        console.error(e);
        setErr(true);
        exit();
      }
    })();
  }, [exit]);

  useEffect(() => {
    const handleSigint = () => exit();
    process.on("SIGINT", handleSigint);
    return () => {
      process.off("SIGINT", handleSigint);
    };
  }, [exit]);

  if (err) {
    return <Text color="red">Failed to fetch: {IMAGE_PATH}</Text>;
  }

  if (!dimensions) {
    return <Text>Loading...</Text>;
  }

  return (
    <Box flexDirection="column">
      <ImageDisplay
        src={IMAGE_PATH}
        width={dimensions.width}
        height={dimensions.height}
        pixelWidth={dimensions.pixelWidth}
        pixelHeight={dimensions.pixelHeight}
      />
    </Box>
  );
}

const { waitUntilExit } = render(<App />);
await waitUntilExit();
