/**
 * Settings Service — 用户偏好写入 codev.db，项目设置仍为项目文件
 *
 * 全局 hooks 与 MCP 定义保留在用户 settings.json，项目设置保留在项目文件。
 *
 * 合并策略：Object.assign({}, userSettings, projectSettings)
 */

import * as fs from 'fs/promises'
import { randomBytes } from 'node:crypto'
import * as path from 'path'
import { ApiError } from '../middleware/errorHandler.js'
import { normalizeJsonObject, readRecoverableJsonFile } from './recoverableJsonFile.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { getSettingsForSource, updateSettingsForSource } from '../../utils/settings/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'

const VALID_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
] as const

export type PermissionMode = (typeof VALID_PERMISSION_MODES)[number]

export class SettingsService {
  private static writeLocks = new Map<string, Promise<void>>()
  private projectRoot?: string

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot
  }

  /** 项目级设置文件路径 */
  private getProjectSettingsPath(projectRoot?: string): string {
    const root = projectRoot || this.projectRoot
    if (!root) {
      throw ApiError.badRequest('Project root is required for project settings')
    }
    return path.join(root, '.claude', 'settings.json')
  }

  // ---------------------------------------------------------------------------
  // 读取
  // ---------------------------------------------------------------------------

  /** 安全读取 JSON 文件，文件不存在时返回空对象 */
  private async readJsonFile(filePath: string): Promise<Record<string, unknown>> {
    return readRecoverableJsonFile({
      filePath,
      label: 'settings',
      defaultValue: {},
      normalize: normalizeJsonObject,
    })
  }

  /** 获取合并后的设置（user + project） */
  async getSettings(projectRoot?: string): Promise<Record<string, unknown>> {
    const user = await this.getUserSettings()
    try {
      const project = await this.getProjectSettings(projectRoot)
      return Object.assign({}, user, project)
    } catch {
      // project root 未指定时，仅返回 user settings
      return user
    }
  }

  /** 获取用户级设置 */
  async getUserSettings(): Promise<Record<string, unknown>> {
    return (getSettingsForSource('userSettings') ?? {}) as Record<string, unknown>
  }

  /** 获取项目级设置 */
  async getProjectSettings(projectRoot?: string): Promise<Record<string, unknown>> {
    return this.readJsonFile(this.getProjectSettingsPath(projectRoot))
  }

  // ---------------------------------------------------------------------------
  // 写入（原子写入：先写临时文件，再 rename）
  // ---------------------------------------------------------------------------

  /** 原子写入 JSON 文件 */
  private async withWriteLock<T>(
    filePath: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previousWrite = SettingsService.writeLocks.get(filePath) ?? Promise.resolve()
    const nextWrite = previousWrite
      .catch(() => {})
      .then(task)

    SettingsService.writeLocks.set(filePath, nextWrite as unknown as Promise<void>)

    try {
      return await nextWrite
    } finally {
      if (SettingsService.writeLocks.get(filePath) === nextWrite) {
        SettingsService.writeLocks.delete(filePath)
      }
    }
  }

  private async writeJsonFile(
    filePath: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const dir = path.dirname(filePath)
    const contents = JSON.stringify(data, null, 2) + '\n'
    let lastError: unknown

    for (let attempt = 0; attempt < 2; attempt++) {
      const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}`
      try {
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(tmpFile, contents, 'utf-8')
        await fs.rename(tmpFile, filePath)
        resetSettingsCache()
        return
      } catch (err) {
        lastError = err
        await fs.unlink(tmpFile).catch(() => {})

        if (
          (err as NodeJS.ErrnoException).code !== 'ENOENT' ||
          attempt === 1
        ) {
          break
        }
      }
    }

    throw ApiError.internal(
      `Failed to write settings to ${filePath}: ${lastError}`,
    )
  }

  /** 更新用户级设置（浅合并） */
  async updateUserSettings(settings: Record<string, unknown>): Promise<void> {
    const result = updateSettingsForSource('userSettings', settings as SettingsJson)
    if (result.error) {
      throw ApiError.internal(`Failed to update user settings: ${result.error.message}`)
    }
    resetSettingsCache()
  }

  /** 更新项目级设置（浅合并） */
  async updateProjectSettings(
    settings: Record<string, unknown>,
    projectRoot?: string,
  ): Promise<void> {
    const filePath = this.getProjectSettingsPath(projectRoot)
    await this.withWriteLock(filePath, async () => {
      const current = await this.readJsonFile(filePath)
      const merged = Object.assign({}, current, settings)
      await this.writeJsonFile(filePath, merged)
    })
  }

  // ---------------------------------------------------------------------------
  // 权限模式
  // ---------------------------------------------------------------------------

  /** 获取当前权限模式 */
  async getPermissionMode(): Promise<string> {
    const settings = await this.getUserSettings()
    const mode = settings.defaultMode
    return typeof mode === 'string' && VALID_PERMISSION_MODES.includes(mode as PermissionMode)
      ? mode
      : 'default'
  }

  /** 设置权限模式 */
  async setPermissionMode(mode: string): Promise<void> {
    if (!VALID_PERMISSION_MODES.includes(mode as PermissionMode)) {
      throw ApiError.badRequest(
        `Invalid permission mode: "${mode}". Valid modes: ${VALID_PERMISSION_MODES.join(', ')}`,
      )
    }
    await this.updateUserSettings({ defaultMode: mode })
  }
}
