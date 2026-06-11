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

// ─── MiniCPM-o types ──────────────────────────────────────

export type MiniCPMoAttachment =
  | {
      id: string
      kind: 'image'
      previewUrl: string
      base64: string
      name: string
    }
  | {
      id: string
      kind: 'audio'
      previewUrl: string
      base64: string
      name: string
      duration?: number
    }
  | {
      id: string
      kind: 'video'
      previewUrl: string
      base64: string
      name: string
      duration?: number
    }

export type MiniCPMoMessage =
  | {
      id: string
      role: 'assistant'
      kind: 'assistant'
      text: string
      error?: boolean
      interrupted?: boolean
      audioPreviewUrl?: string | null
      audioBase64?: string | null
      audioSampleRate?: number | null
      recordingSessionId?: string | null
    }
  | {
      id: string
      role: 'user'
      kind: 'text'
      text: string
      attachments?: MiniCPMoAttachment[]
    }
  | {
      id: string
      role: 'user'
      kind: 'voice'
      audioBase64: string
      durationMs: number
      previewUrl: string
      attachments?: MiniCPMoAttachment[]
    }

export type MiniCPMoServiceStatus = {
  phase: 'loading' | 'ready' | 'error'
  summary: string
  detail: string
}

export type MiniCPMoPresetMode = 'turnbased' | 'audio_duplex' | 'omni'

export type MiniCPMoPreset = {
  id: string
  order?: number
  name: string
  description?: string
  system_prompt?: string
}

export interface MiniCPMoBackendContentItem {
  type: 'text' | 'audio' | 'image' | 'video'
  text?: string
  data?: string
  path?: string
  name?: string
  duration?: number
}
