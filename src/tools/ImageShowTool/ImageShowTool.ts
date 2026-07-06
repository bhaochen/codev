import { Jimp } from "jimp";
import { loadImageFromUrl } from "../../ink-picture/utils/jimpURL.ts";

export const CELL_WIDTH = 8;
export const CELL_HEIGHT = 16;

export interface ImageDimensions {
  width: number;        // 字符宽度
  height: number;       // 字符高度
  pixelWidth: number;   // 像素宽度
  pixelHeight: number;  // 像素高度
}

export function getImagePath(args: string[]): string {
  return args[0] || "/home/yuki/Pictures/Wallpapers/3god.jpg";
}

export function isUrl(path: string): boolean {
  return path.startsWith("http://") || path.startsWith("https://");
}

export async function loadImage(path: string) {
  if (isUrl(path)) {
    return loadImageFromUrl(path);
  } else {
    return Jimp.read(path);
  }
}

export function calculateDimensions(
  imageWidth: number,
  imageHeight: number,
  terminalCols: number
): ImageDimensions {
  const targetW_chars = Math.floor(terminalCols * 0.1618);
  const targetW_pixels = targetW_chars * CELL_WIDTH;
  const targetH_pixels = Math.floor(targetW_pixels * (imageHeight / imageWidth));
  const minH_pixels = 3 * CELL_HEIGHT;
  const finalH_pixels = Math.max(targetH_pixels, minH_pixels);
  const targetH_chars = Math.ceil(finalH_pixels / CELL_HEIGHT);

  return {
    width: targetW_chars,
    height: targetH_chars,
    pixelWidth: targetW_pixels,
    pixelHeight: finalH_pixels,
  };
}
