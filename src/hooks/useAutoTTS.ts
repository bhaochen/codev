import { useEffect, useRef } from 'react'
import { speakWithEdgeTTS, playAudioFile } from '../services/voice/edgeTTS.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import type { RenderableMessage } from '../types/message.js'

// Map language codes to Edge TTS Chinese voices
const CHINESE_VOICES: Record<string, string> = {
  zh: 'zh-CN-XiaoxiaoNeural',
  'zh-CN': 'zh-CN-XiaoxiaoNeural',
  'zh-TW': 'zh-TW-HsiaoChenNeural',
  'zh-HK': 'zh-HK-HiuMaanNeural',
}

function resolveEdgeTTSVoice(language: string | undefined, explicitVoice: string | undefined): string {
  if (explicitVoice) return explicitVoice
  if (!language) return 'en-US-JennyNeural'
  const base = language.split('-')[0].toLowerCase()
  if (base === 'zh') return CHINESE_VOICES[language] || CHINESE_VOICES['zh-CN']
  if (base === 'ja') return 'ja-JP-NanamiNeural'
  if (base === 'ko') return 'ko-KR-SunHiNeural'
  if (base === 'fr') return 'fr-FR-DeniseNeural'
  if (base === 'de') return 'de-DE-KatjaNeural'
  if (base === 'es') return 'es-ES-ElviraNeural'
  return 'en-US-JennyNeural'
}

export function useAutoTTS(messages: RenderableMessage[], isLoading?: boolean): void {
  const triggeredIdsRef = useRef<Set<string>>(new Set())
  const pendingPlayRef = useRef<Promise<void> | null>(null)

  // Snapshot of message IDs present when the conversation first becomes "active".
  // isLoading goes true on the first user submit and stays false on resume.
  // By waiting for isLoading=true we ensure the snapshot captures the correct
  // boundary: everything before it is history (skip), everything after is new.
  const historyIdsRef = useRef<Set<string> | null>(null)
  const wasLoadingRef = useRef<boolean>(false)

  useEffect(() => {
    const settings = getInitialSettings()
    if (!settings.voiceAutoTTS || !settings.voiceEnabled) return

    // Capture history snapshot on the transition from idle → active.
    // This fires once: when the user first submits a message in a fresh REPL,
    // or (importantly) never during a resume where isLoading stays false.
    if (!historyIdsRef.current && !wasLoadingRef.current && isLoading) {
      historyIdsRef.current = new Set(messages.map(m => m.uuid))
    }
    wasLoadingRef.current = isLoading ?? false

    const voice = resolveEdgeTTSVoice(
      settings.voiceLanguage || settings.language,
      settings.voiceTTSVoice,
    )

    for (const msg of messages) {
      if (triggeredIdsRef.current.has(msg.uuid)) continue
      // Skip messages that were present before the conversation became active.
      if (historyIdsRef.current?.has(msg.uuid)) continue

      triggeredIdsRef.current.add(msg.uuid)

      if (msg.type !== 'assistant') continue
      const content = msg.message.content[0]
      if (content?.type !== 'text') continue
      if (!content.text.trim()) continue

      const text = content.text

      const run = async () => {
        const result = await speakWithEdgeTTS(text, {
          voice,
          pythonPath: settings.voiceTTSCommand || undefined,
        })
        if (result.success && result.audioPath) {
          await playAudioFile(result.audioPath)
        }
      }

      if (pendingPlayRef.current) {
        pendingPlayRef.current = pendingPlayRef.current.then(run, run).catch(() => {})
      } else {
        pendingPlayRef.current = run().catch(() => {})
      }
    }
  }, [messages, isLoading])
}