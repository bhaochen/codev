import { EventEmitter } from '../../ink/events/emitter.js'

export interface QuestionOption {
  label: string
  description?: string
  preview?: string
}

export interface QuestionInfo {
  question: string
  header?: string
  options: QuestionOption[]
  multiSelect?: boolean
  custom?: boolean
}

export interface QuestionRequest {
  id: string
  questions: QuestionInfo[]
  tool?: {
    messageID: string
    callID: string
  }
}

export type QuestionAnswer = string[]

export type ReplyInput = {
  requestID: string
  answers: QuestionAnswer[]
}

interface Pending {
  readonly request: QuestionRequest
  resolve: (answers: ReadonlyArray<QuestionAnswer>) => void
  reject: (reason?: Error) => void
}

class RejectedError extends Error {
  constructor() {
    super('The user dismissed this question')
    this.name = 'QuestionV2.RejectedError'
  }
}

/**
 * Standalone question channel, decoupled from the permission system.
 * Mirrors opencode's QuestionV2 service: a tool's `call` awaits `ask`,
 * the TUI renders an independent overlay, and `reply`/`reject` resolve it.
 */
class QuestionService {
  private pending = new Map<string, Pending>()
  private seq = 0
  readonly events = new EventEmitter()

  private nextID(): string {
    this.seq += 1
    return `que_${Date.now().toString(36)}_${this.seq}`
  }

  ask(questions: QuestionInfo[]): Promise<ReadonlyArray<QuestionAnswer>> {
    const id = this.nextID()
    const request: QuestionRequest = { id, questions }
    return new Promise<ReadonlyArray<QuestionAnswer>>((resolve, reject) => {
      this.pending.set(id, { request, resolve, reject })
      this.events.emit('asked', request)
    })
  }

  reply(input: ReplyInput): boolean {
    const existing = this.pending.get(input.requestID)
    if (!existing) return false
    this.events.emit('replied', {
      requestID: existing.request.id,
      answers: input.answers.map(a => [...a]),
    })
    existing.resolve(input.answers)
    this.pending.delete(input.requestID)
    return true
  }

  reject(requestID: string): boolean {
    const existing = this.pending.get(requestID)
    if (!existing) return false
    this.events.emit('rejected', { requestID: existing.request.id })
    existing.reject(new RejectedError())
    this.pending.delete(requestID)
    return true
  }

  list(): QuestionRequest[] {
    return Array.from(this.pending.values(), p => p.request)
  }

  current(): QuestionRequest | undefined {
    const all = this.list()
    return all[all.length - 1]
  }
}

export const questionService = new QuestionService()
export { RejectedError }
