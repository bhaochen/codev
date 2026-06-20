/**
 * Static file serving for the Friend VRM frontend.
 *
 * Serves the built Vite/React frontend from src/components/friend/frontend/dist/ at /friend/*.
 * All asset files (VRM, FBX, VRMA, VMD, MP3) are in the dist root and served
 * under /friend/<filename>.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CACHEABLE_RE = /^\/friend\/assets\//
const MIME_TYPES: Record<string, string> = {
  '.vrm': 'application/octet-stream',
  '.fbx': 'application/octet-stream',
  '.vrma': 'application/octet-stream',
  '.vmd': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export async function handleFriendStaticRequest(req: Request, url: URL): Promise<Response | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return null
  }

  // Only handle /friend/* paths
  if (!url.pathname.startsWith('/friend/') && url.pathname !== '/friend') {
    return null
  }

  const distDir = await resolveFriendDistDir()
  if (!distDir) {
    return null
  }

  // Map /friend/* to dist root
  // /friend/              → index.html
  // /friend/model1.vrm    → dist/model1.vrm
  // /friend/assets/foo.js → dist/assets/foo.js
  const relativePath = url.pathname.replace(/^\/friend\/?/, '') || 'index.html'
  const filePath = await resolveFriendFilePath(distDir, relativePath)
  if (!filePath) {
    return null
  }

  const headers = new Headers({
    'Content-Type': contentTypeForPath(filePath),
    'Cache-Control': CACHEABLE_RE.test(url.pathname)
      ? 'public, max-age=31536000, immutable'
      : 'no-store',
  })

  if (req.method === 'HEAD') {
    const stat = await fs.stat(filePath)
    headers.set('Content-Length', String(stat.size))
    return new Response(null, { status: 200, headers })
  }

  return new Response(Bun.file(filePath), { status: 200, headers })
}

async function resolveFriendDistDir(): Promise<string | null> {
  const _srcDir = path.dirname(fileURLToPath(import.meta.url))
  // src/server/ -> ../../src/components/friend/frontend/dist
  const candidate = path.resolve(_srcDir, '..', '..', 'src', 'components', 'friend', 'frontend', 'dist')
  try {
    const stat = await fs.stat(path.join(candidate, 'index.html'))
    if (stat.isFile()) {
      return candidate
    }
  } catch {
    // Not found
  }
  return null
}

async function resolveFriendFilePath(distDir: string, relativePath: string): Promise<string | null> {
  if (!relativePath) return null

  const decoded = decodeURIComponent(relativePath)
  const candidate = path.resolve(distDir, decoded)
  const relativeToRoot = path.relative(distDir, candidate)
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    return null
  }

  try {
    const stat = await fs.stat(candidate)
    return stat.isFile() ? candidate : null
  } catch {
    return null
  }
}

function contentTypeForPath(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}
