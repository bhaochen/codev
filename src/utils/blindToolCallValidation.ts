/**
 * Reject invented parameters on tools whose real contract is a JSON Schema.
 *
 * Built-in tools carry a Zod schema, whose `strictObject` already rejects
 * unknown keys. MCP tools instead declare a JSON Schema (`inputJSONSchema`)
 * and codev's fallback Zod schema is `z.object({}).passthrough()` — so a model
 * that guesses a parameter gets it silently forwarded (or silently dropped by
 * the server) instead of being told the parameter does not exist.
 *
 * This enforces exactly the part Zod cannot: when the declared schema sets
 * `additionalProperties: false`, every supplied key must be declared in
 * `properties` or match a `patternProperties` pattern. Schemas that leave the
 * door open (the common, permissive MCP case) are unaffected, so no call that
 * worked before is rejected now.
 *
 * Leaf module: pure, no I/O.
 */

import type { Tool } from '../Tool.js'

export type UnknownArgumentCheck = { ok: true } | { ok: false; message: string }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

export function checkUnknownToolArguments(
  tool: Tool,
  input: Record<string, unknown>,
): UnknownArgumentCheck {
  const schema = asRecord(
    (tool as unknown as { inputJSONSchema?: unknown }).inputJSONSchema,
  )
  // Only the explicit "no extra keys" declaration is enforced.
  if (!schema || schema.additionalProperties !== false) return { ok: true }

  const properties = asRecord(schema.properties) ?? {}
  const declared = new Set(Object.keys(properties))
  const patterns: RegExp[] = []
  const patternProperties = asRecord(schema.patternProperties)
  if (patternProperties) {
    for (const pattern of Object.keys(patternProperties)) {
      try {
        patterns.push(new RegExp(pattern))
      } catch {
        // A malformed pattern in a third-party schema must not fail the call.
        patterns.push(/^\u0000never$/)
      }
    }
  }

  const unknown = Object.keys(input).filter(
    key => !declared.has(key) && !patterns.some(re => re.test(key)),
  )
  if (unknown.length === 0) return { ok: true }

  const accepted =
    declared.size > 0 ? [...declared].join(', ') : '(none declared)'
  return {
    ok: false,
    message: `${tool.name} does not accept the parameter${
      unknown.length > 1 ? 's' : ''
    } ${unknown.map(k => `\`${k}\``).join(', ')}. Declared parameters: ${accepted}.`,
  }
}
