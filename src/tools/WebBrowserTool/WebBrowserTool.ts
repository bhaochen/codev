import { readFileSync } from 'fs'
import { createElement } from 'react'
import type React from 'react'
import { z } from 'zod/v4'

import { buildTool, type ToolDef } from '../../Tool.js'
import { Text } from '../../ink.js'
import { openBrowser, openPath } from '../../utils/browser.js'
import { resolveLocalFileTarget } from '../../utils/fileUrls.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { WEB_BROWSER_TOOL_NAME } from './constants.js'

const DESCRIPTION = 'Open an http(s) URL or local file, or fetch a compact HTML snapshot.'
const PROMPT = `Use this tool for browser-adjacent verification.

Actions:
- open: open an HTTP URL or local file in the user's browser.
- snapshot: fetch an HTTP URL or read a local HTML file and return its title, headings, links, forms, and text.

This tool does not click, type, execute JavaScript, or take screenshots; use a Playwright/Chrome MCP tool for that.`

const inputSchema = lazySchema(() => z.strictObject({
  action: z.enum(['open', 'snapshot']),
  url: z.string().min(1),
  findText: z.string().optional(),
  maxTextChars: z.number().int().min(500).max(12000).optional(),
}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() => z.object({
  action: z.enum(['open', 'snapshot']), url: z.string(), opened: z.boolean().optional(),
  status: z.number().optional(), ok: z.boolean().optional(), title: z.string().optional(),
  headings: z.array(z.string()).optional(),
  links: z.array(z.object({ text: z.string(), href: z.string() })).optional(),
  forms: z.number().optional(), findTextFound: z.boolean().optional(), text: z.string().optional(),
  warnings: z.array(z.string()),
}))
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

function renderText(value: string): React.ReactNode { return createElement(Text, null, value) }
function clean(value: string): string {
  return value.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/\s+/g, ' ').trim()
}
function matchOne(html: string, pattern: RegExp): string | undefined {
  const value = html.match(pattern)?.[1]; return value ? clean(value) : undefined
}
function matches(html: string, pattern: RegExp, limit: number): string[] {
  return [...html.matchAll(pattern)].map(match => clean(match[1] ?? '')).filter(Boolean).slice(0, limit)
}
function resolveTarget(value: string): { kind: 'web'; url: string } | { kind: 'file'; path: string; url: string } {
  const input = value.trim()
  try {
    const url = new URL(input)
    if (url.protocol === 'http:' || url.protocol === 'https:') return { kind: 'web', url: url.toString() }
    if (url.protocol === 'file:') return { kind: 'file', ...resolveLocalFileTarget(input) }
  } catch { /* local path */ }
  return { kind: 'file', ...resolveLocalFileTarget(input) }
}

export const WebBrowserTool = buildTool({
  name: WEB_BROWSER_TOOL_NAME, searchHint: 'browser open snapshot local html', shouldDefer: true, maxResultSizeChars: 80_000,
  async description() { return DESCRIPTION }, async prompt() { return PROMPT },
  get inputSchema(): InputSchema { return inputSchema() }, get outputSchema(): OutputSchema { return outputSchema() },
  userFacingName() { return 'Using browser' }, isReadOnly(input) { return input.action === 'snapshot' },
  isConcurrencySafe() { return true }, isDestructive() { return false },
  toAutoClassifierInput(input) { return `${input.action} ${input.url}` },
  async validateInput(input) { try { resolveTarget(input.url); return { result: true } } catch (error) { return { result: false, message: error instanceof Error ? error.message : 'Invalid browser target', errorCode: 1 } } },
  renderToolUseMessage(input) { return renderText(`${input.action} ${input.url}`) },
  renderToolResultMessage(output) { return renderText(output.action === 'open' ? `${output.opened ? 'Opened' : 'Could not open'} ${output.url}` : `${output.status ?? '?'} ${output.title ?? output.url}`) },
  async call(input, ctx) {
    const target = resolveTarget(input.url)
    if (input.action === 'open') {
      const opened = target.kind === 'file' ? await openPath(target.path) : await openBrowser(target.url)
      return { data: { action: input.action, url: target.url, opened, warnings: opened ? [] : ['The OS browser command failed.'] } }
    }
    let html: string; let status = 200; let ok = true
    if (target.kind === 'file') html = readFileSync(target.path, 'utf8')
    else { const response = await fetch(target.url, { signal: ctx.abortController.signal }); html = await response.text(); status = response.status; ok = response.ok }
    const base = new URL(target.url)
    const links = [...html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].slice(0, 20).flatMap(match => {
      try { return [{ text: clean(match[2] ?? '') || match[1]!, href: new URL(match[1]!, base).toString() }] } catch { return [] }
    })
    const body = matchOne(html, /<body[^>]*>([\s\S]*?)<\/body>/i) ?? clean(html); const max = input.maxTextChars ?? 4000
    return { data: { action: input.action, url: target.url, status, ok, title: matchOne(html, /<title[^>]*>([\s\S]*?)<\/title>/i), headings: matches(html, /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi, 12), links, forms: [...html.matchAll(/<form\b/gi)].length, ...(input.findText ? { findTextFound: html.toLowerCase().includes(input.findText.toLowerCase()) } : {}), text: body.length > max ? `${body.slice(0, max)}...` : body, warnings: [] } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const lines = output.action === 'open' ? [`Action: open`, `URL: ${output.url}`, `Opened: ${output.opened ? 'yes' : 'no'}`] : [`Action: snapshot`, `URL: ${output.url}`, `Status: ${output.status} ${output.ok ? 'OK' : 'FAILED'}`, `Title: ${output.title ?? '(none)'}`, `Forms: ${output.forms ?? 0}`, `Headings: ${(output.headings ?? []).join(' | ') || '(none)'}`, `Links: ${(output.links ?? []).map(link => `${link.text}: ${link.href}`).join(' | ') || '(none)'}`, '', output.text ?? '']
    return { type: 'tool_result', tool_use_id: toolUseID, content: lines.join('\n'), is_error: output.ok === false || output.opened === false ? true : undefined }
  },
} satisfies ToolDef<InputSchema, Output>)
