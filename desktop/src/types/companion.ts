export type CompanionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export type ScenarioOption = {
  id: string
  name: string
  nameEn: string
  icon: string
  description: string
  descriptionEn: string
}

export type CompanionConfig = {
  serverUrl: string
  voiceName: string
}

// Server -> Client (text frame)
export type CompanionServerMessage =
  | { type: 'vad'; speaking: boolean }
  | { type: 'generating' }
  | { type: 'text'; content: string }
  | { type: 'done'; interrupted: boolean }

// Client -> Server (text frame)
export type CompanionClientMessage =
  | { type: 'frame'; data: string }
  | { type: 'stop' }
  | { type: 'end' }
  | { type: 'context'; voice?: string }
