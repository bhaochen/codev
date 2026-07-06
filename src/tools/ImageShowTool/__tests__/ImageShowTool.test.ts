import { describe, it, expect, beforeAll, vi } from 'vitest'
import { ImageShowTool } from '../ImageShowTool'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import path from 'path'
import React from 'react'
import type { Text } from 'ink'

// ── Helpers ──────────────────────────────────────────────────────────────────

function getExampleImagePath(): string {
  const rel = path.join('src', 'ink-picture', 'examples', 'images', 'house.png')
  return path.resolve(__dirname, '..', '..', '..', '..', rel)
}

function writeTempPng(): string {
  // Minimal valid 1x1 red PNG (baked base64)
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=='
  const tmpFile = path.join(
    process.env.TMPDIR || process.env.TEMP || '/tmp',
    `imgshow-test-${Date.now()}.png`,
  )
  require('fs').writeFileSync(tmpFile, Buffer.from(pngBase64, 'base64'))
  return tmpFile
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('ImageShowTool – comprehensive', () => {
  let imagePath: string

  beforeAll(async () => {
    imagePath = getExampleImagePath()
    const exists = await readFile(imagePath).catch(() => null)
    expect(exists).not.toBeNull()
  })

  // ═══════════════════════════════════════════════════════════════════════════
  //  Metadata
  // ═══════════════════════════════════════════════════════════════════════════
  describe('metadata', () => {
    it('has correct name', () => {
      expect(ImageShowTool.name).toBe('ImageShow')
    })

    it('is enabled', () => {
      expect(ImageShowTool.isEnabled()).toBe(true)
    })

    it('is read only', () => {
      expect(ImageShowTool.isReadOnly()).toBe(true)
    })

    it('is concurrency safe', () => {
      expect(ImageShowTool.isConcurrencySafe()).toBe(true)
    })

    it('returns a prompt string', async () => {
      const prompt = await ImageShowTool.prompt({} as any)
      expect(typeof prompt).toBe('string')
      expect(prompt.length).toBeGreaterThan(0)
      expect(prompt.toLowerCase()).toContain('image')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  //  Input validation
  // ═══════════════════════════════════════════════════════════════════════════
  describe('validateInput', () => {
    it('accepts a valid local path', async () => {
      const r = await ImageShowTool.validateInput({ url: imagePath })
      expect(r.result).toBe(true)
    })

    it('accepts a remote URL', async () => {
      const r = await ImageShowTool.validateInput({
        url: 'https://example.com/img.png',
      })
      expect(r.result).toBe(true)
    })

    it('rejects missing url key', async () => {
      const r = await ImageShowTool.validateInput({} as any)
      expect(r.result).toBe(false)
      expect(r.message).toMatch(/missing/i)
      expect(r.errorCode).toBe(1)
    })

    it('rejects undefined input', async () => {
      const r = await ImageShowTool.validateInput(undefined as any)
      expect(r.result).toBe(false)
      expect(r.message).toMatch(/missing/i)
    })

    it('rejects empty string url', async () => {
      const r = await ImageShowTool.validateInput({ url: '' })
      expect(r.result).toBe(false)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  //  call — local files
  // ═══════════════════════════════════════════════════════════════════════════
  describe('call – local files', () => {
    it('loads a PNG and returns base64 + metadata', async () => {
      const result = await ImageShowTool.call({ url: imagePath })

      expect(result.data.success).toBe(true)
      expect(result.data.message).toContain('house.png')

      // imageData
      expect(result.data.imageData).toBeDefined()
      expect(result.data.imageData!.mediaType).toBe('image/png')
      expect(typeof result.data.imageData!.base64).toBe('string')
      expect(result.data.imageData!.base64.length).toBeGreaterThan(0)

      // base64 top-level alias
      expect(result.data.base64).toBe(result.data.imageData!.base64)

      // src – should be the raw file-system path
      expect(result.data.src).toBe(imagePath)

      // alt – defaults to filename
      expect(result.data.alt).toBe('house.png')
    })

    it('handles file:// protocol', async () => {
      const result = await ImageShowTool.call({ url: `file://${imagePath}` })
      expect(result.data.success).toBe(true)
      expect(result.data.imageData!.mediaType).toBe('image/png')
      // src is normalized (file:// stripped)
      expect(result.data.src).toBe(imagePath)
    })

    it('expands ~ to homedir', async () => {
      // Write a temp PNG in the home dir so the ~ path resolves
      const home = homedir()
      const tmpFile = writeTempPng()
      const homeFile = path.join(home, path.basename(tmpFile))
      try {
        require('fs').renameSync(tmpFile, homeFile)
      } catch {
        // home dir not writable — skip
        require('fs').unlinkSync(tmpFile)
        return
      }

      const result = await ImageShowTool.call({
        url: `~/${path.basename(homeFile)}`,
      })
      expect(result.data.success).toBe(true)

      // Cleanup
      try { require('fs').unlinkSync(homeFile) } catch {}
    })

    it('uses custom alt text', async () => {
      const result = await ImageShowTool.call({
        url: imagePath,
        alt: 'My House',
      })
      expect(result.data.alt).toBe('My House')
    })

    it('fails gracefully for non-existent file', async () => {
      const result = await ImageShowTool.call({
        url: '/tmp/__nonexistent_img_test_file__xyz.png',
      })
      expect(result.data.success).toBe(false)
      expect(result.data.message).toMatch(/fail/i)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  //  call — remote URLs
  // ═══════════════════════════════════════════════════════════════════════════
  describe('call – remote URLs', () => {
    it('fails gracefully for unreachable URL', async () => {
      // Temporarily mock fetch to reject quickly
      const origFetch = globalThis.fetch
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'))
      try {
        const result = await ImageShowTool.call({
          url: 'https://example.com/img.png',
        })
        expect(result.data.success).toBe(false)
        expect(result.data.message).toMatch(/fail/i)
      } finally {
        globalThis.fetch = origFetch
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  //  getToolUseSummary
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getToolUseSummary', () => {
    it('returns null for empty input', () => {
      expect(ImageShowTool.getToolUseSummary({} as any)).toBeNull()
    })

    it('includes filename from path', () => {
      const s = ImageShowTool.getToolUseSummary({ url: imagePath })
      expect(s).toBe(`Show: house.png`)
    })

    it('includes filename from remote URL', () => {
      const s = ImageShowTool.getToolUseSummary({
        url: 'https://example.com/photo.jpg',
      })
      expect(s).toBe('Show: photo.jpg')
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  //  getActivityDescription
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getActivityDescription', () => {
    it('returns generic string without input', () => {
      expect(ImageShowTool.getActivityDescription({} as any)).toBe(
        'Showing image',
      )
    })

    it('includes URL in description', () => {
      const d = ImageShowTool.getActivityDescription({ url: imagePath })
      expect(d).toContain(imagePath)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  //  mapToolResultToToolResultBlockParam
  // ═══════════════════════════════════════════════════════════════════════════
  describe('mapToolResultToToolResultBlockParam', () => {
    it('returns image block on success with imageData', () => {
      const content = {
        success: true,
        message: 'ok',
        imageData: { base64: 'abc123', mediaType: 'image/png' },
      }
      const mapped = ImageShowTool.mapToolResultToToolResultBlockParam(
        content as any,
        'tool-use-42',
      )
      expect(mapped.tool_use_id).toBe('tool-use-42')
      expect(mapped.content).toHaveLength(1)
      const block = mapped.content[0]!
      expect(block.type).toBe('image')
      if (block.type === 'image') {
        expect(block.source.type).toBe('base64')
        expect(block.source.data).toBe('abc123')
        expect(block.source.media_type).toBe('image/png')
      }
    })

    it('returns image block with JPEG type', () => {
      const content = {
        success: true,
        message: 'ok',
        imageData: { base64: 'xyz', mediaType: 'image/jpeg' },
      }
      const mapped = ImageShowTool.mapToolResultToToolResultBlockParam(
        content as any,
        'tid',
      )
      const block = mapped.content[0]!
      expect(block.type).toBe('image')
      if (block.type === 'image') {
        expect(block.source.media_type).toBe('image/jpeg')
      }
    })

    it('returns text block on failure (no imageData)', () => {
      const content = { success: false, message: 'Failed to load image' }
      const mapped = ImageShowTool.mapToolResultToToolResultBlockParam(
        content as any,
        'tid',
      )
      expect(mapped.content).toHaveLength(1)
      const block = mapped.content[0]!
      expect(block.type).toBe('text')
      if (block.type === 'text') {
        expect(block.text).toBe('Failed to load image')
      }
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  //  renderToolResultMessage
  // ═══════════════════════════════════════════════════════════════════════════
  describe('renderToolResultMessage', () => {
    it('returns null when success is false', () => {
      const node = ImageShowTool.renderToolResultMessage(
        { success: false, message: 'error' },
        [],
        {} as any,
      )
      expect(node).toBeNull()
    })

    it('returns InkPictureProvider/Image element when src is provided', () => {
      const node = ImageShowTool.renderToolResultMessage(
        { success: true, message: 'ok', src: imagePath, alt: 'house' },
        [],
        {} as any,
      )
      expect(node).not.toBeNull()
      expect(React.isValidElement(node)).toBe(true)
    })

    it('returns Text element when success but no src', () => {
      const node = ImageShowTool.renderToolResultMessage(
        { success: true, message: 'Displayed: house.png' },
        [],
        {} as any,
      )
      expect(node).not.toBeNull()
      expect(React.isValidElement(node)).toBe(true)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  //  prompt helper
  // ═══════════════════════════════════════════════════════════════════════════
  describe('prompt', () => {
    it('describes supported formats and protocols', async () => {
      const p = await ImageShowTool.prompt({} as any)
      expect(p).toMatch(/png|jpeg|gif|webp/i)
      expect(p).toMatch(/unicode|kitty|terminal/i)
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  //  checkPermissions
  // ═══════════════════════════════════════════════════════════════════════════
  describe('checkPermissions', () => {
    it('always allows', async () => {
      const r = await ImageShowTool.checkPermissions()
      expect(r.behavior).toBe('allow')
    })
  })
})
