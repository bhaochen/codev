/**
 * omni-adapter.ts — Bridge between VersperClaw Companion frontend and
 *     llama.cpp-omni's llama-server.
 *
 * Uses Omni Streaming API (/v1/stream/*) following the exact protocol
 * from MiniCPM-o-Demo:
 *   omni_init → update_session_config → prefill(cnt) → decode(round)
 *
 * TTS output: polls round_N/tts_wav/wav_N.wav, sends as Float32 PCM base64.
 *
 * Usage:
 *   OMNI_PORT=9301 LLAMA_SERVER=http://localhost:8025 bun run sidecars/omni-adapter.ts
 *
 * Env:
 *   OMNI_PORT=9301  LLAMA_SERVER=http://localhost:8025  OMNI_MODEL_DIR=...
 *   OMNI_TMP=/tmp/omni-adapter
 */

import { serve } from 'bun'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { randomBytes } from 'crypto'

// ─── Config ──────────────────────────────────────────────────

const PORT = parseInt(process.env.OMNI_PORT || '9301')
const LLAMA = (process.env.LLAMA_SERVER || 'http://localhost:8025').replace(/\/+$/, '')
const MODEL_DIR = (process.env.OMNI_MODEL_DIR || '/home/yuki/Code/Llm/MiniCPM-o-4_5-gguf').replace(/\/+$/, '')
const TMP = process.env.OMNI_TMP || '/tmp/omni-adapter'
const TTS_OUT = TMP + '/tts-output'

// ─── Helpers ─────────────────────────────────────────────────

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  })
}

function b32() { return randomBytes(4).readUInt32BE(0).toString(36) }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ─── llama-server client ─────────────────────────────────────

async function llamaPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${LLAMA}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function llamaGet(path: string): Promise<Response> {
  return fetch(`${LLAMA}${path}`)
}

// ─── Audio utils ─────────────────────────────────────────────

/** Write Float32 PCM as 16-bit mono WAV and return file path. */
function writePcmToWav(f32: Float32Array, sampleRate: number): string {
  const dataSize = f32.length * 2
  const buf = Buffer.alloc(44 + dataSize)
  let o = 0
  const w = (s: string) => { for (let i = 0; i < s.length; i++) buf[o++] = s.charCodeAt(i) }
  const u16 = (v: number) => { buf[o++] = v & 0xff; buf[o++] = (v >> 8) & 0xff }
  const u32 = (v: number) => { buf[o++] = v & 0xff; buf[o++] = (v >> 8) & 0xff; buf[o++] = (v >> 16) & 0xff; buf[o++] = (v >> 24) & 0xff }
  w('RIFF'); u32(36 + dataSize); w('WAVE'); w('fmt '); u32(16)
  u16(1); u16(1); u32(sampleRate); u32(sampleRate * 2); u16(2); u16(16)
  w('data'); u32(dataSize)
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]))
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, o); o += 2
  }
  const fp = `${TMP}/aud_${b32()}.wav`
  writeFileSync(fp, buf)
  return fp
}

/** Read WAV file and return Float32 PCM data (raw samples). */
function readWavToF32(fp: string): Float32Array | null {
  try {
    const buf = readFileSync(fp)
    if (buf.length < 44) return null
    const nSamples = Math.floor((buf.length - 44) / 2)
    if (nSamples <= 0) return null
    const f32 = new Float32Array(nSamples)
    for (let i = 0; i < nSamples; i++) {
      const s16 = buf.readInt16LE(44 + i * 2)
      f32[i] = s16 < 0 ? s16 / 0x8000 : s16 / 0x7fff
    }
    return f32
  } catch { return null }
}

function float32ToBase64(f32: Float32Array): string {
  return Buffer.from(new Uint8Array(f32.buffer)).toString('base64')
}

/** Convert browser base64 Float32 PCM to WAV file path. */
function pcmB64ToWav(b64: string, sr = 16000): string {
  const raw = Buffer.from(b64, 'base64')
  const len = Math.floor(raw.length / 4) * 4
  const f32 = new Float32Array(len / 4)
  for (let i = 0; i < f32.length; i++) f32[i] = raw.readFloatLE(i * 4)
  return writePcmToWav(f32, sr)
}

/** Convert base64-encoded JPEG/PNG image to temp file path. */
function saveImageB64(b64: string): string {
  const fp = `${TMP}/img_${b32()}.jpg`
  writeFileSync(fp, Buffer.from(b64, 'base64'))
  return fp
}

// ─── Omni session state ──────────────────────────────────────

let initialized = false
let roundIdx = 0

async function ensureInit(): Promise<boolean> {
  if (initialized) return true
  console.log('[omni] init...')
  const res = await llamaPost('/v1/stream/omni_init', {
    media_type: 2,
    use_tts: true,
    duplex_mode: false,
    model_dir: MODEL_DIR + '/',
    output_dir: TTS_OUT,
  })
  if (!res.ok) { console.error('[omni] init fail:', await res.text()); return false }
  initialized = true
  console.log('[omni] init ok')
  return true
}

/**
 * Call update_session_config to set system prompt and assistant template.
 * This is the CRITICAL step we were missing — it sets up the model's
 * prompt structure including <|audio_start|>/<|audio_end|> markers
 * and the user/assistant turn template.
 */
async function updateSessionConfig(systemPrompt: string): Promise<boolean> {
  const voice_clone_prompt = `<|im_start|>system\n${systemPrompt || 'You are a helpful assistant.'}\n<|audio_start|>`
  // assistant_prompt includes behavior instructions between <|audio_end|> and <|im_end|>,
  // matching MiniCPM-o-Demo's non-duplex format.
  const assistant_prompt = `<|audio_end|>请认真、高质量地回复用户的问题。请用高自然度的方式和用户聊天。<|im_end|>\n<|im_start|>user\n`
  const res = await llamaPost('/v1/stream/update_session_config', {
    media_type: 2,
    duplex_mode: false,
    voice_clone_prompt,
    assistant_prompt,
    lang: 'zh',
    reset_context: true,
  })
  if (!res.ok) { console.error('[omni] update_session_config fail:', await res.text()); return false }
  roundIdx = 0
  return true
}

/**
 * Prefill user text/audio/image input.
 * cnt starts from 0 and increments per call (following demo protocol).
 */
async function prefill(cnt: number, text: string, audioPath?: string, imagePath?: string): Promise<boolean> {
  const body: Record<string, unknown> = {
    audio_path_prefix: audioPath || '',
    img_path_prefix: imagePath || '',
    cnt,
    text: text || '',
  }
  const res = await llamaPost('/v1/stream/prefill', body)
  if (!res.ok) { console.error('[omni] prefill fail:', await res.text()) }
  return res.ok
}

/**
 * Decode (generate) with SSE streaming.
 * Calls onText(content, stop) for each SSE event.
 * Returns the path to the merged TTS WAV file (or null if none).
 */
async function decodeStream(
  onText: (content: string, stop: boolean) => void,
): Promise<string | null> {
  const res = await llamaPost('/v1/stream/decode', {
    stream: true,
    length_penalty: 1.1,
    round_idx: roundIdx,
  })
  if (!res.ok) throw new Error(`decode status ${res.status}`)

  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const p = line.slice(6).trim()
      if (p === '[DONE]') continue
      try {
        const ev = JSON.parse(p)
        if (ev.content !== undefined) onText(ev.content || '', ev.stop || false)
      } catch { /* skip */ }
    }
  }

  return pollTtsChunks()
}

/** Poll for TTS WAV files (incremental, following demo pattern). */
async function pollTtsChunks(): Promise<string | null> {
  const rounds = readdirSync(TTS_OUT).filter((e) => e.startsWith('round_')).sort()
  if (rounds.length === 0) return null
  const wavDir = `${TTS_OUT}/${rounds[rounds.length - 1]}/tts_wav`
  if (!existsSync(wavDir)) return null

  // Wait for generation_done.flag (up to ~30 s)
  const flagPath = `${wavDir}/generation_done.flag`
  for (let i = 0; i < 150; i++) {
    if (existsSync(flagPath)) break
    await sleep(200)
  }
  if (!existsSync(flagPath)) return null

  // Read all wav_N.wav files
  const files = readdirSync(wavDir)
    .filter((f) => /^wav_\d+\.wav$/.test(f))
    .sort()
  if (files.length === 0) return null

  // Merge into single Float32Array (original sample rate from WAV header)
  let sampleRate = 24000
  const chunks: Float32Array[] = []
  for (const f of files) {
    const buf = readFileSync(`${wavDir}/${f}`)
    if (buf.length < 44) continue
    const hdrSr = buf.readUInt32LE(24)
    if (hdrSr > 0) sampleRate = hdrSr
    const nSamples = Math.floor((buf.length - 44) / 2)
    if (nSamples <= 0) continue
    const f32 = new Float32Array(nSamples)
    for (let i = 0; i < nSamples; i++) {
      const s16 = buf.readInt16LE(44 + i * 2)
      f32[i] = s16 < 0 ? s16 / 0x8000 : s16 / 0x7fff
    }
    chunks.push(f32)
  }
  if (chunks.length === 0) return null

  const total = chunks.reduce((s, c) => s + c.length, 0)
  const merged = new Float32Array(total)
  let offset = 0
  for (const c of chunks) { merged.set(c, offset); offset += c.length }

  // Write merged WAV
  const outPath = writePcmToWav(merged, sampleRate)
  return outPath
}

// ─── Parse frontend messages ─────────────────────────────────

interface ParsedMsgs {
  systemPrompt: string
  userText: string
  audioB64: string | null
  imageB64: string | null
}

/** Extract system prompt + last user message content from frontend messages array. */
function parseMessages(messages: any[]): ParsedMsgs {
  let systemPrompt = ''
  let lastUser: any = null

  for (const msg of messages) {
    if (msg?.role === 'system' && typeof msg.content === 'string') {
      systemPrompt = msg.content
    }
    if (msg?.role === 'user') lastUser = msg
  }

  if (!lastUser) return { systemPrompt, userText: '', audioB64: null, imageB64: null }

  const content = lastUser.content
  if (!content) return { systemPrompt, userText: '', audioB64: null, imageB64: null }

  if (typeof content === 'string') {
    return { systemPrompt, userText: content, audioB64: null, imageB64: null }
  }

  if (Array.isArray(content)) {
    let text = '', audioB64: string | null = null, imageB64: string | null = null
    for (const item of content) {
      if (item.type === 'text') text = item.text || ''
      else if (item.type === 'audio') audioB64 = item.data || null
      else if (item.type === 'image') imageB64 = item.data || null
    }
    return { systemPrompt, userText: text, audioB64, imageB64 }
  }

  return { systemPrompt, userText: String(content), audioB64: null, imageB64: null }
}

// ─── Chat handler (WS streaming) ─────────────────────────────

async function handleChatMessage(ws: any, msg: any) {
  const { systemPrompt, userText, audioB64, imageB64 } = parseMessages(msg.messages)

  // Signal received
  ws.send(JSON.stringify({ type: 'prefill_done' }))

  try {
    // 1. Init if needed
    if (!await ensureInit()) {
      ws.send(JSON.stringify({ type: 'error', error: 'omni_init failed' }))
      return
    }

    // 2. Update session config with system prompt (resets context)
    await updateSessionConfig(systemPrompt || msg.system_prompt || '')

    // 3. Prefill user input (text + audio + image)
    let audioPath: string | null = null
    let imagePath: string | null = null

    if (audioB64) audioPath = pcmB64ToWav(audioB64)
    if (imageB64) imagePath = saveImageB64(imageB64)

    // Always prefill text content (even empty) with cnt=0
    const ok = await prefill(0, userText, audioPath || undefined, imagePath || undefined)
    if (audioPath) { try { unlinkSync(audioPath) } catch {} }
    if (imagePath) { try { unlinkSync(imagePath) } catch {} }
    if (!ok) {
      ws.send(JSON.stringify({ type: 'error', error: 'prefill failed' }))
      return
    }

    // 4. Decode (streaming SSE)
    let accumulated = ''

    const ttsWav = await decodeStream((content, _stop) => {
      // Content is incremental text segments; send directly
      if (content) {
        accumulated += content
        ws.send(JSON.stringify({ type: 'chunk', text_delta: content }))
      }
    })

    // 5. Send TTS audio if available
    if (ttsWav) {
      const f32 = readWavToF32(ttsWav)
      if (f32) {
        const audioB64 = float32ToBase64(f32)
        ws.send(JSON.stringify({ type: 'chunk', text_delta: '', audio_data: audioB64 }))
      }
      try { unlinkSync(ttsWav) } catch {}
    }

    // 6. Done
    ws.send(JSON.stringify({
      type: 'done',
      text: accumulated || '(empty reply)',
      recording_session_id: null,
    }))
  } catch (err) {
    console.error('[omni] error:', err)
    ws.send(JSON.stringify({ type: 'error', error: String(err) }))
  }
}

// ─── HTTP Server ─────────────────────────────────────────────

mkdirSync(TMP, { recursive: true })
mkdirSync(TTS_OUT, { recursive: true })

console.log(`[omni] adapter on :${PORT} → llama-server ${LLAMA}`)
console.log(`[omni] model: ${MODEL_DIR}`)
console.log(`[omni] tmp: ${TMP}, tts-out: ${TTS_OUT}`)

const app = serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': '*' },
      })
    }

    // GET /status
    if (p === '/status' && req.method === 'GET') {
      try {
        const h = await llamaGet('/health')
        return json({ gateway_healthy: h.ok, total_workers: 1, idle_workers: h.ok ? 1 : 0, busy_workers: 0, queue_length: 0, offline_workers: h.ok ? 0 : 1 })
      } catch { return json({ gateway_healthy: false, total_workers: 0, idle_workers: 0, busy_workers: 0, queue_length: 0, offline_workers: 1 }) }
    }

    // GET /api/presets
    if (p === '/api/presets' && req.method === 'GET') {
      return json({ turnbased: [], audio_duplex: [], omni: [] })
    }

    // POST /api/chat (non-streaming)
    if (p === '/api/chat' && req.method === 'POST') {
      try {
        const body = await req.json()
        const { systemPrompt, userText, audioB64, imageB64 } = parseMessages(body.messages)

        if (!await ensureInit()) return json({ error: 'init failed', success: false }, 500)
        await updateSessionConfig(systemPrompt || body.system_prompt || '')

        let audioPath: string | null = null
        let imagePath: string | null = null
        if (audioB64) audioPath = pcmB64ToWav(audioB64)
        if (imageB64) imagePath = saveImageB64(imageB64)

        await prefill(0, userText, audioPath || undefined, imagePath || undefined)
        if (audioPath) { try { unlinkSync(audioPath) } catch {} }
        if (imagePath) { try { unlinkSync(imagePath) } catch {} }

        let fullText = ''
        const ttsWav = await decodeStream((content) => { if (content) fullText += content })
        let audioData: string | null = null
        if (ttsWav) {
          const f32 = readWavToF32(ttsWav)
          if (f32) audioData = float32ToBase64(f32)
          try { unlinkSync(ttsWav) } catch {}
        }

        return json({ text: fullText.trim() || '(empty reply)', audio_data: audioData, audio_sample_rate: audioData ? 24000 : null, recording_session_id: null, success: true })
      } catch (err) {
        console.error('[omni] /api/chat error:', err)
        return json({ error: String(err), success: false }, 500)
      }
    }

    // WebSocket /ws/chat (streaming)
    if (p === '/ws/chat') {
      if (app.upgrade(req)) return
      return new Response('WS upgrade failed', { status: 400 })
    }

    // POST /omni/reset
    if (p === '/omni/reset' && req.method === 'POST') {
      await llamaPost('/v1/stream/reset', {}).catch(() => {})
      initialized = false
      return json({ success: true })
    }

    return new Response('Not found', { status: 404 })
  },

  websocket: {
    async message(ws, raw) {
      try {
        const msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw as BufferSource))

        if (msg.messages) { await handleChatMessage(ws, msg); return }
        if (msg.type === 'chat') { await handleChatMessage(ws, msg); return }

        if (msg.type === 'init') {
          const ok = await ensureInit()
          ws.send(JSON.stringify({ type: 'prefill_done', ok }))
          return
        }

        if (msg.type === 'reset') {
          await llamaPost('/v1/stream/reset', {}).catch(() => {})
          initialized = false
          ws.send(JSON.stringify({ type: 'reset', ok: true }))
          return
        }

        if (msg.type === 'break') {
          await llamaPost('/v1/stream/break', {}).catch(() => {})
          ws.send(JSON.stringify({ type: 'break', ok: true }))
          return
        }
      } catch (err) {
        console.error('[omni] ws error:', err)
        ws.send(JSON.stringify({ type: 'error', error: String(err) }))
      }
    },
    open() { console.log('[omni] ws connected') },
    close() { console.log('[omni] ws disconnected') },
  },
})

process.on('SIGINT', () => { console.log('[omni] shutting down'); process.exit(0) })
process.on('SIGTERM', () => { console.log('[omni] shutting down'); process.exit(0) })
