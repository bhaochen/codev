/**
 * TaskService — CLI Task V2 的读取与查询
 *
 * Task list state is persisted as SQLite documents in codev.db.
 * Task list ID 可以是 session ID、team name 等。
 */

import { getSessionStore } from '../../services/db/SessionStore.js'

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export type TaskInfo = {
  id: string
  subject: string
  name?: string
  teamName?: string
  description: string
  activeForm?: string
  owner?: string
  status: TaskStatus
  blocks: string[]
  blockedBy: string[]
  metadata?: Record<string, unknown>
  taskListId: string
}

export type TaskListSummary = {
  id: string
  taskCount: number
  completedCount: number
  inProgressCount: number
  pendingCount: number
}

export class TaskService {
  /** 列出所有 task list */
  async listTaskLists(): Promise<TaskListSummary[]> {
    return getSessionStore().listAppDocuments('task-lists').flatMap(({ key, content }) => {
      const tasks = this.parseTaskList(content, key)
      if (tasks.length === 0) return []
      return [{
        id: key,
        taskCount: tasks.length,
        completedCount: tasks.filter(task => task.status === 'completed').length,
        inProgressCount: tasks.filter(task => task.status === 'in_progress').length,
        pendingCount: tasks.filter(task => task.status === 'pending').length,
      }]
    })
  }

  /** 获取指定 task list 的所有任务 */
  async getTasksForList(taskListId: string): Promise<TaskInfo[]> {
    const key = taskListId.replace(/[^a-zA-Z0-9_-]/g, '-')
    const content = getSessionStore().getAppDocument('task-lists', key)
    return content ? this.parseTaskList(content, taskListId) : []
  }

  /** 列出所有任务（跨所有 task list） */
  async listTasks(): Promise<TaskInfo[]> {
    const allTasks: TaskInfo[] = []
    for (const { key, content } of getSessionStore().listAppDocuments('task-lists')) {
      allTasks.push(...this.parseTaskList(content, key))
    }
    return allTasks.sort((a, b) => {
      const createdA = Number(a.metadata?.createdAt ?? 0)
      const createdB = Number(b.metadata?.createdAt ?? 0)
      if (createdA !== createdB) return createdB - createdA
      return a.id.localeCompare(b.id)
    })
  }

  private parseTaskList(content: string, taskListId: string): TaskInfo[] {
    try {
      const data = JSON.parse(content) as { tasks?: unknown[] }
      return Array.isArray(data.tasks)
        ? data.tasks.map(task => this.parseTaskFile(task, taskListId)).filter((task): task is TaskInfo => task !== null)
        : []
    } catch {
      return []
    }
  }

  /** 获取单个任务详情 */
  async getTask(taskListId: string, taskId?: string): Promise<TaskInfo | null> {
    const tasks = taskId === undefined
      ? await this.listTasks()
      : await this.getTasksForList(taskListId)
    return tasks.find((t) => t.id === (taskId ?? taskListId)) || null
  }

  /** 解析单个任务文件 — 匹配 CLI V2 Task 格式 */
  private parseTaskFile(data: any, taskListId: string): TaskInfo | null {
    if (!data || typeof data !== 'object') return null
    if (!data.id) return null

    // Skip internal tasks
    if (data.metadata?._internal) return null

    return {
      id: String(data.id),
      subject: data.subject || data.name || '',
      name: data.name,
      teamName: data.teamName,
      description: data.description || '',
      activeForm: data.activeForm,
      owner: data.owner,
      status: (['pending', 'in_progress', 'completed', 'failed'].includes(data.status)
        ? data.status
        : 'pending') as TaskStatus,
      blocks: Array.isArray(data.blocks) ? data.blocks : [],
      blockedBy: Array.isArray(data.blockedBy) ? data.blockedBy : [],
      metadata: {
        ...(data.metadata ?? {}),
        ...(data.createdAt !== undefined ? { createdAt: data.createdAt } : {}),
      },
      taskListId,
    }
  }
}

export const taskService = new TaskService()
