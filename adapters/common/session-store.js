import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export class SessionStore {
  static getInstance() { return null; }
  async get() { return null; }
  async set() {}
  async delete() {}

  deleteBySessionId(sessionId) {
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    const filePath = join(configDir, 'adapter-sessions.json')
    if (!existsSync(filePath)) return []

    let mappings
    try {
      mappings = JSON.parse(readFileSync(filePath, 'utf8'))
    } catch {
      return []
    }
    const removed = []
    for (const [chatId, mapping] of Object.entries(mappings)) {
      if (mapping && mapping.sessionId === sessionId) {
        removed.push(chatId)
        delete mappings[chatId]
      }
    }
    if (removed.length > 0) {
      writeFileSync(filePath, JSON.stringify(mappings, null, 2), 'utf8')
    }
    return removed
  }
}
