import { createHash, type UUID } from 'crypto'

/**
 * Derive a valid RFC-4122 v4-shaped UUID deterministically from a key.
 *
 * Task notifications need a stable identity so the same logical event (e.g.
 * "shell task abc completed") always maps to the same uuid — that is what
 * makes enqueue dedup and durable-replay idempotent (a replayed notification
 * cannot double-deliver). randomUUID() cannot provide this, and the key is
 * not a UUID, so we hash it and stamp the v4 version/variant bits so the
 * result satisfies the UUID type contract everywhere a message uuid is used.
 */
export function deterministicUuid(key: string): UUID {
  const hex = createHash('sha256').update(key).digest('hex').slice(0, 32)
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-') as UUID
}
