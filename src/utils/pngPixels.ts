import { Buffer } from 'buffer'
import { PNG } from 'pngjs'

export type PngPixels = {
  data: Buffer
  info: { width: number; height: number; channels: 4 }
}

export function decodePngPixels(imageData: Buffer): PngPixels | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (signature.some((byte, index) => imageData[index] !== byte)) {
    return null
  }
  const decoded = PNG.sync.read(imageData)
  return {
    data: decoded.data,
    info: {
      width: decoded.width,
      height: decoded.height,
      channels: 4,
    },
  }
}

export function resizePngPixels(
  source: PngPixels,
  width: number,
  height: number,
): PngPixels {
  const { data, info } = source
  if (info.width === width && info.height === height) return source

  const resized = Buffer.allocUnsafe(width * height * 4)
  for (let y = 0; y < height; y++) {
    const y0 = (y * info.height) / height
    const y1 = ((y + 1) * info.height) / height
    for (let x = 0; x < width; x++) {
      const x0 = (x * info.width) / width
      const x1 = ((x + 1) * info.width) / width
      let totalWeight = 0
      let red = 0
      let green = 0
      let blue = 0
      let alpha = 0

      for (let sourceY = Math.floor(y0); sourceY < Math.ceil(y1); sourceY++) {
        const weightY = Math.min(y1, sourceY + 1) - Math.max(y0, sourceY)
        for (
          let sourceX = Math.floor(x0);
          sourceX < Math.ceil(x1);
          sourceX++
        ) {
          const weight =
            weightY * (Math.min(x1, sourceX + 1) - Math.max(x0, sourceX))
          const offset = (sourceY * info.width + sourceX) * 4
          const pixelAlpha = data[offset + 3]! / 255
          red += data[offset]! * pixelAlpha * weight
          green += data[offset + 1]! * pixelAlpha * weight
          blue += data[offset + 2]! * pixelAlpha * weight
          alpha += pixelAlpha * weight
          totalWeight += weight
        }
      }

      const targetOffset = (y * width + x) * 4
      resized[targetOffset] =
        alpha === 0 ? 0 : Math.round(red / alpha)
      resized[targetOffset + 1] =
        alpha === 0 ? 0 : Math.round(green / alpha)
      resized[targetOffset + 2] =
        alpha === 0 ? 0 : Math.round(blue / alpha)
      resized[targetOffset + 3] = Math.round((alpha / totalWeight) * 255)
    }
  }

  return {
    data: resized,
    info: { width, height, channels: 4 },
  }
}

export function encodePngPixels(pixels: PngPixels): Buffer {
  return PNG.sync.write({
    width: pixels.info.width,
    height: pixels.info.height,
    data: pixels.data,
  })
}
