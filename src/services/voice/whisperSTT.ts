import { spawn, type ChildProcess } from 'child_process'
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

function resolvePythonPath(): string {
  if (existsSync(VENV_PYTHON)) return VENV_PYTHON
  return 'python3'
}

type WhisperOptions = {
  model?: string
  language?: string
  pythonPath?: string
}

let serverProc: ChildProcess | null = null
let serverLoaded = false
let serverLoadingResolve: (() => void) | null = null
let serverLoadingReject: ((err: Error) => void) | null = null

function getServer(): ChildProcess {
  if (serverProc && serverProc.exitCode === null) {
    return serverProc
  }
  const python = resolvePythonPath()
  serverProc = spawn(python, [join(SCRIPTS_DIR, 'whisper_server.py')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let buf = ''
  serverProc.stdout!.on('data', (data: Buffer) => {
    buf += data.toString()
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      if (!line) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'ready') {
          serverLoaded = true
          serverLoadingResolve?.()
          serverLoadingResolve = null
          serverLoadingReject = null
        } else if (msg.type === 'error') {
          serverLoaded = false
          serverLoadingReject?.(new Error(msg.message))
          serverLoadingResolve = null
          serverLoadingReject = null
        }
      } catch {}
    }
  })

  serverProc.on('error', () => {
    serverProc = null
    serverLoaded = false
    serverLoadingReject?.(new Error('Server process error'))
  })
  serverProc.on('close', () => {
    serverProc = null
    serverLoaded = false
  })

  return serverProc
}

export async function preloadWhisperModel(options?: WhisperOptions): Promise<void> {
  if (serverLoaded) return

  const proc = getServer()
  const model = options?.model ?? 'small'

  const responseReady = new Promise<void>((resolve, reject) => {
    serverLoadingResolve = resolve
    serverLoadingReject = reject
    proc.stdin!.write(JSON.stringify({ type: 'load', model }) + '\n')
  })

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error('Model preload timeout')), 30000)
  })

  await Promise.race([responseReady, timeout])
}

async function transcribeWithServer(
  wavPath: string,
  language?: string | null,
): Promise<{ text: string; language: string }> {
  const proc = getServer()

  const result = await new Promise<{ text: string; language: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Transcription timeout'))
    }, 30000)

    let buf = ''
    const cleanup = () => {
      clearTimeout(timeout)
      proc.stdout!.removeAllListeners('data')
    }

    proc.stdout!.on('data', (data: Buffer) => {
      buf += data.toString()
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.type === 'result') {
            cleanup()
            resolve({ text: msg.text, language: msg.language })
          } else if (msg.type === 'error') {
            cleanup()
            reject(new Error(msg.message))
          }
        } catch {}
      }
    })

    proc.stdin!.write(JSON.stringify({ type: 'transcribe', wav: wavPath, language }) + '\n')
  })

  return result
}

export function connectLocalWhisperStream(
  callbacks: VoiceStreamCallbacks,
  options?: WhisperOptions,
): Promise<VoiceStreamConnection | null> {
  return new Promise(async resolve => {
    if (!serverLoaded) {
      await preloadWhisperModel(options)
    }

    const chunks: Buffer[] = []
    let finalized = false
    let tmpDir: string | null = null

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
          tmpDir = mkdtempSync(join(tmpdir(), 'vc-whisper-'))
          const wavPath = join(tmpDir, 'input.wav')
          writeWavHeader(wavPath, audioBuf, 16000)

          const result = await transcribeWithServer(wavPath, options?.language)
          if (result.text) {
            callbacks.onTranscript(result.text, true)
          } else {
            callbacks.onTranscript('', true)
          }
        } catch (err) {
          callbacks.onError(
            `Whisper error: ${err instanceof Error ? err.message : String(err)}`,
            { fatal: true },
          )
        } finally {
          if (tmpDir) {
            try { unlinkSync(join(tmpDir, 'input.wav')) } catch {}
            try { rmdirSync(tmpDir) } catch {}
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

/**
 * Fast check for local whisper availability using `find_spec` (no actual
 * module import, avoiding the slow PyTorch/numpy import chain).
 */
export async function checkLocalWhisperAvailable(): Promise<boolean> {
  try {
    const python = resolvePythonPath()
    return await new Promise(resolve => {
      const proc = spawn(
        python,
        [
          '-c',
          'import importlib.util,sys; sys.exit(0 if importlib.util.find_spec("whisper") else 1)',
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      proc.on('close', code => resolve(code === 0))
    })
  } catch {
    return false
  }
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