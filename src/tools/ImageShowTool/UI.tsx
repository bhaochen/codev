#!/usr/bin/env bun
/**
 * Visual test: display a local image or URL using ink-picture + Ink.
 */

import { useEffect, useState } from "react";
import { render, Box, Text, useApp } from "ink";
import Image, { InkPictureProvider } from "../../ink-picture/index.ts";
import {
  getImagePath,
  isUrl,
  loadImage,
  calculateDimensions,
  type ImageDimensions,
} from "./ImageShowTool.ts";

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
          process.stdout.columns ?? 80
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
      <InkPictureProvider>
        <Image
          src={IMAGE_PATH}
          width={dimensions.width}
          height={dimensions.height}
          pixelWidth={dimensions.pixelWidth}
          pixelHeight={dimensions.pixelHeight}
          alt={isUrl(IMAGE_PATH) ? "url-image" : "local-image"}
        />
      </InkPictureProvider>
    </Box>
  );
}

const { waitUntilExit } = render(<App />);
await waitUntilExit();
