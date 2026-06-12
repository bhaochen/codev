import { spawn } from 'child_process'
import { appendFileSync, existsSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { VoiceStreamCallbacks, VoiceStreamConnection, FinalizeSource } from '../voiceStreamSTT.js'

const SCRIPTS_DIR = join(import.meta.dirname, '..', '..', '..', 'scripts')
const DEBUG_LOG = '/tmp/voice_debug.log'
const dbg = (...args: unknown[]) => {
  const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')
  const line = `[${new Date().toISOString()}] ${msg}\n`
  appendFileSync(DEBUG_LOG, line)
}

function resolvePythonPath(customPath?: string): string {
  if (customPath) return customPath
  const venvPython = join(import.meta.dirname, '..', '..', '..', '.venv', 'bin', 'python')
  return existsSync(venvPython) ? venvPython : 'python3'
}

type WhisperOptions = {
  model?: string
  language?: string
  pythonPath?: string
}

/**
 * A local Whisper STT provider that implements the VoiceStreamConnection
 * interface. Buffers incoming audio chunks, then on finalize() writes a
 * temporary WAV file and spawns a Python faster-whisper subprocess to
 * transcribe it.
 *
 * Requirements: pip install faster-whisper   (or openai-whisper)
 *
 * Whisper model files are cached at ~/.cache/whisper/ automatically.
 */
export function connectLocalWhisperStream(
  callbacks: VoiceStreamCallbacks,
  options?: WhisperOptions,
): Promise<VoiceStreamConnection | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let finalized = false
    let tmpDir: string | null = null

    const python = resolvePythonPath(options?.pythonPath)
    const model = options?.model ?? 'base'
    const language = options?.language

    dbg('whisperSTT', 'python', python, 'model', model, 'language', language)

    const connection: VoiceStreamConnection = {
      send(chunk: Buffer) {
        if (finalized) return
        chunks.push(Buffer.from(chunk))
        if (chunks.length === 1) {
          dbg('whisperSTT', 'first chunk', chunk.length, 'bytes')
        }
      },

      async finalize(): Promise<FinalizeSource> {
        if (finalized) return 'ws_already_closed'
        finalized = true

        dbg('whisperSTT', 'finalize called, chunks', chunks.length)

        if (chunks.length === 0) {
          dbg('whisperSTT', 'no audio chunks, returning no_data_timeout')
          callbacks.onClose()
          return 'no_data_timeout'
        }

        const audioBuf = Buffer.concat(chunks)
        dbg('whisperSTT', 'total audio size', audioBuf.length, 'bytes')

        try {
          tmpDir = mkdtempSync(join(tmpdir(), 'vc-whisper-'))
          const wavPath = join(tmpDir, 'input.wav')

          writeWavHeader(wavPath, audioBuf, 16000)

          const args = [join(SCRIPTS_DIR, 'transcribe.py'), wavPath, '--model', model]
          if (language) {
            args.push('--language', language)
          }

          const proc = spawn(python, args, { stdio: ['ignore', 'pipe', 'pipe'] })

          let stdout = ''
          let stderr = ''

          proc.stdout.on('data', (data: Buffer) => {
            stdout += data.toString()
          })

          proc.stderr.on('data', (data: Buffer) => {
            stderr += data.toString()
          })

          const exitCode = await new Promise<number>(resolveExit => {
            proc.on('close', resolveExit)
          })

          dbg('whisperSTT', 'subprocess exitCode', exitCode, 'stdout', stdout.slice(0, 200))
          if (exitCode !== 0) {
            callbacks.onError(`Whisper transcription failed: ${stderr || 'unknown error'}`, {
              fatal: true,
            })
            callbacks.onClose()
            return 'ws_close'
          }

          const result = JSON.parse(stdout)
          if (result.success) {
            callbacks.onTranscript(result.text, true)
          } else {
            callbacks.onError(
              result.error ?? 'Transcription failed',
              { fatal: true },
            )
          }
        } catch (err) {
          callbacks.onError(
            `Whisper error: ${err instanceof Error ? err.message : String(err)}`,
            { fatal: true },
          )
        } finally {
          if (tmpDir) {
            try {
              unlinkSync(join(tmpDir, 'input.wav'))
            } catch {
              // ignore
            }
            try {
              rmdirSync(tmpDir)
            } catch {
              // ignore
            }
          }
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

/** Check if a local whisper-capable Python installation exists. */
export async function checkLocalWhisperAvailable(pythonPath?: string): Promise<boolean> {
  const python = resolvePythonPath(pythonPath)
  return new Promise(resolve => {
    const proc = spawn(python, [
      '-c',
      'import json;' +
      'try: from faster_whisper import WhisperModel; print(json.dumps({"ok": True, "backend": "faster-whisper"}))' +
      'except ImportError:' +
      '  try: import whisper; print(json.dumps({"ok": True, "backend": "whisper"}))' +
      '  except ImportError: print(json.dumps({"ok": False}))',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    proc.stdout.on('data', (data: Buffer) => { stdout += data.toString() })
    proc.on('close', () => {
      try {
        const result = JSON.parse(stdout)
        resolve(result.ok === true)
      } catch {
        resolve(false)
      }
    })
  })
}

/** Write a valid PCM WAV file header and data. */
function writeWavHeader(path: string, pcmData: Buffer, sampleRate: number): void {
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = pcmData.length

  const header = Buffer.alloc(44)

  // RIFF header
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)

  // fmt chunk
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // chunk size
  header.writeUInt16LE(1, 20)  // PCM format
  header.writeUInt16LE(numChannels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bitsPerSample, 34)

  // data chunk
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)

  writeFileSync(path, Buffer.concat([header, pcmData]))
}