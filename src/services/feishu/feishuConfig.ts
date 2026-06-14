/**
 * Feishu Config — read/write ~/.claude/adapters.json feishu section
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

export type PairedUser = {
  userId: string | number
  displayName: string
  pairedAt: number
}

export type FeishuRuntimeConfig = {
  appId?: string
  appSecret?: string
  encryptKey?: string
  verificationToken?: string
  allowedUsers?: string[]
  pairedUsers?: PairedUser[]
  streamingCard?: boolean
}

function getConfigPath(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'adapters.json')
}

function maskSecret(value: string | undefined): string | undefined {
  if (!value) return value
  if (value.length <= 4) return '****'
  return '****' + value.slice(-4)
}

export function getFeishuConfig(): FeishuRuntimeConfig {
  try {
    const raw = fs.readFileSync(getConfigPath(), 'utf-8')
    const config = JSON.parse(raw) as { feishu?: FeishuRuntimeConfig }
    return config.feishu ?? {}
  } catch {
    return {}
  }
}

export function saveFeishuConfig(patch: Partial<FeishuRuntimeConfig>): void {
  const filePath = getConfigPath()
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })

  let existing: Record<string, unknown> = {}
  try {
    const raw = fs.readFileSync(filePath, 'utf-8')
    existing = JSON.parse(raw)
  } catch {
    // File doesn't exist yet
  }

  const current = ((existing.feishu as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>
  // Don't overwrite masked secrets (frontend sends back masked values for unchanged fields)
  const merged: Record<string, unknown> = { ...current, ...patch }
  for (const key of Object.keys(merged)) {
    const val = merged[key]
    if (typeof val === 'string' && val.startsWith('****')) {
      merged[key] = current[key]
    }
  }

  const finalConfig = { ...existing, feishu: merged }
  fs.writeFileSync(filePath, JSON.stringify(finalConfig, null, 2) + '\n', { mode: 0o600 })
}

export function clearFeishuConfig(): void {
  try {
    const filePath = getConfigPath()
    const raw = fs.readFileSync(filePath, 'utf-8')
    const config = JSON.parse(raw) as Record<string, unknown>
    delete config.feishu
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  } catch {
    // ignore
  }
}

export function maskFeishuAppId(appId?: string): string {
  if (!appId) return '未配置'
  if (appId.length <= 6) return '****'
  return appId.slice(0, 3) + '****' + appId.slice(-3)
}

export function maskFeishuAppSecret(secret?: string): string {
  return maskSecret(secret) ?? '未配置'
}

export function isFeishuConfigured(): boolean {
  const config = getFeishuConfig()
  return Boolean(config.appId && config.appSecret)
}