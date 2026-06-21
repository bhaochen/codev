/**
 * Groq Whisper STT — cloud-based speech-to-text via Groq LPU API.
 *
 * Uses the official groq-sdk npm package. Tries whisper-large-v3 first,
 * falls back to whisper-large-v3-turbo on rate-limit (429) errors.
 *
 * No Python subprocess needed. Pure TypeScript.
 */

import Groq from 'groq-sdk'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { VoiceStreamCallbacks, VoiceStreamConnection, FinalizeSource } from '../voiceStreamSTT.js'

const MODELS = ['whisper-large-v3', 'whisper-large-v3-turbo'] as const

export type GroqSttOptions = {
  /** Explicit API key (highest priority) */
  apiKey?: string
  model?: string
  language?: string
}

/**
 * Resolve the Groq API key from multiple sources (priority order):
 * 1. Explicitly passed `apiKey` option
 * 2. `getPrefs().groqApiKey` (from friend.json)
 * 3. `process.env.GROQ_API_KEY`
 * 4. `~/.claude/settings.json` → env.groqApiKey
 */
export function resolveGroqApiKey(explicitKey?: string): string | undefined {
  if (explicitKey) return explicitKey
  if (process.env.GROQ_API_KEY) return process.env.GROQ_API_KEY

  // Fallback: read from ~/.claude/settings.json
  try {
    const settingsPath = join(homedir(), '.claude', 'settings.json')
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, 'utf-8')
      const settings = JSON.parse(raw)
      if (settings.env?.groqApiKey) {
        return settings.env.groqApiKey
      }
      if (settings.env?.GROQ_API_KEY) {
        return settings.env.GROQ_API_KEY
      }
    }
  } catch { /* ignore */ }

  return undefined
}

/**
 * Connect to Groq Whisper STT as a stream-like connection.
 *
 * `send(chunk)` buffers audio PCM data. `finalize()` sends the full buffer
 * to the Groq API, trying whisper-large-v3 first, falling back to
 * whisper-large-v3-turbo on rate-limit.
 */
export function connectGroqStream(
  callbacks: VoiceStreamCallbacks,
  options: GroqSttOptions,
): Promise<VoiceStreamConnection | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let finalized = false

    const connection: VoiceStreamConnection = {
      send(chunk: Buffer) {
        if (finalized) return
        chunks.push(Buffer.from(chunk))
      },

      async finalize(): Promise<FinalizeSource> {
        if (finalized) return 'ws_already_closed'
        finalized = true

        if (chunks.length === 0) {
          callbacks.onClose()
          return 'no_data_timeout'
        }

        const audioBuf = Buffer.concat(chunks)

        try {
          // Resolve API key
          const apiKey = resolveGroqApiKey(options.apiKey)
          if (!apiKey) {
            throw new Error(
              'Groq API key not found. Set GROQ_API_KEY env var or add "groqApiKey" to ~/.claude/settings.json env block.',
            )
          }

          const client = new Groq({ apiKey })

          // Convert raw PCM to WAV buffer
          const wavBuf = pcmToWav(audioBuf, 16000)
          const wavFile = new File([wavBuf], 'audio.wav', { type: 'audio/wav' })

          // Try whisper-large-v3 first, fallback to -turbo on 429
          const preferredModel = options.model || MODELS[0]
          const modelsToTry = preferredModel === MODELS[1]
            ? [MODELS[1]]
            : [preferredModel, MODELS[1]]

          let lastError: Error | null = null

          for (const model of modelsToTry) {
            try {
              const transcription = await client.audio.transcriptions.create({
                file: wavFile,
                model,
                temperature: 0,
                response_format: 'verbose_json',
                ...(options.language ? { language: options.language } : {}),
              })

              if (transcription.text) {
                callbacks.onTranscript(transcription.text, true)
              } else {
                callbacks.onTranscript('', true)
              }

              lastError = null
              break // success
            } catch (err: any) {
              lastError = err
              // Only retry on rate-limit (429) or server errors
              if (err.status === 429 || err.status >= 500) {
                console.warn(`[GroqSTT] model ${model} failed (${err.status}), trying next...`)
                continue
              }
              // Other errors are fatal — don't retry
              throw err
            }
          }

          if (lastError) throw lastError
        } catch (err) {
          callbacks.onError(
            `Groq STT error: ${err instanceof Error ? err.message : String(err)}`,
            { fatal: true },
          )
        } finally {
          callbacks.onClose()
        }

        return 'post_closestream_endpoint'
      },

      close() {
        finalized = true
        callbacks.onClose()
      },

      isConnected() {
        return true
      },
    }

    callbacks.onReady(connection)
    resolve(connection)
  })
}

/**
 * Check if a Groq API key is available somewhere.
 */
export function isGroqAvailable(explicitKey?: string): boolean {
  return !!resolveGroqApiKey(explicitKey)
}

/**
 * Convert 16-bit mono PCM data (16000 Hz) to a WAV buffer.
 */
function pcmToWav(pcmData: Buffer, sampleRate: number): Buffer {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = pcmData.length

  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  return Buffer.concat([header, pcmData])
}
