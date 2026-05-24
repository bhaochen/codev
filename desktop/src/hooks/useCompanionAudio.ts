import { useRef, useCallback, useEffect } from 'react'

function pcmToWav(pcm: ArrayBuffer): Blob {
  const int16 = new Int16Array(pcm)
  const numSamples = int16.length
  const sampleRate = 24000
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8
  const blockAlign = (numChannels * bitsPerSample) / 8
  const dataSize = numSamples * blockAlign
  const headerSize = 44
  const totalSize = headerSize + dataSize

  const buf = new ArrayBuffer(totalSize)
  const view = new DataView(buf)

  const w = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i))
  }

  w(0, 'RIFF')
  view.setUint32(4, totalSize - 8, true)
  w(8, 'WAVE')
  w(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  w(36, 'data')
  view.setUint32(40, dataSize, true)

  new Int16Array(buf, headerSize, numSamples).set(int16)
  return new Blob([buf], { type: 'audio/wav' })
}

export function useCompanionAudio() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const queueRef = useRef<Blob[]>([])
  const playingRef = useRef(false)
  const urlRef = useRef<string | null>(null)

  const revokeUrl = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [])

  const playNext = useCallback(() => {
    if (playingRef.current) return
    const queue = queueRef.current
    if (queue.length === 0) return

    const blob = queue.shift()!
    const url = URL.createObjectURL(blob)
    const audio = audioRef.current
    if (!audio) return

    revokeUrl()
    urlRef.current = url
    audio.src = url
    audio.play().then(() => {
      playingRef.current = true
    }).catch(() => {
      playingRef.current = false
      revokeUrl()
      playNext()
    })
  }, [revokeUrl])

  useEffect(() => {
    const audio = new Audio()
    audioRef.current = audio
    audio.style.display = 'none'
    document.body.appendChild(audio)

    audio.onended = () => {
      playingRef.current = false
      playNext()
    }
    audio.onerror = () => {
      playingRef.current = false
      playNext()
    }

    return () => {
      audio.pause()
      revokeUrl()
      audio.src = ''
      if (audio.parentNode) {
        audio.parentNode.removeChild(audio)
      }
      audioRef.current = null
      queueRef.current = []
      playingRef.current = false
    }
  }, [revokeUrl])

  const enqueueAudio = useCallback(
    (pcmData: ArrayBuffer) => {
      const wav = pcmToWav(pcmData)
      queueRef.current.push(wav)
      if (!playingRef.current) {
        playNext()
      }
    },
    [playNext],
  )

  const stopPlayback = useCallback(() => {
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      revokeUrl()
      audio.src = ''
    }
    queueRef.current = []
    playingRef.current = false
  }, [revokeUrl])

  const resume = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return

    // Unlock audio with a silent WAV
    const silent = new Int16Array(1)
    silent[0] = 0
    const wav = pcmToWav(silent.buffer)
    const url = URL.createObjectURL(wav)
    revokeUrl()
    urlRef.current = url
    audio.src = url
    audio.play().catch(() => {})
  }, [revokeUrl])

  return {
    enqueueAudio,
    stopPlayback,
    resume,
  }
}
