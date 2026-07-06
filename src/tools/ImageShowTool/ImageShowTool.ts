#!/usr/bin/env bun
/**
 * Visual test: display a local image or URL using ink-picture + Ink.
 *
 * Usage:
 *   bun run src/ink-picture/__tests__/LocalPicture.test.tsx [path|url]
 *
 * Examples:
 *   bun run src/ink-picture/__tests__/LocalPicture.test.tsx ~/Pictures/IMAGE/image.png
 *   bun run src/ink-picture/__tests__/LocalPicture.test.tsx https://example.com/image.jpg
 */

import { Jimp } from "jimp";
import React, { useEffect, useState } from "react";
import { render, Box, Text, useApp } from "ink";
import Image, { InkPictureProvider } from "../../ink-picture/index.ts";
import { loadImageFromUrl } from "../../ink-picture/utils/jimpURL.ts";

// 终端字符尺寸（像素）
const CELL_WIDTH = 8;
const CELL_HEIGHT = 16;

// 获取命令行参数
const args = process.argv.slice(2);
const IMAGE_PATH = args[0] || "/home/yuki/Pictures/Wallpapers/3god.jpg";

// 判断是 URL 还是本地路径
const isUrl = IMAGE_PATH.startsWith("http://") || IMAGE_PATH.startsWith("https://");

// 加载图片（支持本地和 URL）
async function loadImage(path: string) {
  if (isUrl) {
    return loadImageFromUrl(path);
  } else {
    return Jimp.read(path);
  }
}

function App() {
  const { exit } = useApp();
  const [dimensions, setDimensions] = useState<{
    width: number;
    height: number;
    pixelWidth: number;
    pixelHeight: number;
  } | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const image = await loadImage(IMAGE_PATH);
        const origW = image.bitmap.width;
        const origH = image.bitmap.height;
        const cols = process.stdout.columns ?? 80;

        const targetW_chars = Math.floor(cols * 0.1618);
        const targetW_pixels = targetW_chars * CELL_WIDTH;
        const targetH_pixels = Math.floor(targetW_pixels * (origH / origW));
        const minH_pixels = 3 * CELL_HEIGHT;
        const finalH_pixels = Math.max(targetH_pixels, minH_pixels);
        const targetH_chars = Math.ceil(finalH_pixels / CELL_HEIGHT);

        setDimensions({
          width: targetW_chars,
          height: targetH_chars,
          pixelWidth: targetW_pixels,
          pixelHeight: finalH_pixels,
        });
      } catch (e) {
        console.error(e);
        setErr(true);
        exit();
      }
    })();
  }, []);

  useEffect(() => {
    const handleSigint = () => exit();
    process.on("SIGINT", handleSigint);
    return () => process.off("SIGINT", handleSigint);
  }, [exit]);

  if (err) {
    return <Text color="red" > Failed to fetch: { IMAGE_PATH } </Text>;
  }

  if (!dimensions) {
    return <Text>Loading...</Text>;
  }

  return (
    <Box flexDirection= "column" >
    <InkPictureProvider>
    <Image
          src={ IMAGE_PATH }
  width = { dimensions.width }
  height = { dimensions.height }
  pixelWidth = { dimensions.pixelWidth }
  pixelHeight = { dimensions.pixelHeight }
  alt = { isUrl? "url-image": "local-image" }
    />
    </InkPictureProvider>
    </Box>
  );
}

const { waitUntilExit } = render(<App />);
await waitUntilExit();
