import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SCRIPTS_DIR = join(import.meta.dirname, '..', '..', '..', 'scripts')

function resolvePythonPath(customPath?: string): string {
  if (customPath) return customPath
  const venvPython = join(import.meta.dirname, '..', '..', '..', '.venv', 'bin', 'python')
  return existsSync(venvPython) ? venvPython : 'python3'
}

export type TTSResult = {
  success: boolean
  audioPath?: string
  error?: string
}

export type TTSSpeakOptions = {
  voice?: string
  outputPath?: string
  pythonPath?: string
}

/**
 * Text-to-speech using edge-tts (Microsoft Edge Neural Voice).
 * Spawns a Python subprocess to run edge-tts and save the audio file.
 *
 * Requirements: pip install edge-tts
 */
export async function speakWithEdgeTTS(
  text: string,
  options?: TTSSpeakOptions,
): Promise<TTSResult> {
  const python = resolvePythonPath(options?.pythonPath)
  const voice = options?.voice ?? 'en-US-JennyNeural'
  const script = join(SCRIPTS_DIR, 'speak.py')

  return new Promise(resolve => {
    const args = [script, text, '--voice', voice]
    if (options?.outputPath) {
      args.push('--output', options.outputPath)
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

    proc.on('close', exitCode => {
      if (exitCode !== 0) {
        resolve({
          success: false,
          error: `edge-tts failed: ${stderr || 'unknown error'}`,
        })
        return
      }

      try {
        const result = JSON.parse(stdout)
        resolve(result)
      } catch {
        resolve({
          success: false,
          error: `Failed to parse edge-tts output: ${stdout.slice(0, 200)}`,
        })
      }
    })

    proc.on('error', err => {
      resolve({
        success: false,
        error: `Failed to spawn edge-tts: ${err.message}`,
      })
    })
  })
}

/** Check if edge-tts is available. */
export async function checkEdgeTTSAvailable(pythonPath?: string): Promise<boolean> {
  const python = resolvePythonPath(pythonPath)
  return new Promise(resolve => {
    const proc = spawn(python, [
      '-c',
      'import json;' +
      'try: import edge_tts; print(json.dumps({"ok": True}))' +
      'except ImportError: print(json.dumps({"ok": False}))',
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

/** Play an audio file using system player. */
export function playAudioFile(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform
    let cmd: string
    let args: string[]

    if (platform === 'darwin') {
      cmd = 'afplay'
      args = [path]
    } else if (platform === 'linux') {
      cmd = 'ffplay'
      args = ['-nodisp', '-autoexit', path]
    } else if (platform === 'win32') {
      cmd = 'start'
      args = [path]
    } else {
      reject(new Error(`Unsupported platform: ${platform}`))
      return
    }

    const proc = spawn(cmd, args, { stdio: 'ignore' })
    proc.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`Playback exited with code ${code}`))
    })
    proc.on('error', reject)
  })
}