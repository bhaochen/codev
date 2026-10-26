/**
 * Adapter Service — 读写 IM Adapter 配置文件
 *
 * Adapter configuration is persisted in codev.db.
 */

import { ApiError } from '../middleware/errorHandler.js'
import { getSessionStore } from '../../services/db/SessionStore.js'

export type PairedUser = {
  userId: string | number
  displayName: string
  pairedAt: number
}

export type PairingState = {
  code?: string | null
  expiresAt?: number | null
  createdAt?: number | null
}

export type AdapterFileConfig = {
  serverUrl?: string
  defaultProjectDir?: string
  pairing?: PairingState
  dingtalk?: {
    clientId?: string
    clientSecret?: string
    allowedUsers?: string[]
    pairedUsers?: PairedUser[]
    defaultWorkDir?: string
    endpoint?: string
    permissionCardTemplateId?: string
  }
}

function maskSecret(value: string | undefined): string | undefined {
  if (!value) return value
  if (value.length <= 4) return '****'
  return '****' + value.slice(-4)
}

function isMasked(value: string | undefined): boolean {
  return !!value && value.startsWith('****')
}

class AdapterService {
  /** 读取原始配置（不脱敏） */
  async getRawConfig(): Promise<AdapterFileConfig> {
    const raw = getSessionStore().getAppDocument('adapter', 'config')
    if (!raw) return {}
    try {
      return JSON.parse(raw) as AdapterFileConfig
    } catch (err) {
      throw ApiError.internal(`Failed to read adapter config from codev.db: ${err}`)
    }
  }

  /** 读取配置（敏感字段脱敏） */
  async getConfig(): Promise<AdapterFileConfig> {
    const config = await this.getRawConfig()
    if (config.dingtalk?.clientSecret) {
      config.dingtalk.clientSecret = maskSecret(config.dingtalk.clientSecret)
    }
    if (config.pairing?.code) {
      config.pairing.code = '******'
    }
    return config
  }

  /** 更新配置（浅合并，敏感字段如果是脱敏值则保留原值） */
  async updateConfig(patch: Partial<AdapterFileConfig>): Promise<void> {
    try {
      getSessionStore().updateAppDocument('adapter', 'config', raw => {
        let current: AdapterFileConfig = {}
        if (raw) current = JSON.parse(raw) as AdapterFileConfig
        const safePatch = structuredClone(patch)
        // Keep secrets when the UI submits the masked value returned by GET.
        if (safePatch.dingtalk && isMasked(safePatch.dingtalk.clientSecret)) {
          safePatch.dingtalk.clientSecret = current.dingtalk?.clientSecret
        }
        if (safePatch.pairing && isMasked(safePatch.pairing.code ?? undefined)) {
          safePatch.pairing.code = current.pairing?.code
        }
        const merged: AdapterFileConfig = {
          ...current,
          ...safePatch,
          dingtalk: safePatch.dingtalk ? { ...current.dingtalk, ...safePatch.dingtalk } : current.dingtalk,
          pairing: safePatch.pairing !== undefined ? { ...current.pairing, ...safePatch.pairing } : current.pairing,
        }
        return JSON.stringify(merged)
      })
    } catch (err) {
      throw ApiError.internal(`Failed to write adapter config to codev.db: ${err}`)
    }
  }
}

export const adapterService = new AdapterService()
