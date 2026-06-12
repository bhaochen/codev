import { useEffect, useRef } from 'react'
import { speakWithEdgeTTS, playAudioFile } from '../services/voice/edgeTTS.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import type { RenderableMessage } from '../types/message.js'

export function useAutoTTS(messages: RenderableMessage[]): void {
  const triggeredIdsRef = useRef<Set<string>>(new Set())
  const pendingPlayRef = useRef<Promise<void> | null>(null)

  useEffect(() => {
    const settings = getInitialSettings()
    if (!settings.voiceAutoTTS || !settings.voiceEnabled) return

    for (const msg of messages) {
      if (msg.type !== 'assistant') continue
      if (triggeredIdsRef.current.has(msg.id)) continue

      const content = msg.message.content[0]
      if (content?.type !== 'text') continue
      if (!content.text.trim()) continue

      triggeredIdsRef.current.add(msg.id)

      const text = content.text
      const voice = settings.voiceTTSVoice || 'en-US-JennyNeural'

      void (async () => {
        const result = await speakWithEdgeTTS(text, {
          voice,
          pythonPath: settings.voiceTTSCommand || undefined,
        })
        if (result.success && result.audioPath) {
          await playAudioFile(result.audioPath)
        }
      })()
    }
  }, [messages])
}