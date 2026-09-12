/**
 * OpenAI 兼容 reasoning 字段提取 — 流式 delta 与非流式 message 共用。
 *
 * 线序优先级（对标 models.dev schema 的 InterleavedField 三枚举）：
 *   1. `reasoning_content` — DeepSeek / big-pickle
 *   2. `reasoning`         — nemotron-3-ultra / nemotron-3.5-lightning / mimo-v2.5 等 Zen 模型
 *   3. `reasoning_text`    — 部分 OpenAI 兼容后端
 *   4. `reasoning_details[]` — 与 `reasoning` 并存的结构化明细，仅当前三者全缺失时拼接兜底
 *
 * 空字符串是有效信号（DeepSeek 直接作答时返回 reasoning_content: ""，
 * 空 thinking 块必须在后续请求中往返，否则 400），因此用 ?? 而非 ||，
 * 第一个非 nullish 的值即胜出，不跳过空串。
 *
 * 注意：`interleaved.field`（models.dev / models.opencode.ai 目录字段）描述的是
 * 请求回传字段，不保证等于响应下发字段 —— 实测 Zen 对 nemotron/mimo 下发 `reasoning`
 * 而目录标注 `reasoning_content`，故这里按优先级全收。
 */

type ReasoningCarrier = {
  reasoning_content?: string | null
  reasoning?: string | null
  reasoning_text?: string | null
  reasoning_details?: Array<{ text?: string }> | null
} | null | undefined

export function extractOpenAIReasoningText(carrier: ReasoningCarrier): string | null {
  if (!carrier) return null
  const direct = carrier.reasoning_content ?? carrier.reasoning ?? carrier.reasoning_text ?? null
  if (direct !== null) return direct
  const details = carrier.reasoning_details
  if (Array.isArray(details) && details.length > 0) {
    const combined = details
      .map(part => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
    if (combined !== '') return combined
  }
  return null
}
