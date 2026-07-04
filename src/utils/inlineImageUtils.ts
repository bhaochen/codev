import { downloadImage } from './imageUrlCache.js'
import { logForDebugging } from './debug.js'

const IMAGE_URL_PATTERNS = [
  /https?:\/\/[^\s<>\"')\]]+\.(?:jpg|jpeg|png|gif|webp)(?:[^\s<>\"'\]]*)/gi,
  /https?:\/\/[^\s<>\"')\]]+(?:store\.is\.autonavi\.com|maps\.google\.com|upload\.wikimedia\.org)[^\s<>\"'\]]*/gi,
]

export interface InlineImage {
  url: string
  base64: string
  mediaType: string
}

export function detectImageUrls(text: string): string[] {
  const urls = new Set<string>()
  for (const pattern of IMAGE_URL_PATTERNS) {
    const matches = text.matchAll(pattern)
    for (const match of matches) {
      if (match[0]) {
        urls.add(match[0])
      }
    }
  }
  return Array.from(urls)
}

export async function fetchImagesAsInline(
  urls: string[],
  maxImages = 4,
): Promise<InlineImage[]> {
  const uniqueUrls = [...new Set(urls)].slice(0, maxImages)
  const results: InlineImage[] = []

  await Promise.all(
    uniqueUrls.map(async (url) => {
      try {
        const cached = await downloadImage(url)
        if (cached) {
          results.push({
            url,
            base64: cached.buffer.toString('base64'),
            mediaType: cached.mediaType,
          })
        }
      } catch (err) {
        logForDebugging(`fetchImagesAsInline: failed to fetch ${url}: ${err}`)
      }
    }),
  )

  return results
}