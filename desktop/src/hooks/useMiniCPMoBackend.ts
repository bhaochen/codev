import type {
  MiniCPMoMessage,
  MiniCPMoServiceStatus,
  MiniCPMoPresetMode,
  MiniCPMoPreset,
  MiniCPMoBackendContentItem,
} from '../types/companion'

// ─── Utility functions ported from MiniCPM-o mobile ──────

function createId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`
}

function float32ToBase64(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  const chunkSize = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))
    binary += String.fromCharCode.apply(null, Array.from(slice) as number[])
  }
  return btoa(binary)
}

export function float32ToWavBlobUrl(float32: Float32Array, sampleRate: number): string {
  const buffer = new ArrayBuffer(44 + float32.length * 2)
  const view = new DataView(buffer)
  function writeString(offset: number, value: string) {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + float32.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, float32.length * 2, true)
  let offset = 44
  for (let i = 0; i < float32.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32[i] ?? 0))
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
    offset += 2
  }
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
}

function audioBase64ToBlobUrl(base64Data: string, sampleRate = 24000): string {
  const binary = atob(base64Data)
  const raw = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i)

  // Check if it's already WAV
  if (raw.length >= 44 && raw[0] === 0x52 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x46) {
    return URL.createObjectURL(new Blob([raw], { type: 'audio/wav' }))
  }

  // Treat as float32 PCM bytes
  const float32 = new Float32Array(raw.length / 4)
  for (let i = 0; i < float32.length; i++) {
    float32[i] = new Float32Array(raw.slice(i * 4, (i + 1) * 4))[0] ?? 0
  }
  return float32ToWavBlobUrl(float32, sampleRate)
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) return input
  const ratio = fromRate / toRate
  const outLength = Math.max(1, Math.floor(input.length / ratio))
  const out = new Float32Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio
    const idx = Math.floor(srcPos)
    const frac = srcPos - idx
    const a = input[idx] ?? 0
    const b = input[idx + 1] ?? a
    out[i] = a + (b - a) * frac
  }
  return out
}

export async function fileToBase64Stripped(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const i = result.indexOf(',')
      resolve(i >= 0 ? result.slice(i + 1) : result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export async function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export async function downscaleImageToAttachment(
  file: File,
  maxEdge = 1280,
  quality = 0.85,
): Promise<{ id: string; kind: 'image'; previewUrl: string; base64: string; name: string }> {
  const dataUrl = await readFileAsDataUrl(file)
  const img: HTMLImageElement = await new Promise((resolve, reject) => {
    const i = new Image()
    i.onload = () => resolve(i)
    i.onerror = () => reject(new Error('image load failed'))
    i.src = dataUrl
  })
  let w = img.naturalWidth
  let h = img.naturalHeight
  const longEdge = Math.max(w, h)
  if (longEdge > maxEdge) {
    const scale = maxEdge / longEdge
    w = Math.round(w * scale)
    h = Math.round(h * scale)
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 2d unavailable')
  ctx.drawImage(img, 0, 0, w, h)
  const outDataUrl = canvas.toDataURL('image/jpeg', quality)
  const base64 = outDataUrl.slice(outDataUrl.indexOf(',') + 1)
  return { id: createId('att'), kind: 'image', previewUrl: outDataUrl, base64, name: file.name || 'photo.jpg' }
}

export async function mediaFileToAttachment(
  file: File,
  kind: 'audio' | 'video',
): Promise<{ id: string; kind: 'audio' | 'video'; previewUrl: string; base64: string; name: string; duration?: number }> {
  const base64 = await fileToBase64Stripped(file)
  const previewUrl = URL.createObjectURL(file)
  let duration: number | undefined
  try {
    duration = await new Promise<number>((resolve) => {
      const el = document.createElement(kind === 'audio' ? 'audio' : 'video')
      el.preload = 'metadata'
      const onLoaded = () => {
        const d = Number.isFinite(el.duration) ? el.duration : 0
        resolve(d)
      }
      el.addEventListener('loadedmetadata', onLoaded, { once: true })
      el.addEventListener('error', () => resolve(0), { once: true })
      el.src = previewUrl
    })
  } catch {
    duration = undefined
  }
  return { id: createId('att'), kind, previewUrl, base64, name: file.name || kind, duration }
}

// ─── API Hooks ──────────────────────────────────────────

type ServiceStatusResponse = {
  gateway_healthy: boolean
  total_workers: number
  idle_workers: number
  busy_workers: number
  queue_length: number
  offline_workers: number
}

export async function fetchServiceStatus(host: string): Promise<MiniCPMoServiceStatus> {
  try {
    const res = await fetch(`${host}/status`, { signal: AbortSignal.timeout(5000) })
    const data = (await res.json()) as ServiceStatusResponse
    return {
      phase: data.gateway_healthy ? 'ready' : 'error',
      summary: data.gateway_healthy ? '后端就绪' : '网关异常',
      detail: `${data.idle_workers}/${data.total_workers} workers, 队列 ${data.queue_length}, 离线 ${data.offline_workers}`,
    }
  } catch {
    return { phase: 'error', summary: '后端不可达', detail: '请确保 MiniCPM-o 服务已启动' }
  }
}

export async function fetchPresets(host: string): Promise<Record<MiniCPMoPresetMode, MiniCPMoPreset[]>> {
  try {
    const res = await fetch(`${host}/api/presets`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return { turnbased: [], audio_duplex: [], omni: [] }
    const data = (await res.json()) as Partial<Record<MiniCPMoPresetMode, MiniCPMoPreset[]>>
    return {
      turnbased: data.turnbased ?? [],
      audio_duplex: data.audio_duplex ?? [],
      omni: data.omni ?? [],
    }
  } catch {
    return { turnbased: [], audio_duplex: [], omni: [] }
  }
}

// ─── Chat message builder ───────────────────────────────

function buildRequestMessages(
  entries: MiniCPMoMessage[],
  systemMessage?: string | MiniCPMoBackendContentItem[] | null,
): Array<{ role: string; content: string | MiniCPMoBackendContentItem[] }> {
  const messages: Array<{ role: string; content: string | MiniCPMoBackendContentItem[] }> = []

  if (typeof systemMessage === 'string' && systemMessage.trim()) {
    messages.push({ role: 'system', content: systemMessage.trim() })
  } else if (Array.isArray(systemMessage) && systemMessage.length) {
    messages.push({ role: 'system', content: systemMessage })
  }

  for (const entry of entries) {
    if (entry.role === 'assistant') {
      messages.push({ role: 'assistant', content: entry.text })
    } else if (entry.kind === 'text') {
      const atts = entry.attachments ?? []
      if (atts.length === 0) {
        messages.push({ role: 'user', content: entry.text })
      } else {
        const items: MiniCPMoBackendContentItem[] = []
        for (const a of atts) {
          if (a.kind === 'image') items.push({ type: 'image', data: a.base64 })
          else if (a.kind === 'audio') items.push({ type: 'audio', data: a.base64, name: a.name, duration: a.duration })
          else items.push({ type: 'video', data: a.base64, duration: a.duration })
        }
        if (entry.text) items.push({ type: 'text', text: entry.text })
        messages.push({ role: 'user', content: items })
      }
    } else if (entry.kind === 'voice') {
      const voiceAtts = entry.attachments ?? []
      if (voiceAtts.length === 0) {
        messages.push({ role: 'user', content: [{ type: 'audio', data: entry.audioBase64 }] })
      } else {
        const items: MiniCPMoBackendContentItem[] = []
        for (const a of voiceAtts) {
          if (a.kind === 'image') items.push({ type: 'image', data: a.base64 })
          else if (a.kind === 'audio') items.push({ type: 'audio', data: a.base64, name: a.name, duration: a.duration })
          else items.push({ type: 'video', data: a.base64, duration: a.duration })
        }
        items.push({ type: 'audio', data: entry.audioBase64 })
        messages.push({ role: 'user', content: items })
      }
    }
  }

  return messages
}

// ─── Streaming PCM Player ───────────────────────────────

export class StreamingPcmPlayer {
  private readonly audioCtx: AudioContext
  private readonly sampleRate: number
  private readonly chunks: Float32Array[] = []
  private nextStartTime = 0
  private finished = false
  private disposed = false

  constructor(sampleRate = 24000) {
    this.sampleRate = sampleRate
    const ctor = window.AudioContext ?? (window as any).webkitAudioContext
    if (!ctor) throw new Error('AudioContext not supported')
    this.audioCtx = new ctor({ sampleRate })
  }

  pushBase64(base64Data: string): void {
    if (this.disposed) return
    const binary = atob(base64Data)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    if (bytes.byteLength === 0) return
    const float32 = new Float32Array(bytes.buffer.slice(0))
    if (float32.length === 0) return
    this.chunks.push(float32)
    this.scheduleChunk(float32)
  }

  private scheduleChunk(float32: Float32Array): void {
    if (this.audioCtx.state === 'suspended') void this.audioCtx.resume().catch(() => {})
    const buffer = this.audioCtx.createBuffer(1, float32.length, this.sampleRate)
    buffer.getChannelData(0).set(float32)
    const source = this.audioCtx.createBufferSource()
    source.buffer = buffer
    source.connect(this.audioCtx.destination)
    const now = this.audioCtx.currentTime
    const when = Math.max(now + 0.02, this.nextStartTime)
    source.start(when)
    this.nextStartTime = when + buffer.duration
  }

  markFinished(): void { this.finished = true }
  isFinished(): boolean { return this.finished }

  getMergedFloat32(): Float32Array | null {
    if (this.chunks.length === 0) return null
    const total = this.chunks.reduce((sum, c) => sum + c.length, 0)
    const merged = new Float32Array(total)
    let offset = 0
    for (const chunk of this.chunks) { merged.set(chunk, offset); offset += chunk.length }
    return merged
  }

  getSampleRate(): number { return this.sampleRate }

  async dispose(): Promise<void> {
    this.disposed = true
    try { await this.audioCtx.close() } catch { /* ignore */ }
  }

  disposeAfterDrain(onDrained?: () => void): void {
    if (this.disposed) { onDrained?.(); return }
    const now = this.audioCtx.currentTime
    const drainSeconds = Math.max(0, this.nextStartTime - now)
    setTimeout(() => { void this.dispose(); onDrained?.() }, Math.ceil(drainSeconds * 1000) + 500)
  }
}

// ─── Chat submission ────────────────────────────────────

type ChatPayload = {
  text?: string
  error?: string
  success?: boolean
  audio_data?: string | null
  audio_sample_rate?: number
  recording_session_id?: string | null
}

export async function submitChatNonStreaming(
  host: string,
  messages: MiniCPMoMessage[],
  systemMessage: string | null,
  maxNewTokens: number,
  lengthPenalty: number,
  ttsEnabled: boolean,
  signal?: AbortSignal,
): Promise<{ entry: MiniCPMoMessage; sessionId: string | null }> {
  const requestBody = JSON.stringify({
    messages: buildRequestMessages(messages, systemMessage),
    streaming: false,
    generation: { max_new_tokens: maxNewTokens, length_penalty: lengthPenalty },
    ...(ttsEnabled ? { use_tts_template: true } : {}),
    tts: { enabled: ttsEnabled, mode: 'audio_assistant' },
  })

  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: requestBody,
    signal,
  })

  const rawText = await res.text()
  let payload: ChatPayload
  try { payload = JSON.parse(rawText) as ChatPayload } catch { throw new Error(rawText || `HTTP ${res.status}`) }
  if (!res.ok || payload.success === false) throw new Error(payload.error || `HTTP ${res.status}`)

  let audioUrl: string | null = null
  const audioSampleRate = payload.audio_sample_rate ?? 24000
  if (payload.audio_data) {
    try { audioUrl = audioBase64ToBlobUrl(payload.audio_data, audioSampleRate) } catch { audioUrl = null }
  }

  return {
    entry: {
      id: createId('assistant'),
      role: 'assistant',
      kind: 'assistant',
      text: payload.text?.trim() || '(empty reply)',
      audioPreviewUrl: audioUrl,
      audioBase64: payload.audio_data ?? null,
      audioSampleRate: payload.audio_data ? audioSampleRate : null,
      recordingSessionId: payload.recording_session_id ?? null,
    },
    sessionId: payload.recording_session_id ?? null,
  }
}

export type StreamCallbacks = {
  onChunk: (text: string) => void
  onAudioBase64: (data: string, sampleRate: number) => void
  onDone: (fullText: string, recordingSessionId: string | null) => void
  onError: (error: string) => void
}

export function submitChatStreaming(
  host: string,
  messages: MiniCPMoMessage[],
  systemMessage: string | null,
  maxNewTokens: number,
  lengthPenalty: number,
  ttsEnabled: boolean,
  callbacks: StreamCallbacks,
  player?: StreamingPcmPlayer,
): { abort: () => void } {
  const wsProto = host.startsWith('https') ? 'wss:' : 'ws:'
  const wsHost = host.replace(/^https?:\/\//, '')
  const wsUrl = `${wsProto}//${wsHost}/ws/chat`
  let finished = false
  let ws: WebSocket | null = null
  let fullText = ''

  try { ws = new WebSocket(wsUrl) } catch (e) { callbacks.onError('WebSocket creation failed'); return { abort: () => {} } }

  ws.onopen = () => {
    ws!.send(JSON.stringify({
      messages: buildRequestMessages(messages, systemMessage),
      streaming: true,
      generation: { max_new_tokens: maxNewTokens, length_penalty: lengthPenalty },
      ...(ttsEnabled ? { use_tts_template: true } : {}),
      tts: { enabled: ttsEnabled, mode: 'audio_assistant' },
    }))
  }

  ws.onmessage = (event) => {
    if (finished) return
    let msg: any
    try { msg = JSON.parse(event.data) } catch { return }

    if (msg.type === 'prefill_done') return
    if (msg.type === 'chunk') {
      if (typeof msg.text_delta === 'string' && msg.text_delta) {
        fullText += msg.text_delta
        callbacks.onChunk(fullText)
      }
      if (msg.audio_data && player) {
        try { player.pushBase64(msg.audio_data) } catch { /* ignore */ }
      }
      return
    }
    if (msg.type === 'done') {
      finished = true
      const finalText = (fullText || msg.text || '').trim() || '(empty reply)'
      callbacks.onDone(finalText, msg.recording_session_id ?? null)
      try { ws?.close() } catch { /* ignore */ }
      return
    }
    if (msg.type === 'error') {
      finished = true
      callbacks.onError(msg.error || 'unknown error')
      try { ws?.close() } catch { /* ignore */ }
    }
  }

  ws.onerror = () => { if (!finished) { finished = true; callbacks.onError('WebSocket connection error') } }
  ws.onclose = () => { if (!finished) { finished = true; callbacks.onError('WebSocket closed unexpectedly') } }

  return {
    abort: () => {
      finished = true
      try { ws?.close() } catch { /* ignore */ }
    },
  }
}

// ─── Microphone capture (ported from MiniCPM-o mobile) ──

function getPcmWorkletUrl(backendHost: string): string {
  const host = backendHost.replace(/\/+$/, '')
  return `${host}/static/duplex/lib/pcm-capture-turnbased.js`
}

export function getAudioContextCtor(): typeof AudioContext | null {
  return window.AudioContext ?? (window as any).webkitAudioContext ?? null
}

type MicCaptureState = {
  stream: MediaStream | null
  ctx: AudioContext | null
  source: MediaStreamAudioSourceNode | null
  worklet: AudioWorkletNode | null
  processor: ScriptProcessorNode | null
  muteGain: GainNode | null
  chunks: Float32Array[]
  sampleRate: number
  capturing: boolean
}

export function createMicCapture(): MicCaptureState {
  return {
    stream: null,
    ctx: null,
    source: null,
    worklet: null,
    processor: null,
    muteGain: null,
    chunks: [],
    sampleRate: 16000,
    capturing: false,
  }
}

export async function prewarmMic(state: MicCaptureState, backendHost: string): Promise<boolean> {
  if (state.ctx && state.stream) return true
  const AudioContextCtor = getAudioContextCtor()
  if (!AudioContextCtor || !navigator.mediaDevices?.getUserMedia) return false

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const ctx = new AudioContextCtor()
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {})
    const source = ctx.createMediaStreamSource(stream)
    state.stream = stream
    state.ctx = ctx
    state.source = source
    state.chunks = []
    state.sampleRate = ctx.sampleRate

    if (typeof AudioWorkletNode !== 'undefined' && typeof ctx.audioWorklet?.addModule === 'function') {
      try {
        const workletUrl = getPcmWorkletUrl(backendHost)
        await ctx.audioWorklet.addModule(workletUrl)
        const node = new AudioWorkletNode(ctx, 'pcm-capture-turnbased')
        node.port.onmessage = (event: MessageEvent) => {
          const data = event.data as { type: string; samples: Float32Array } | undefined
          if (data?.type === 'pcm' && state.capturing) state.chunks.push(data.samples)
        }
        source.connect(node)
        state.worklet = node
        return true
      } catch {
        // fall through to ScriptProcessor
      }
    }

    // ScriptProcessor fallback
    const processor = ctx.createScriptProcessor(4096, 1, 1)
    const muteGain = ctx.createGain()
    muteGain.gain.value = 0
    processor.onaudioprocess = (event) => {
      if (!state.capturing) return
      const input = event.inputBuffer.getChannelData(0)
      const copy = new Float32Array(input.length)
      copy.set(input)
      state.chunks.push(copy)
    }
    source.connect(processor)
    processor.connect(muteGain)
    muteGain.connect(ctx.destination)
    state.processor = processor
    state.muteGain = muteGain
    return true
  } catch {
    return false
  }
}

export function setCapturing(state: MicCaptureState, value: boolean) {
  state.capturing = value
  if (state.worklet) {
    try { state.worklet.port.postMessage({ type: 'capture', value }) } catch { /* ignore */ }
  }
}

export function coldDownMic(state: MicCaptureState) {
  state.capturing = false
  try { state.worklet?.port.postMessage({ type: 'capture', value: false }) } catch { /* ignore */ }
  try { state.worklet?.disconnect() } catch { /* ignore */ }
  try { state.processor?.disconnect() } catch { /* ignore */ }
  try { state.source?.disconnect() } catch { /* ignore */ }
  try { state.muteGain?.disconnect() } catch { /* ignore */ }
  state.worklet = null
  state.processor = null
  state.source = null
  state.muteGain = null
  if (state.ctx && state.ctx.state !== 'closed') void state.ctx.close().catch(() => {})
  state.ctx = null
  state.stream?.getTracks().forEach((t) => t.stop())
  state.stream = null
  state.chunks = []
}

export function finalizeRecordingChunks(
  state: MicCaptureState,
): { audioBase64: string; previewUrl: string; durationMs: number } | null {
  const chunks = state.chunks
  if (chunks.length === 0) return null
  const merged = concatFloat32(chunks)
  if (merged.length === 0) return null
  const resampled = resampleLinear(merged, state.sampleRate, 16000)
  const audioBase64 = float32ToBase64(resampled)
  const previewUrl = float32ToWavBlobUrl(resampled, 16000)
  return { audioBase64, previewUrl, durationMs: 0 } // caller should compute actual duration
}
