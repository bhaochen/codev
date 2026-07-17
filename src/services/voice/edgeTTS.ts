import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'node:path'

export type TTSResult = {
  success: boolean
  audioPath?: string
  error?: string
}

export type TTSSpeakOptions = {
  voice?: string
  outputPath?: string
}

/**
 * Text-to-speech using the `node-edge-tts` Node package (no Python required).
 * Synthesizes `text` to a local audio file and resolves with its path.
 */
export async function speakWithEdgeTTS(
  text: string,
  options?: TTSSpeakOptions,
): Promise<TTSResult> {
  try {
    const { EdgeTTS } = await import('node-edge-tts')
    const audioPath =
      options?.outputPath ??
      path.join(
        mkdtempSync(path.join(tmpdir(), 'codev-tts-')),
        `voice-${Date.now()}.mp3`,
      )
    const tts = new EdgeTTS({ voice: options?.voice ?? 'en-US-JennyNeural' })
    await tts.ttsPromise(text, audioPath)
    return { success: true, audioPath }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/** Check if `node-edge-tts` can be loaded. */
export async function checkEdgeTTSAvailable(): Promise<boolean> {
  try {
    await import('node-edge-tts')
    return true
  } catch {
    return false
  }
}

/**
 * Synthesize text to a temporary .mp3 using `node-edge-tts`.
 * Returns the audio file path on success.
 */
export async function edgeTts(opts: {
  text: string
  voice?: string
}): Promise<{ success: boolean; audioPath?: string; error?: string }> {
  return speakWithEdgeTTS(opts.text, { voice: opts.voice })
}

/** Play an audio file using system player. */
export function playAudioFile(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const platform = process.platform
    let cmd: string
    let args: string[]

    if (platform === 'darwin') {
      cmd = 'afplay'
      args = [filePath]
    } else if (platform === 'linux') {
      cmd = 'ffplay'
      args = ['-nodisp', '-autoexit', '-infbuf', filePath]
    } else if (platform === 'win32') {
      cmd = 'start'
      args = [filePath]
    } else {
      reject(new Error(`Unsupported platform: ${platform}`))
      return
    }

    const { spawn } = require('child_process') as typeof import('child_process')

    if (platform === 'linux') {
      const killProc = spawn('pkill', ['-9', 'ffplay'], { stdio: 'ignore' })
      killProc.on('close', () => {
        setTimeout(() => {
          const proc = spawn(cmd, args, { stdio: 'ignore' })
          proc.on('close', () => resolve())
          proc.on('error', () => resolve())
        }, 50)
      })
      killProc.on('error', () => {
        const proc = spawn(cmd, args, { stdio: 'ignore' })
        proc.on('close', () => resolve())
        proc.on('error', () => resolve())
      })
    } else {
      const proc = spawn(cmd, args, { stdio: 'ignore' })
      proc.on('close', code => {
        if (code === 0) resolve()
        else reject(new Error(`Playback exited with code ${code}`))
      })
      proc.on('error', reject)
    }
  })
}
