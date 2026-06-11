import { create } from 'zustand'
import type {
  CompanionStatus,
  ScenarioOption,
  MiniCPMoMessage,
  MiniCPMoServiceStatus,
  MiniCPMoPresetMode,
  MiniCPMoPreset,
  MiniCPMoAttachment,
} from '../types/companion'

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

export const SCENARIOS: ScenarioOption[] = [
  {
    id: 'interview',
    name: '模拟面试',
    nameEn: 'Mock Interview',
    icon: 'work_history',
    description: 'AI 模拟考官提问，支持上传简历',
    descriptionEn: 'AI mock interviewer with resume support',
  },
  {
    id: 'english',
    name: '英语陪练',
    nameEn: 'English Practice',
    icon: 'translate',
    description: '全英文对话，提升口语能力',
    descriptionEn: 'Full English conversation practice',
  },
  {
    id: 'singing',
    name: '唱歌',
    nameEn: 'Singing',
    icon: 'music_note',
    description: 'AI 陪你唱歌互动',
    descriptionEn: 'Sing with AI',
  },
  {
    id: 'translate',
    name: '同声传译',
    nameEn: 'Simultaneous Interpretation',
    icon: 'language',
    description: '实时翻译多国语言',
    descriptionEn: 'Real-time multi-language translation',
  },
  {
    id: 'idiom',
    name: '成语接龙',
    nameEn: 'Idiom Chain',
    icon: 'abc',
    description: '文字游戏互动',
    descriptionEn: 'Chinese idiom word game',
  },
  {
    id: 'mood',
    name: '心情树洞',
    nameEn: 'Mood Treehole',
    icon: 'forest',
    description: '情感陪伴与倾诉',
    descriptionEn: 'Emotional companion',
  },
]

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

  // New: scenario
  scenario: string | null
  scenarioPanelOpen: boolean

  // New: subtitle
  subtitleEnabled: boolean

  // New: camera devices
  cameraFacingMode: 'user' | 'environment'
  cameraDevices: MediaDeviceInfo[]
  activeCameraLabel: string | null

  // New: screen share
  screenShareStream: MediaStream | null

  // New: screen share dialog
  screenShareDialogOpen: boolean

  // New: status text
  statusText: string

  // New: fullscreen camera mode
  cameraFullscreen: boolean

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

  // New actions
  setScenario: (id: string | null) => void
  setScenarioPanelOpen: (open: boolean) => void
  setSubtitleEnabled: (enabled: boolean) => void
  setCameraFacingMode: (mode: 'user' | 'environment') => void
  setCameraDevices: (devices: MediaDeviceInfo[]) => void
  setActiveCameraLabel: (label: string | null) => void
  setScreenShareStream: (stream: MediaStream | null) => void
  setScreenShareDialogOpen: (open: boolean) => void
  setStatusText: (text: string) => void
  setCameraFullscreen: (fullscreen: boolean) => void

  // ─── MiniCPM-o state ──────────────────────────────────
  backendHost: string
  miniMessages: MiniCPMoMessage[]
  miniIsGenerating: boolean
  miniPendingText: string
  miniServiceStatus: MiniCPMoServiceStatus
  miniPresetsByMode: Record<MiniCPMoPresetMode, MiniCPMoPreset[]>
  miniSettingsOpen: boolean
  miniSettingsSheetMode: MiniCPMoPresetMode
  miniSystemPromptTurnbased: string
  miniMaxNewTokens: number
  miniLengthPenalty: number
  miniTtsEnabled: boolean
  miniStreamingEnabled: boolean
  miniError: string | null
  miniLastSessionId: string | null
  miniSessions: MiniCPMoSession[]
  miniActiveSessionId: string
  miniComposeMode: 'voice' | 'text'
  miniDraft: string
  miniPendingAttachments: MiniCPMoAttachment[]
  miniAttachMenuOpen: boolean
  miniRecording: boolean
  miniPreparingRecording: boolean
  miniRecordingWillCancel: boolean
  miniHistoryOpen: boolean

  setBackendHost: (host: string) => void
  setMiniMessages: (msgs: MiniCPMoMessage[]) => void
  appendMiniMessage: (msg: MiniCPMoMessage) => void
  setMiniIsGenerating: (v: boolean) => void
  setMiniPendingText: (t: string) => void
  setMiniServiceStatus: (s: MiniCPMoServiceStatus) => void
  setMiniPresetsByMode: (p: Record<MiniCPMoPresetMode, MiniCPMoPreset[]>) => void
  setMiniSettingsOpen: (o: boolean) => void
  setMiniSettingsSheetMode: (m: MiniCPMoPresetMode) => void
  setMiniSystemPromptTurnbased: (v: string) => void
  setMiniMaxNewTokens: (v: number) => void
  setMiniLengthPenalty: (v: number) => void
  setMiniTtsEnabled: (v: boolean) => void
  setMiniStreamingEnabled: (v: boolean) => void
  setMiniError: (e: string | null) => void
  setMiniLastSessionId: (id: string | null) => void
  setMiniSessions: (s: MiniCPMoSession[] | ((prev: MiniCPMoSession[]) => MiniCPMoSession[])) => void
  setMiniActiveSessionId: (id: string) => void
  setMiniComposeMode: (m: 'voice' | 'text') => void
  setMiniDraft: (d: string) => void
  setMiniPendingAttachments: (a: MiniCPMoAttachment[]) => void
  setMiniAttachMenuOpen: (o: boolean) => void
  setMiniRecording: (v: boolean) => void
  setMiniPreparingRecording: (v: boolean) => void
  setMiniRecordingWillCancel: (v: boolean) => void
  setMiniHistoryOpen: (o: boolean) => void
  removeMiniPendingAttachment: (id: string) => void
  addMiniPendingAttachments: (a: MiniCPMoAttachment[]) => void
}

export type MiniCPMoSession = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: MiniCPMoMessage[]
}

const DEFAULT_SERVER_URL = 'ws://127.0.0.1:8889/ws/companion'

// llama backend defaults — switch DEFAULT_BACKEND_HOST to use omni-adapter
const DEFAULT_BACKEND_HOST = 'http://localhost:9301'

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

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

  // New defaults
  scenario: null,
  scenarioPanelOpen: false,
  subtitleEnabled: true,
  cameraFacingMode: 'user',
  cameraDevices: [],
  activeCameraLabel: null,
  screenShareStream: null,
  screenShareDialogOpen: false,
  statusText: '你可以开始说话',
  cameraFullscreen: false,

  // ─── MiniCPM-o defaults ────────────────────────────────
  backendHost: DEFAULT_BACKEND_HOST,
  miniMessages: [],
  miniIsGenerating: false,
  miniPendingText: '',
  miniServiceStatus: { phase: 'loading', summary: '连接中...', detail: '正在连接后端服务' },
  miniPresetsByMode: { turnbased: [], audio_duplex: [], omni: [] },
  miniSettingsOpen: false,
  miniSettingsSheetMode: 'turnbased',
  miniSystemPromptTurnbased: '你的任务是作为一个助手认真、高质量地回复用户的问题。请用高自然度的方式和用户聊天。',
  miniMaxNewTokens: 256,
  miniLengthPenalty: 1.1,
  miniTtsEnabled: true,
  miniStreamingEnabled: true,
  miniError: null,
  miniLastSessionId: null,
  miniSessions: [],
  miniActiveSessionId: createId('session'),
  miniComposeMode: 'voice',
  miniDraft: '',
  miniPendingAttachments: [],
  miniAttachMenuOpen: false,
  miniRecording: false,
  miniPreparingRecording: false,
  miniRecordingWillCancel: false,
  miniHistoryOpen: false,

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
      scenario: null,
      subtitleEnabled: true,
      cameraFacingMode: 'user',
      screenShareStream: null,
      statusText: '你可以开始说话',
      cameraFullscreen: false,
    }),

  // New action implementations
  setScenario: (id) => set({ scenario: id, scenarioPanelOpen: false }),
  setScenarioPanelOpen: (open) => set({ scenarioPanelOpen: open }),
  setSubtitleEnabled: (enabled) => set({ subtitleEnabled: enabled }),
  setCameraFacingMode: (mode) => set({ cameraFacingMode: mode }),
  setCameraDevices: (devices) => set({ cameraDevices: devices }),
  setActiveCameraLabel: (label) => set({ activeCameraLabel: label }),
  setScreenShareStream: (stream) => set({ screenShareStream: stream }),
  setScreenShareDialogOpen: (open) => set({ screenShareDialogOpen: open }),
  setStatusText: (text) => set({ statusText: text }),
  setCameraFullscreen: (fullscreen) => set({ cameraFullscreen: fullscreen }),

  // ─── MiniCPM-o actions ──────────────────────────────────
  setBackendHost: (host) => set({ backendHost: host }),
  setMiniMessages: (msgs) => set({ miniMessages: msgs }),
  appendMiniMessage: (msg) =>
    set((s) => ({ miniMessages: [...s.miniMessages, msg] })),
  setMiniIsGenerating: (v) => set({ miniIsGenerating: v, miniPendingText: v ? '' : '' }),
  setMiniPendingText: (t) => set({ miniPendingText: t }),
  setMiniServiceStatus: (s) => set({ miniServiceStatus: s }),
  setMiniPresetsByMode: (p) => set({ miniPresetsByMode: p }),
  setMiniSettingsOpen: (o) => set({ miniSettingsOpen: o }),
  setMiniSettingsSheetMode: (m) => set({ miniSettingsSheetMode: m }),
  setMiniSystemPromptTurnbased: (v) => set({ miniSystemPromptTurnbased: v }),
  setMiniMaxNewTokens: (v) => set({ miniMaxNewTokens: v }),
  setMiniLengthPenalty: (v) => set({ miniLengthPenalty: v }),
  setMiniTtsEnabled: (v) => set({ miniTtsEnabled: v }),
  setMiniStreamingEnabled: (v) => set({ miniStreamingEnabled: v }),
  setMiniError: (e) => set({ miniError: e }),
  setMiniLastSessionId: (id) => set({ miniLastSessionId: id }),
  setMiniSessions: (s) => set((state) => ({ miniSessions: typeof s === 'function' ? s(state.miniSessions) : s })),
  setMiniActiveSessionId: (id) => set({ miniActiveSessionId: id }),
  setMiniComposeMode: (m) => set({ miniComposeMode: m }),
  setMiniDraft: (d) => set({ miniDraft: d }),
  setMiniPendingAttachments: (a) => set({ miniPendingAttachments: a }),
  setMiniAttachMenuOpen: (o) => set({ miniAttachMenuOpen: o }),
  setMiniRecording: (v) => set({ miniRecording: v }),
  setMiniPreparingRecording: (v) => set({ miniPreparingRecording: v }),
  setMiniRecordingWillCancel: (v) => set({ miniRecordingWillCancel: v }),
  setMiniHistoryOpen: (o) => set({ miniHistoryOpen: o }),
  removeMiniPendingAttachment: (id) =>
    set((s) => ({
      miniPendingAttachments: s.miniPendingAttachments.filter((a) => a.id !== id),
    })),
  addMiniPendingAttachments: (a) =>
    set((s) => ({
      miniPendingAttachments: [...s.miniPendingAttachments, ...a],
    })),
}))
