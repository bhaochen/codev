/**
 * Cache-stable system prompt splitting, for implicit-prefix-cache providers.
 *
 * DeepSeek's context caching is automatic and prefix-exact: a request is billed
 * at the cache-hit rate only for the leading tokens byte-identical to a request
 * the upstream has already seen. Every byte from the first difference onward is
 * re-billed as a miss, so ONE churning byte near the head of the prompt costs
 * the whole conversation.
 *
 * The dynamic system sections (git status, env info, memory, MCP instructions)
 * are recomputed by the app and are only MOSTLY byte-stable across turns. Left
 * in the system message, an MCP server that connects on turn 3 rewrites the
 * system message and cold-starts the entire conversation.
 *
 * So: split the system prompt at SYSTEM_PROMPT_DYNAMIC_BOUNDARY (or at the
 * first known volatile section, when the marker is absent), freeze the volatile
 * tail to its first non-empty value for the session, and pin it as a leading
 * user message at a FIXED position. Fresh state still reaches the model every
 * turn through the conversation tail (tool results, the user's message) —
 * never by rewriting an already-sent block.
 */

import type { OpenAIChatMessage } from './openaiChatWire.js'

// Kept local (same value as src/constants/prompts.ts) so this module stays
// dependency-light: constants/prompts imports the system-prompt section
// registry, which calls back into resetSessionVolatileFreeze().
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

/** Remove the boundary marker from a prompt the caller is NOT going to split. */
export function stripSystemDynamicBoundary(text: string): string {
  if (!text.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)) return text
  return text.split(SYSTEM_PROMPT_DYNAMIC_BOUNDARY).join('').replace(/\n{3,}/g, '\n\n')
}

const VOLATILE_SYSTEM_PATTERNS: readonly RegExp[] = [
  /# Session-specific guidance\b[\s\S]*?(?=\n#|$)/,
  /<env>[\s\S]*?<\/env>/,
  /# Environment\b[\s\S]*?(?=\n#|$)/,
  /# currentDate\n[^\n]+/,
  /Today's date is [^\n]+/,
  /# gitStatus\b[\s\S]*?(?=\n#|$)/,
  /gitStatus:[\s\S]*?(?=\n\n|\n#|$)/,
  /Current branch:[\s\S]*?(?=\n\n|\n#|$)/,
  /Working directory:[\s\S]*?(?=\n\n|\n#|$)/,
  /Primary working directory:[\s\S]*?(?=\n\n|\n#|$)/,
]

/**
 * Split a flat system prompt into the part that must stay byte-identical for
 * the life of the session (cached prefix) and the per-turn dynamic tail.
 * Prefers the explicit boundary marker and falls back to the first known
 * volatile section after 30% of the prompt.
 */
export function splitSystemPromptForCache(text: string): {
  stable: string
  volatile: string
} {
  if (!text) return { stable: '', volatile: '' }

  const markerIdx = text.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
  if (markerIdx >= 0) {
    return {
      stable: text.slice(0, markerIdx).replace(/\s+$/, ''),
      volatile: text
        .slice(markerIdx + SYSTEM_PROMPT_DYNAMIC_BOUNDARY.length)
        .replace(/^\s+/, ''),
    }
  }

  const cutoff = Math.floor(text.length * 0.3)
  const starts: number[] = []
  for (const pattern of VOLATILE_SYSTEM_PATTERNS) {
    const match = text.match(pattern)
    if (match && match.index != null && match.index >= cutoff) {
      starts.push(match.index)
    }
  }
  if (starts.length === 0) return { stable: text, volatile: '' }

  const cut = Math.min(...starts)
  return {
    stable: text.slice(0, cut).replace(/\s+$/, ''),
    volatile: text.slice(cut).replace(/^\s+/, ''),
  }
}

// ── Session-frozen volatile text ────────────────────────────────────────

const volatileBySession = new Map<string, string>()

/**
 * Pin `volatileText` to the first non-empty value seen for `cacheKey`; later
 * values are ignored so the already-cached prefix keeps replaying byte-for-
 * byte. An empty first value pins nothing (it freezes on its first non-empty
 * appearance instead, costing exactly one prefix break).
 */
export function freezeSessionVolatileText(
  cacheKey: string,
  volatileText: string,
): string {
  const existing = volatileBySession.get(cacheKey)
  if (existing !== undefined) return existing
  if (!volatileText) return ''

  volatileBySession.set(cacheKey, volatileText)
  if (volatileBySession.size > 256) {
    const oldest = volatileBySession.keys().next().value
    if (oldest !== undefined) volatileBySession.delete(oldest)
  }
  return volatileText
}

/**
 * Freeze key: the session id, plus the model because a mid-session model switch
 * builds a different prompt whose snapshot must not leak across models.
 */
export function volatileFreezeKey(
  lane: string,
  model: string,
  sessionId: string | undefined,
): string {
  return `${lane}:${model.toLowerCase()}:${sessionId?.trim() || 'no-session'}`
}

/**
 * Called when the system prompt is deliberately rebuilt (/clear, /login,
 * post-compact cleanup): the freeze must not outlive the rebuild, or the lane
 * would replay the pre-rebuild bytes and the change would never reach the
 * model. Costs one prefix re-warm, which a genuine prompt change costs anyway.
 */
export function resetSessionVolatileFreeze(): void {
  volatileBySession.clear()
}

export function _resetSessionVolatileFreezeForTest(): void {
  volatileBySession.clear()
}

/** Providers whose request builder splits and freezes the system prompt. */
export function providerSplitsSystemPromptForCache(
  provider: string,
  model: string,
): boolean {
  return (
    provider === 'openrouter' ||
    provider === 'deepseek' ||
    model.toLowerCase().includes('deepseek')
  )
}

/**
 * Providers whose openai-chat client handles the boundary marker explicitly
 * (split for implicit-cache models, strip for the rest). Used at prompt-build
 * time to insert the marker, so the split is exact instead of regex-heuristic.
 */
export function providerUsesOpenAIChatBoundary(
  provider: string | null | undefined,
): boolean {
  return (
    provider === 'openai' ||
    provider === 'opencode' ||
    provider === 'nvidia' ||
    provider === 'openrouter'
  )
}

export function applyCacheStableSystemPrompt(
  messages: OpenAIChatMessage[],
  systemText: string,
  options: { lane: string; model: string; sessionId?: string },
): OpenAIChatMessage[] {
  const { stable, volatile } = splitSystemPromptForCache(systemText)
  const out = stable === systemText ? messages : replaceSystemMessage(messages, stable)
  const frozen = freezeSessionVolatileText(
    volatileFreezeKey(options.lane, options.model, options.sessionId),
    volatile,
  ).trim()
  if (!frozen) return out

  // FIXED leading position, right after the system message. Spliced in before
  // the LAST user message instead, the block would move one slot later every
  // turn and the prefix would diverge at its old position on every call.
  const insertAt = out[0]?.role === 'system' ? 1 : 0
  const context: OpenAIChatMessage = {
    role: 'user',
    // String content: DeepSeek's chat-completions route takes plain strings
    // for text-only user turns.
    content: `<dynamic_context>\n${frozen}\n</dynamic_context>`,
  }
  return [...out.slice(0, insertAt), context, ...out.slice(insertAt)]
}

function replaceSystemMessage(
  messages: OpenAIChatMessage[],
  stable: string,
): OpenAIChatMessage[] {
  if (messages[0]?.role !== 'system') return messages
  return [{ ...messages[0], content: stable }, ...messages.slice(1)]
}
