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

export function useAutoTTS(messages: RenderableMessage[]): void {
  const triggeredIdsRef = useRef<Set<string>>(new Set())
  const pendingPlayRef = useRef<Promise<void> | null>(null)

  useEffect(() => {
    const settings = getInitialSettings()
    if (!settings.voiceAutoTTS || !settings.voiceEnabled) return

    for (const msg of messages) {
      if (msg.type !== 'assistant') continue
      if (triggeredIdsRef.current.has(msg.uuid)) continue

      const content = msg.message.content[0]
      if (content?.type !== 'text') continue
      if (!content.text.trim()) continue

      triggeredIdsRef.current.add(msg.uuid)

      const text = content.text
      const language = settings.voiceLanguage || settings.language
      const voice = resolveEdgeTTSVoice(language, settings.voiceTTSVoice)

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
  }, [messages])
}