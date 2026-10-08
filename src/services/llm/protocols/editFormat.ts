/**
 * Which edit primitive a model was post-trained on.
 *
 * Models trained against different formats emit drastically better or worse
 * patches depending on what they were shown during instruction tuning.
 * Codev's default `Edit` takes `old_string`/`new_string`; coder-tuned models
 * (DeepSeek-Coder, Kimi, Qwen-Coder, …) do best with Aider SEARCH/REPLACE
 * shaped arguments.
 *
 * This decides only which edit tool is *advertised*; the incoming call is
 * translated back to the real `Edit` tool before execution (see
 * `editBlockTool.ts`), so permissions/UI/diagnostics are unchanged.
 */

export type EditFormat = 'edit_block' | 'str_replace'

const EDIT_FORMAT_OVERRIDES: Array<{ pattern: RegExp; format: EditFormat }> = [
  // DeepSeek coder-series — SEARCH/REPLACE is their post-training edit format.
  { pattern: /deepseek.*coder/i, format: 'edit_block' },
  // Moonshot Kimi K2 / Kimi-Dev handle edit_block cleanly.
  { pattern: /kimi(-k2|-dev)?/i, format: 'edit_block' },
  // Codestral / Mistral's coder family.
  { pattern: /^(codestral|magistral|mistral-coder)/i, format: 'edit_block' },
  // Qwen3-coder.
  { pattern: /qwen.*coder/i, format: 'edit_block' },
  // Llama-3.3 and up handle edit_block; older / smaller Llama → str_replace.
  { pattern: /llama-?3\.[3-9]/i, format: 'edit_block' },
  { pattern: /llama-?[45]/i, format: 'edit_block' },
  // xAI grok-code-fast.
  { pattern: /grok.*code/i, format: 'edit_block' },
]

/** Preferred edit format for `model`. Defaults to the native `str_replace`. */
export function preferredEditFormat(model: string): EditFormat {
  const m = model.toLowerCase()
  for (const { pattern, format } of EDIT_FORMAT_OVERRIDES) {
    if (pattern.test(m)) return format
  }
  return 'str_replace'
}
