import { create } from 'zustand'
import type { CompanionStatus } from '../types/companion'

const AVATAR_KEY = 'companion-avatar-url'
const BACKGROUND_KEY = 'companion-background-url'

function loadPersisted(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function persist(key: string, value: string | null) {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // localStorage may be full; silently ignore
  }
}

interface CompanionStore {
  status: CompanionStatus
  serverUrl: string
  voiceName: string
  speaking: boolean
  generating: boolean
  transcript: string
  fullTranscript: string
  micEnabled: boolean
  cameraEnabled: boolean
  error: string | null
  avatarUrl: string | null
  backgroundUrl: string | null

  setServerUrl: (url: string) => void
  setVoiceName: (name: string) => void
  setStatus: (status: CompanionStatus) => void
  setSpeaking: (speaking: boolean) => void
  setGenerating: (generating: boolean) => void
  appendTranscript: (text: string) => void
  appendFullTranscript: (text: string) => void
  resetTranscript: () => void
  setMicEnabled: (enabled: boolean) => void
  setCameraEnabled: (enabled: boolean) => void
  setError: (error: string | null) => void
  setAvatarUrl: (url: string | null) => void
  setBackgroundUrl: (url: string | null) => void
  reset: () => void
}

const DEFAULT_SERVER_URL = 'ws://127.0.0.1:8889/ws/companion'

export const useCompanionStore = create<CompanionStore>((set) => ({
  status: 'disconnected',
  serverUrl: DEFAULT_SERVER_URL,
  voiceName: 'default',
  speaking: false,
  generating: false,
  transcript: '',
  fullTranscript: '',
  micEnabled: true,
  cameraEnabled: true,
  error: null,
  avatarUrl: loadPersisted(AVATAR_KEY),
  backgroundUrl: loadPersisted(BACKGROUND_KEY),

  setServerUrl: (url) => set({ serverUrl: url }),
  setVoiceName: (name) => set({ voiceName: name }),
  setStatus: (status) => set({ status, error: status === 'error' ? undefined : null }),
  setSpeaking: (speaking) => set({ speaking }),
  setGenerating: (generating) => set({ generating }),
  appendTranscript: (text) =>
    set((s) => ({ transcript: s.transcript + text })),
  appendFullTranscript: (text) =>
    set((s) => ({ fullTranscript: s.fullTranscript + text + '\n' })),
  resetTranscript: () => set({ transcript: '' }),
  setMicEnabled: (enabled) => set({ micEnabled: enabled }),
  setCameraEnabled: (enabled) => set({ cameraEnabled: enabled }),
  setError: (error) => set({ error }),
  setAvatarUrl: (url) => {
    persist(AVATAR_KEY, url)
    set({ avatarUrl: url })
  },
  setBackgroundUrl: (url) => {
    persist(BACKGROUND_KEY, url)
    set({ backgroundUrl: url })
  },
  reset: () =>
    set({
      status: 'disconnected',
      speaking: false,
      generating: false,
      transcript: '',
      error: null,
    }),
}))
