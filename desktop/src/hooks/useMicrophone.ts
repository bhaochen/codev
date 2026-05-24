import { useState, useRef, useCallback, useEffect } from 'react'

export function useMicrophone(
  enabled: boolean,
  onAudioChunk: (buffer: ArrayBuffer) => void,
) {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)

  const startMic = useCallback(async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: { ideal: 16000 },
        },
      })
      streamRef.current = mediaStream
      setStream(mediaStream)
      setError(null)

      // Set up audio processing pipeline
      const audioContext = new AudioContext({ sampleRate: 16000 })
      audioContextRef.current = audioContext

      const source = audioContext.createMediaStreamSource(mediaStream)
      sourceRef.current = source

      // Use ScriptProcessorNode for PCM data access
      const bufferSize = 2048
      const processor = audioContext.createScriptProcessor(bufferSize, 1, 1)
      processorRef.current = processor

      processor.onaudioprocess = (event) => {
        const inputData = event.inputBuffer.getChannelData(0) // Float32
        // Convert Float32 to Int16 PCM
        const int16 = new Int16Array(inputData.length)
        for (let i = 0; i < inputData.length; i++) {
          const sample = inputData[i] ?? 0
          const s = Math.max(-1, Math.min(1, sample))
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
        }
        onAudioChunk(int16.buffer)
      }

      source.connect(processor)
      processor.connect(audioContext.destination)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(`Microphone access denied: ${message}`)
    }
  }, [onAudioChunk])

  const stopMic = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect()
      processorRef.current = null
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect()
      sourceRef.current = null
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close()
      audioContextRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    setStream(null)
  }, [])

  useEffect(() => {
    if (enabled) {
      void startMic()
    } else {
      stopMic()
    }
    return () => {
      stopMic()
    }
  }, [enabled, startMic, stopMic])

  return {
    stream,
    error,
    startMic,
    stopMic,
  }
}
