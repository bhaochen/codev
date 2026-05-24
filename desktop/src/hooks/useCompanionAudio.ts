import { useRef, useCallback, useEffect } from 'react'

/** PCM Int16 → WAV Blob */
function pcmChunksToWav(chunks: Int16Array[]): Blob {
  if (chunks.length === 0) {
    // Return valid empty WAV
    const empty = new ArrayBuffer(44)
    const v = new DataView(empty)
    const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
    w(0, 'RIFF'); v.setUint32(4, 36, true); w(8, 'WAVE')
    w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
    v.setUint16(22, 1, true); v.setUint32(24, 24000, true); v.setUint32(28, 48000, true)
    v.setUint16(32, 2, true); v.setUint16(34, 16, true)
    w(36, 'data'); v.setUint32(40, 0, true)
    return new Blob([empty], { type: 'audio/wav' })
  }

  const totalSamples = chunks.reduce((s, c) => s + c.length, 0)
  const sampleRate = 24000
  const bitsPerSample = 16
  const numChannels = 1
  const blockAlign = (numChannels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = totalSamples * blockAlign
  const totalSize = 44 + dataSize

  const buf = new ArrayBuffer(totalSize)
  const v = new DataView(buf)
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }

  w(0, 'RIFF'); v.setUint32(4, totalSize - 8, true); w(8, 'WAVE')
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true)
  v.setUint16(22, numChannels, true); v.setUint32(24, sampleRate, true)
  v.setUint32(28, byteRate, true); v.setUint16(32, blockAlign, true)
  v.setUint16(34, bitsPerSample, true)
  w(36, 'data'); v.setUint32(40, dataSize, true)

  const pcmView = new Int16Array(buf, 44, totalSamples)
  let offset = 0
  for (const chunk of chunks) {
    pcmView.set(chunk, offset)
    offset += chunk.length
  }
  return new Blob([buf], { type: 'audio/wav' })
}

export function useCompanionAudio() {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const urlRef = useRef<string | null>(null)

  // Accumulation buffer — all PCM chunks are poured here until flush()
  const chunksRef = useRef<Int16Array[]>([])
  const chunksLenRef = useRef(0) // track total sample count for quick lookup

  const revokeUrl = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [])

  const playWav = useCallback(
    (blob: Blob) => {
      const audio = audioRef.current
      if (!audio) return
      revokeUrl()
      const url = URL.createObjectURL(blob)
      urlRef.current = url
      audio.src = url
      audio.play().catch(() => {})
    },
    [revokeUrl],
  )

  // Set up the <audio> element
  useEffect(() => {
    const audio = new Audio()
    audioRef.current = audio
    audio.style.display = 'none'
    document.body.appendChild(audio)

    return () => {
      audio.pause()
      revokeUrl()
      audio.src = ''
      if (audio.parentNode) {
        audio.parentNode.removeChild(audio)
      }
      audioRef.current = null
      chunksRef.current = []
      chunksLenRef.current = 0
    }
  }, [revokeUrl])

  const enqueueAudio = useCallback((pcmData: ArrayBuffer) => {
    const chunk = new Int16Array(pcmData)
    if (chunk.length === 0) return
    chunksRef.current.push(chunk)
    chunksLenRef.current += chunk.length
  }, [])

  const flush = useCallback(() => {
    if (chunksLenRef.current === 0) return
    const wav = pcmChunksToWav(chunksRef.current)
    chunksRef.current = []
    chunksLenRef.current = 0
    playWav(wav)
  }, [playWav])

  const stopPlayback = useCallback(() => {
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      revokeUrl()
      audio.src = ''
    }
    chunksRef.current = []
    chunksLenRef.current = 0
  }, [revokeUrl])

  const resume = useCallback(() => {
    // Unlock audio by playing a minimal silent WAV
    const silent = new Int16Array(1)
    silent[0] = 0
    const wav = pcmChunksToWav([silent])
    playWav(wav)
  }, [playWav])

  return {
    enqueueAudio,
    flush,
    stopPlayback,
    resume,
  }
}
