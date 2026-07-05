// Provider abstraction for Codev voice mode.
//
// Two interfaces:
// - `TranscriptionProvider` — speech → text
// - `TTSProvider` — text → audio
//
// Built-in concrete providers:
// - `LocalWhisperSTT` — subprocess wrapper around a local whisper.cpp / faster-whisper CLI
// - `DoubaoSTTProvider` — wraps `src/services/doubaoSTT.ts`
// - `EdgeTTSProvider` — subprocess wrapper around `edge-tts` CLI
// - `CommandTTSProvider` — generic shell command with `{input}` / `{input_path}` / `{output_path}` placeholders

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Public contracts
// ---------------------------------------------------------------------------

export type TranscriptionResult = {
  success: boolean
  text: string
  error?: string
}

export interface TranscriptionProvider {
  name: string
  transcribe(wavPath: string, language?: string): Promise<TranscriptionResult>
}

export type SynthesisResult = {
  audioPath?: string
  error?: string
}

export interface TTSProvider {
  name: string
  synthesize(text: string): Promise<SynthesisResult>
}

// ---------------------------------------------------------------------------
// Local whisper STT
// ---------------------------------------------------------------------------

export type LocalWhisperSTTOptions = {
  binary?: string
  model?: string
  language?: string
  args?: string[]
}

export class LocalWhisperSTT implements TranscriptionProvider {
  readonly name = 'local-whisper'

  constructor(private readonly opts: LocalWhisperSTTOptions = {}) {}

  async transcribe(wavPath: string, language?: string): Promise<TranscriptionResult> {
    const binary = this.resolveBinary()
    if (!binary) {
      return { success: false, text: '', error: 'no whisper binary found' }
    }
    const outDir = await this.makeTmpDir('vc-whisper-out')
    const lang = this.opts.language ?? language ?? 'auto'
    const args = [
      ...(this.opts.args ?? []),
      ...(this.opts.model ? ['-m', this.opts.model] : []),
      '-l',
      lang,
      '--output_format',
      'txt',
      '--output_dir',
      outDir,
      wavPath,
    ]
    try {
      await this.exec(binary, args)
      const base = path.basename(wavPath, path.extname(wavPath)) + '.txt'
      const txtPath = path.join(outDir, base)
      if (!existsSync(txtPath)) {
        return { success: false, text: '', error: 'whisper produced no txt output' }
      }
      const text = await os.domain?.(txtPath) ?? (await import('node:fs')).promises.readFile(txtPath, 'utf8')
      return { success: true, text: String(text).trim() }
    } catch (e: any) {
      return { success: false, text: '', error: e?.message ?? String(e) }
    }
  }

  private resolveBinary(): string | undefined {
    if (this.opts.binary && existsSync(this.opts.binary)) return this.opts.binary
    const candidates = [
      'whisper.cpp',
      'whisper-cpp',
      'whisper',
      'main',
      path.join(os.homedir(), '.local', 'bin', 'whisper.cpp'),
      '/opt/homebrew/bin/whisper.cpp',
      '/usr/local/bin/whisper.cpp',
    ]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
    return undefined
  }

  private async exec(cmd: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { shell: false })
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`exit ${code}: ${stderr.slice(0, 200)}`))
      })
      child.on('error', (err) => reject(err))
    })
  }

  private async makeTmpDir(prefix: string): Promise<string> {
    const dir = path.join(os.tmpdir(), `codev-${prefix}-${process.pid}-${Date.now()}`)
    await new Promise<void>((resolve) => {
      const w = spawn('mkdir', ['-p', dir])
      w.on('close', (code) => (code === 0 ? resolve() : resolve()))
    })
    return dir
  }
}

// ---------------------------------------------------------------------------
// Doubao STT
// ---------------------------------------------------------------------------

export class DoubaoSTTProvider implements TranscriptionProvider {
  readonly name = 'doubao'

  async transcribe(wavPath: string, language?: string): Promise<TranscriptionResult> {
    try {
      const { connectDoubaoStream, normalizeLanguageForSTT } = await import('./doubaoSTT.js')
      const normalized = normalizeLanguageForSTT(language)
      const code = normalized.code
      const chunks: Buffer[] = []
      const conn = await connectDoubaoStream(
        {
          onTranscript: (text: string) => {
            if (text) chunks.push(Buffer.from(text, 'utf8'))
          },
          onError: (msg: string) => {
            throw new Error(msg)
          },
          onClose: () => {},
          onReady: (c) => {
            const buf = Buffer.from(await (async () => (await import('node:fs')).promises.readFile(wavPath))())
            c.send(buf)
            void c.finalize().then(() => c.close())
          },
        },
        { language: code === 'en' ? undefined : code },
      )
      if (!conn) throw new Error('doubao connectDoubaoStream returned null')
      await new Promise((resolve) => setTimeout(resolve, 500))
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return { success: false, text: '', error: 'empty transcript' }
      return { success: true, text }
    } catch (e: any) {
      return { success: false, text: '', error: e?.message ?? String(e) }
    }
  }
}

// ---------------------------------------------------------------------------
// Edge TTS
// ---------------------------------------------------------------------------

export class EdgeTTSProvider implements TTSProvider {
  readonly name = 'edge-tts'

  constructor(private readonly voice?: string) {}

  async synthesize(text: string): Promise<SynthesisResult> {
    const trimmed = text.trim()
    if (!trimmed) return { error: 'empty text' }
    const outPath = path.join(os.homedir(), '.claude', 'voice', `tts_${Date.now()}.mp3`)
    await new Promise((resolve) => {
      const w = spawn('mkdir', ['-p', path.dirname(outPath)])
      w.on('close', () => resolve(undefined))
    })
    const selectedVoice = this.voice ?? 'en-US-AriaNeural'
    const inputPath = await this.writeTempText(trimmed)
    try {
      const args = [
        '--voice',
        selectedVoice,
        '--text',
        trimmed,
        '--write-media',
        outPath,
      ]
      await this.exec('edge-tts', args)
      if (!existsSync(outPath)) {
        return { error: 'edge-tts produced no output file' }
      }
      return { audioPath: outPath }
    } catch (e: any) {
      return { error: e?.message ?? String(e) }
    } finally {
      try {
        await (await import('node:fs')).promises.unlink(inputPath)
      } catch {
        // ignore
      }
    }
  }

  private async exec(cmd: string, args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { shell: false })
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`exit ${code}: ${stderr.slice(0, 200)}`))
      })
      child.on('error', (err) => reject(err))
    })
  }

  private async writeTempText(text: string): Promise<string> {
    const p = path.join(os.tmpdir(), `codev-edge-tts-${process.pid}-${Date.now()}.txt`)
    await (await import('node:fs')).promises.writeFile(p, text, 'utf8')
    return p
  }
}

// ---------------------------------------------------------------------------
// Command-based fallback TTS
// ---------------------------------------------------------------------------

export type CommandTTSTemplate = string

export class CommandTTSProvider implements TTSProvider {
  readonly name = 'command'

  constructor(private readonly template: CommandTTSTemplate) {}

  async synthesize(text: string): Promise<SynthesisResult> {
    const inputPath = await this.writeTempText(text)
    const outputPath = path.join(os.tmpdir(), `vesperclaw-tts-out-${Date.now()}.mp3`)
    const resolved = this.template
      .replace('{input}', inputPath)
      .replace('{input_path}', inputPath)
      .replace('{output_path}', outputPath)
    try {
      await this.exec(resolved)
      return { audioPath: outputPath }
    } catch (e: any) {
      return { error: e?.message ?? String(e) }
    } finally {
      try {
        await (await import('node:fs')).promises.unlink(inputPath)
      } catch {
        // ignore
      }
    }
  }

  private async exec(command: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`exit ${code}: ${stderr.slice(0, 200)}`))
      })
      child.on('error', (err) => reject(err))
    })
  }

  private async writeTempText(text: string): Promise<string> {
    const p = path.join(os.tmpdir(), `vesperclaw-tts-txt-${process.pid}-${Date.now()}.txt`)
    await (await import('node:fs')).promises.writeFile(p, text, 'utf8')
    return p
  }
}
