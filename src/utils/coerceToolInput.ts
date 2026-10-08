/**
 * Coerce model-provided tool inputs to match the expected Zod schema types.
 *
 * Non-frontier models (especially free-tier OpenRouter models) frequently emit
 * JSON strings for typed parameters — e.g. `"allowedPrompts": "[{...}]"`
 * instead of `"allowedPrompts": [{...}]` — or a bare number/boolean for a
 * string-typed parameter (`taskId: 3` instead of `"3"`).
 *
 * This is a shallow, conservative pass run BEFORE Zod validation. If coercion
 * produces invalid data, the downstream `safeParse()` still rejects it: this is
 * a best-effort recovery layer, never a replacement for validation.
 *
 * Coercions performed (top-level properties only):
 *   - string → array:   JSON.parse if the string looks like "[...]"
 *   - string → object:  JSON.parse if the string looks like "{...}"
 *   - string → number:  Number() if the string is numeric
 *   - string → boolean: "true"/"false" → true/false
 *   - number/boolean → string: String(value) for string-typed params
 *
 * Key recovery: an input key that isn't a schema property but normalizes
 * (casing, `_`/`-`) to one that is — e.g. `filePath` → `file_path` — is renamed
 * when the canonical key is absent.
 */

import type { ZodTypeAny } from 'zod/v4'

/** The `_zod.def.type` discriminator (or an unwrapped inner type's). */
function getZodType(schema: ZodTypeAny): string | null {
  try {
    const anySchema = schema as unknown as {
      _zod?: { def?: { type?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny } }
      _def?: { type?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny }
    }
    const def = anySchema._zod?.def ?? anySchema._def
    if (def?.type) return def.type
    if (def?.innerType) return getZodType(def.innerType)
    if (def?.schema) return getZodType(def.schema)
    return null
  } catch {
    return null
  }
}

function getObjectProperties(schema: ZodTypeAny): Map<string, ZodTypeAny> | null {
  try {
    const anySchema = schema as unknown as {
      _zod?: { def?: { shape?: Record<string, ZodTypeAny> } }
      _def?: { shape?: Record<string, ZodTypeAny> }
    }
    const def = anySchema._zod?.def ?? anySchema._def
    const shape = def?.shape
    if (shape && typeof shape === 'object') {
      return new Map(Object.entries(shape))
    }
    return null
  } catch {
    return null
  }
}

/** Unwrap optional/nullable/default wrappers to reach the inner schema. */
function unwrapSchema(schema: ZodTypeAny): ZodTypeAny {
  try {
    const anySchema = schema as unknown as {
      _zod?: { def?: { type?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny } }
      _def?: { type?: string; innerType?: ZodTypeAny; schema?: ZodTypeAny }
    }
    const def = anySchema._zod?.def ?? anySchema._def
    const type = def?.type
    if (type === 'optional' || type === 'nullable' || type === 'default') {
      const inner = def?.innerType ?? def?.schema
      if (inner) return unwrapSchema(inner)
    }
    return schema
  } catch {
    return schema
  }
}

function isOptionalLikeSchema(schema: ZodTypeAny): boolean {
  try {
    const anySchema = schema as unknown as {
      _zod?: { def?: { type?: string } }
      _def?: { def?: { type?: string }; type?: string }
    }
    const type = anySchema._zod?.def?.type ?? anySchema._def?.type
    return type === 'optional' || type === 'default'
  } catch {
    return false
  }
}

/** Lowercase and strip `_`/`-` so `filePath` / `file-path` match `file_path`. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '')
}

/** Coerce a single value to `expectedType`, or return it unchanged. */
function coerceValue(value: unknown, expectedType: string): unknown {
  if (expectedType === 'string') {
    return typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : value
  }

  if (typeof value !== 'string') return value

  switch (expectedType) {
    case 'array': {
      const trimmed = value.trim()
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        try {
          return JSON.parse(trimmed)
        } catch {
          /* fall through */
        }
      }
      return value
    }
    case 'object': {
      const trimmed = value.trim()
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
          return JSON.parse(trimmed)
        } catch {
          /* fall through */
        }
      }
      return value
    }
    case 'number':
    case 'float':
    case 'int':
    case 'integer': {
      const num = Number(value)
      if (!Number.isNaN(num) && value.trim() !== '') return num
      return value
    }
    case 'boolean': {
      const lower = value.trim().toLowerCase()
      if (lower === 'true') return true
      if (lower === 'false') return false
      return value
    }
    default:
      return value
  }
}

/** Escape literal control characters inside JSON string literals (lossless). */
function escapeControlCharsInStrings(s: string): string {
  let out = ''
  let inStr = false
  let esc = false
  for (const ch of s) {
    if (esc) {
      out += ch
      esc = false
    } else if (ch === '\\') {
      out += ch
      esc = true
    } else if (ch === '"') {
      inStr = !inStr
      out += ch
    } else if (inStr && ch === '\n') {
      out += '\\n'
    } else if (inStr && ch === '\r') {
      out += '\\r'
    } else if (inStr && ch === '\t') {
      out += '\\t'
    } else {
      out += ch
    }
  }
  return out
}

/** Double backslashes that don't begin a valid JSON escape (lossless). */
function escapeInvalidBackslashesInStrings(s: string): string {
  let out = ''
  let inStr = false
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (!inStr) {
      out += ch
      if (ch === '"') inStr = true
      continue
    }
    if (ch === '"') {
      out += ch
      inStr = false
      continue
    }
    if (ch === '\\') {
      const next = s[i + 1]
      const validSimple = next !== undefined && '"\\/bfnrt'.includes(next)
      const validUnicode =
        next === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 2, i + 6))
      if (validSimple || validUnicode) {
        out += ch + next
        i++
      } else {
        out += '\\\\'
      }
      continue
    }
    out += ch
  }
  return out
}

/**
 * Recover a `_raw` sentinel (set when tool-call args failed to JSON.parse) with
 * LOSSLESS repairs only: strip a markdown fence, escape in-string control
 * chars, escape under-escaped backslashes, undo double-encoding. Returns null
 * when none yield a plain object — never force-closes truncated JSON, so a
 * cut-off call still fails and the model resends.
 */
function recoverRawToolArgs(raw: string): Record<string, unknown> | null {
  let base = raw.trim()
  const fence = base.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence?.[1] !== undefined) base = fence[1].trim()

  const controlEscaped = escapeControlCharsInStrings(base)
  for (const candidate of [
    base,
    controlEscaped,
    escapeInvalidBackslashesInStrings(base),
    escapeInvalidBackslashesInStrings(controlEscaped),
  ]) {
    try {
      let parsed: unknown = JSON.parse(candidate)
      if (typeof parsed === 'string') parsed = JSON.parse(parsed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* try next candidate */
    }
  }
  return null
}

/**
 * Coerce top-level tool input properties to their schema's expected types.
 * Nested structures are left to Zod validation.
 */
export function coerceToolInput(
  input: Record<string, unknown>,
  schema: ZodTypeAny,
): Record<string, unknown> {
  if (!input || typeof input !== 'object') return input

  if (typeof input._raw === 'string' && Object.keys(input).length === 1) {
    const recovered = recoverRawToolArgs(input._raw)
    if (recovered) input = recovered
  }

  const unwrapped = unwrapSchema(schema)
  const properties = getObjectProperties(unwrapped)
  if (!properties || properties.size === 0) return input

  let mutated = false
  const result: Record<string, unknown> = { ...input }

  const canonicalByNorm = new Map<string, string>()
  for (const key of properties.keys()) {
    canonicalByNorm.set(normalizeKey(key), key)
  }
  for (const key of Object.keys(result)) {
    if (properties.has(key)) continue
    const canonical = canonicalByNorm.get(normalizeKey(key))
    if (canonical && !(canonical in result)) {
      result[canonical] = result[key]
      delete result[key]
      mutated = true
    }
  }

  for (const [key, propSchema] of properties) {
    if (!(key in result)) continue

    if (result[key] === null && isOptionalLikeSchema(propSchema)) {
      delete result[key]
      mutated = true
      continue
    }

    const innerSchema = unwrapSchema(propSchema)
    const expectedType = getZodType(innerSchema)
    if (!expectedType) continue

    const original = result[key]
    const coerced = coerceValue(original, expectedType)
    if (coerced !== original) {
      result[key] = coerced
      mutated = true
    }
  }

  return mutated ? result : input
}
