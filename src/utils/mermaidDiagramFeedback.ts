import { marked, type Tokens } from 'marked'
import {
  fitMermaidArt,
  isMermaidFence,
  type MermaidFallback,
  normalizeMermaidFences,
} from './mermaidDiagram.js'

type MessageLike = {
  type: string
  isMeta?: boolean
  toolUseResult?: unknown
  attachment?: { type: string }
  message?: unknown
}

const MAX_REASONS = 3

/**
 * Reasons top-level diagrams in the current assistant turn were not drawn.
 * Stops at a human turn or a previous feedback attachment so each limitation
 * is sent to the model only once.
 */
export function getUndrawnMermaidReasons(
  messages: readonly MessageLike[],
  columns: number,
): string[] {
  const reasons = new Set<string>()
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!
    if (
      message.type === 'attachment' &&
      message.attachment?.type === 'mermaid_not_drawn'
    ) {
      break
    }
    if (
      message.type === 'user' &&
      !message.isMeta &&
      message.toolUseResult === undefined
    ) {
      break
    }
    if (message.type !== 'assistant') continue
    const messageBody = message.message
    if (typeof messageBody !== 'object' || messageBody === null) continue
    const content = (messageBody as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'text' || typeof block.text !== 'string') continue
      for (const source of mermaidBlocks(block.text)) {
        const drawing = fitMermaidArt(source, columns)
        if ('fallback' in drawing) reasons.add(explain(drawing.fallback))
      }
    }
  }
  return [...reasons].slice(0, MAX_REASONS)
}

function mermaidBlocks(text: string): string[] {
  if (!/mermaid/i.test(text)) return []
  const blocks: string[] = []
  for (const token of marked.lexer(normalizeMermaidFences(text))) {
    if (token.type === 'code' && isMermaidFence((token as Tokens.Code).lang)) {
      blocks.push((token as Tokens.Code).text)
    }
  }
  return blocks
}

function explain(fallback: MermaidFallback): string {
  switch (fallback.kind) {
    case 'too-wide':
      return `it needs ${fallback.columnsNeeded} columns and the terminal has ${fallback.columns}`
    case 'too-large':
      return 'it is too long'
    case 'unsupported':
      return fallback.name === null
        ? 'that kind of diagram is not supported'
        : `${fallback.name} diagrams are not supported`
    case 'unreadable':
      return 'it has a Mermaid syntax error'
    case 'characters':
      return 'its labels use characters the terminal cannot line up'
  }
}
