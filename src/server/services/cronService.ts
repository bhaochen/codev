/**
 * CronService — 管理定时任务的增删改查
 *
 * Scheduled task definitions are persisted in codev.db.
 */

import * as crypto from 'crypto'
import { ApiError } from '../middleware/errorHandler.js'
import { getSessionStore } from '../../services/db/SessionStore.js'

export type CronTask = {
  id: string
  name?: string
  description?: string
  cron: string // 5-field cron expression
  prompt: string
  createdAt: number // epoch ms
  lastFiredAt?: string // ISO timestamp of last execution
  enabled?: boolean // allow disabling without deleting (default true)
  recurring?: boolean
  permanent?: boolean
  permissionMode?: string
  model?: string
  providerId?: string | null
  folderPath?: string
  useWorktree?: boolean
}

type TasksFile = {
  tasks: CronTask[]
}

export class CronService {
  // ---------------------------------------------------------------------------
  // 公开方法
  // ---------------------------------------------------------------------------

  /** 获取所有任务 */
  async listTasks(): Promise<CronTask[]> {
    const data = await this.readTasksFile()
    return data.tasks
  }

  /** 创建新任务 */
  async createTask(
    task: Omit<CronTask, 'id' | 'createdAt'>,
  ): Promise<CronTask> {
    if (!task.cron || !task.prompt) {
      throw ApiError.badRequest('Fields "cron" and "prompt" are required')
    }

    const newTask: CronTask = {
      ...task,
      id: crypto.randomBytes(4).toString('hex'),
      createdAt: Date.now(),
    }
    this.updateTasks(data => { data.tasks.push(newTask) })
    return newTask
  }

  /** 更新已有任务 */
  async updateTask(id: string, updates: Partial<CronTask>): Promise<CronTask> {
    // 不允许修改 id 和 createdAt
    const { id: _id, createdAt: _ca, ...safeUpdates } = updates
    let updated: CronTask | undefined
    this.updateTasks(data => {
      const index = data.tasks.findIndex((t) => t.id === id)
      if (index === -1) throw ApiError.notFound(`Task not found: ${id}`)
      data.tasks[index] = { ...data.tasks[index], ...safeUpdates }
      updated = data.tasks[index]
    })
    return updated!
  }

  /** 删除任务 */
  async deleteTask(id: string): Promise<void> {
    this.updateTasks(data => {
      const index = data.tasks.findIndex((t) => t.id === id)
      if (index === -1) throw ApiError.notFound(`Task not found: ${id}`)
      data.tasks.splice(index, 1)
    })
  }

  /** 更新任务的最后执行时间 */
  async updateLastFired(taskId: string, timestamp: string): Promise<void> {
    this.updateTasks(data => {
      const task = data.tasks.find((t) => t.id === taskId)
      if (task) task.lastFiredAt = timestamp
    })
  }

  // ---------------------------------------------------------------------------
  // 内部: 数据库读写
  // ---------------------------------------------------------------------------

  /** 读取数据库中的任务列表。 */
  private async readTasksFile(): Promise<TasksFile> {
    try {
      const raw = getSessionStore().getAppDocument('scheduled-tasks', 'definitions')
      if (!raw) return { tasks: [] }
      const parsed = JSON.parse(raw) as TasksFile
      // 兼容异常格式
      if (!Array.isArray(parsed.tasks)) {
        return { tasks: [] }
      }
      return parsed
    } catch (err: unknown) {
      throw ApiError.internal(
        `Failed to read scheduled tasks from codev.db: ${(err as Error).message}`,
      )
    }
  }

  private updateTasks(update: (data: TasksFile) => void): void {
    getSessionStore().updateAppDocument('scheduled-tasks', 'definitions', raw => {
      const data: TasksFile = raw ? JSON.parse(raw) as TasksFile : { tasks: [] }
      if (!Array.isArray(data.tasks)) data.tasks = []
      update(data)
      return JSON.stringify(data)
    })
  }
}
