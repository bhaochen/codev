import { spawn } from 'child_process'
import { existsSync, mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import type { VoiceStreamCallbacks, VoiceStreamConnection, FinalizeSource } from '../voiceStreamSTT.js'

function findProjectRoot(): string {
  let dir = process.cwd()
  for (let i = 0; i < 20; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'scripts'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

const PROJECT_ROOT = findProjectRoot()
const SCRIPTS_DIR = join(PROJECT_ROOT, 'scripts')
const VENV_PYTHON = join(PROJECT_ROOT, '.venv', 'bin', 'python')

const LOG = '/tmp/vc_whisper.log'
function log(...args: unknown[]) {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`
  try { writeFileSync(LOG, line, { flag: 'a' }) } catch {}
}

function resolvePythonPath(customPath?: string): string {
  if (customPath) return customPath
  if (existsSync(VENV_PYTHON)) return VENV_PYTHON
  return 'python3'
}

type WhisperOptions = {
  model?: string
  language?: string
  pythonPath?: string
}

export function connectLocalWhisperStream(
  callbacks: VoiceStreamCallbacks,
  options?: WhisperOptions,
): Promise<VoiceStreamConnection | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = []
    let finalized = false
    let tmpDir: string | null = null

    const python = resolvePythonPath(options?.pythonPath)
    const model = options?.model ?? 'large-v3-turbo'
    const language = options?.language
    log('projectRoot', PROJECT_ROOT, 'python', python, 'model', model, 'language', language)

    const connection: VoiceStreamConnection = {
      send(chunk: Buffer) {
        if (finalized) return
        chunks.push(Buffer.from(chunk))
        if (chunks.length === 1) log('first chunk', chunk.length, 'bytes')
      },

      async finalize(): Promise<FinalizeSource> {
        if (finalized) return 'ws_already_closed'
        finalized = true
        log('finalize called, chunks', chunks.length)

        if (chunks.length === 0) {
          log('no chunks, returning no_data_timeout')
          callbacks.onClose()
          return 'no_data_timeout'
        }

        const audioBuf = Buffer.concat(chunks)
        log('total audio', audioBuf.length, 'bytes')

        try {
          tmpDir = mkdtempSync(join(tmpdir(), 'vc-whisper-'))
          const wavPath = join(tmpDir, 'input.wav')

          writeWavHeader(wavPath, audioBuf, 16000)

          const args = [join(SCRIPTS_DIR, 'transcribe.py'), wavPath, '--model', model]
          if (language) {
            args.push('--language', language)
          }
          log('spawning', python, args.join(' '))

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

          log('exitCode', exitCode, 'stdout', stdout.slice(0, 500), 'stderr', stderr.slice(0, 500))

          if (exitCode !== 0) {
            callbacks.onError(`Whisper transcription failed: ${stderr || 'unknown error'}`, {
              fatal: true,
            })
            callbacks.onClose()
            return 'ws_close'
          }

          const result = JSON.parse(stdout)
          log('result', result)
          if (result.success && result.text) {
            callbacks.onTranscript(result.text, true)
          } else if (result.success && !result.text) {
            callbacks.onTranscript('', true)
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
            } catch {}
            try {
              rmdirSync(tmpDir)
            } catch {}
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

export async function checkLocalWhisperAvailable(pythonPath?: string): Promise<boolean> {
  const python = resolvePythonPath(pythonPath)
  return new Promise(resolve => {
    const proc = spawn(python, [
      '-c',
      'import json;' +
      'try: import whisper; print(json.dumps({"ok": True, "backend": "whisper"}))' +
      'except ImportError:' +
      '  try: from faster_whisper import WhisperModel; print(json.dumps({"ok": True, "backend": "faster-whisper"}))' +
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

function writeWavHeader(path: string, pcmData: Buffer, sampleRate: number): void {
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

  writeFileSync(path, Buffer.concat([header, pcmData]))
}