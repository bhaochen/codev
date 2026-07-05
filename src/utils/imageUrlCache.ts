import { createHash } from 'crypto'
import { mkdir, open, rm } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { logForDebugging } from './debug.js'

const IMAGE_CACHE_DIR = 'image-cache'
const URL_CACHE_SUBDIR = 'url-cache'
const MAX_URL_CACHED_IMAGES = 100
const MAX_DOWNLOAD_SIZE_BYTES = 10_000_000 // 10 MB limit

export interface CachedImage {
  buffer: Buffer
  format: string
  mediaType: string
  path: string
}

// In-memory cache to avoid repeated downloads
const urlImageCache = new Map<string, CachedImage>()

/**
 * Get the cache directory for URL-downloaded images.
 */
function getUrlCacheDir(): string {
  return join(getClaudeConfigHomeDir(), IMAGE_CACHE_DIR, URL_CACHE_SUBDIR)
}

/**
 * Ensure the URL cache directory exists.
 */
async function ensureUrlCacheDir(): Promise<void> {
  await mkdir(getUrlCacheDir(), { recursive: true })
}

/**
 * Compute a hash of a URL for use as a cache filename.
 */
function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 16)
}

/**
 * Determine image format from Content-Type header or URL extension.
 */
function detectFormat(url: string, contentType: string): string {
  // Prefer Content-Type header
  if (contentType) {
    const mime = contentType.split('/')[1]?.toLowerCase()
    if (mime && ['png', 'jpeg', 'jpg', 'gif', 'webp'].includes(mime)) {
      return mime === 'jpg' ? 'jpeg' : mime
    }
  }

  // Fall back to URL extension
  const cleanUrl = url.split('?')[0]!.split('#')[0]!
  const ext = cleanUrl.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    return ext === 'jpg' ? 'jpeg' : ext
  }

  return 'png' // default
}

/**
 * Determine media type from format string.
 */
function formatToMediaType(format: string): string {
  return `image/${format === 'jpeg' ? 'jpeg' : format}`
}

/**
 * Download an image from a URL, cache it to disk, and return the buffer,
 * format, and local path.
 *
 * Skips download if the image is already in the in-memory or disk cache.
 * Limits download size to MAX_DOWNLOAD_SIZE_BYTES.
 *
 * @param url - The image URL to download
 * @returns CachedImage or null if download fails
 */
export async function downloadImage(url: string): Promise<CachedImage | null> {
  // Check in-memory cache first
  const cached = urlImageCache.get(url)
  if (cached) {
    return cached
  }

  // Check disk cache
  try {
    const cacheDir = getUrlCacheDir()
    const hash = hashUrl(url)
    const files = await readdirSafe(cacheDir)
    for (const file of files) {
      if (file.startsWith(hash)) {
        // Found cached file
        const parts = file.split('.')
        const format = parts.length > 1 ? parts[parts.length - 1]! : 'png'
        const fh = await open(join(cacheDir, file), 'r')
        try {
          const buffer = await fh.readFile()
          const result: CachedImage = {
            buffer,
            format,
            mediaType: formatToMediaType(format),
            path: join(cacheDir, file),
          }
          urlImageCache.set(url, result)
          logForDebugging(`Image URL cache hit: ${url}`)
          return result
        } finally {
          await fh.close()
        }
      }
    }
  } catch {
    // Disk cache miss or directory doesn't exist — proceed to download
  }

  // Download the image
  try {
    logForDebugging(`Downloading image: ${url}`)
    const response = await fetch(url, {
      headers: {
        // Some image hosts block requests without a browser-like User-Agent
        'User-Agent':
          'Mozilla/5.0 (compatible; Codev/1.0; +https://chenbhao.dev)',
      },
      // Follow up to 5 redirects (e.g. Wikimedia CDN redirects)
      redirect: 'follow',
    })

    if (!response.ok) {
      // Surface the error so users can see it during testing
      console.error(`[InlineImage] Download failed (HTTP ${response.status}): ${url}`)
      logForDebugging(`Image download failed (${response.status}): ${url}`)
      return null
    }

    // Check content-length if available
    const contentLength = response.headers.get('content-length')
    if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_SIZE_BYTES) {
      logForDebugging(`Image too large (${contentLength} bytes): ${url}`)
      return null
    }

    const contentType = response.headers.get('content-type') ?? ''
    const format = detectFormat(url, contentType)

    // Stream the response with a size limit
    const reader = response.body?.getReader()
    if (!reader) {
      return null
    }

    const chunks: Uint8Array[] = []
    let totalSize = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalSize += value.byteLength
      if (totalSize > MAX_DOWNLOAD_SIZE_BYTES) {
        logForDebugging(`Image download exceeded size limit: ${url}`)
        reader.cancel()
        return null
      }
      chunks.push(value)
    }

    // Combine chunks
    const combinedLength = chunks.reduce((acc, c) => acc + c.byteLength, 0)
    const combined = new Uint8Array(combinedLength)
    let offset = 0
    for (const chunk of chunks) {
      combined.set(chunk, offset)
      offset += chunk.byteLength
    }

    const buffer = Buffer.from(combined.buffer)

    // Cache to disk
    try {
      await ensureUrlCacheDir()
      const ext = format
      const cachePath = join(getUrlCacheDir(), `${hashUrl(url)}.${ext}`)
      const fh = await open(cachePath, 'w', 0o600)
      try {
        await fh.writeFile(buffer)
        await fh.datasync()
      } finally {
        await fh.close()
      }

      const result: CachedImage = {
        buffer,
        format,
        mediaType: formatToMediaType(format),
        path: cachePath,
      }

      // Store in memory cache
      evictOldestIfAtCap()
      urlImageCache.set(url, result)

      logForDebugging(`Cached image: ${url} -> ${cachePath}`)
      return result
    } catch (cacheError) {
      // Cache write failed, still return the buffer
      logForDebugging(`Failed to cache image to disk: ${cacheError}`)
      return {
        buffer,
        format,
        mediaType: formatToMediaType(format),
        path: '',
      }
    }
  } catch (error) {
    logForDebugging(`Image download error: ${error}`)
    return null
  }
}

/**
 * Read directory contents safely (returns empty array on error).
 */
async function readdirSafe(dir: string): Promise<string[]> {
  try {
    const { readdir } = await import('fs/promises')
    const entries = await readdir(dir, { withFileTypes: false })
    return entries as string[]
  } catch {
    return []
  }
}

/**
 * Evict oldest in-memory cache entry if at capacity.
 */
function evictOldestIfAtCap(): void {
  while (urlImageCache.size >= MAX_URL_CACHED_IMAGES) {
    const oldest = urlImageCache.keys().next().value
    if (oldest !== undefined) {
      urlImageCache.delete(oldest)
    } else {
      break
    }
  }
}

/**
 * Clear the in-memory URL image cache.
 */
export function clearUrlImageCache(): void {
  urlImageCache.clear()
}
