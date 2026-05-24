import { useState, useRef, useCallback, useEffect } from 'react'

export function useWebcam(enabled: boolean) {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const startCamera = useCallback(async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: 'user',
        },
      })
      streamRef.current = mediaStream
      setStream(mediaStream)
      setError(null)

      // Create hidden video and canvas elements for frame capture
      const video = document.createElement('video')
      video.srcObject = mediaStream
      video.playsInline = true
      video.muted = true
      video.autoplay = true
      videoRef.current = video

      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      canvasRef.current = canvas

      await video.play()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(`Camera access denied: ${message}`)
    }
  }, [])

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    videoRef.current = null
    canvasRef.current = null
    setStream(null)
  }, [])

  const captureFrame = useCallback(async (): Promise<string | null> => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || video.readyState < 2) return null

    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    ctx.drawImage(video, 0, 0, 256, 256)

    return new Promise((resolve) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(null)
            return
          }
          const reader = new FileReader()
          reader.onloadend = () => {
            const result = reader.result as string
            // Remove data:image/jpeg;base64, prefix
            resolve(result.split(',')[1] ?? null)
          }
          reader.onerror = () => resolve(null)
          reader.readAsDataURL(blob)
        },
        'image/jpeg',
        0.7,
      )
    })
  }, [])

  useEffect(() => {
    if (enabled) {
      void startCamera()
    } else {
      stopCamera()
    }
    return () => {
      stopCamera()
    }
  }, [enabled, startCamera, stopCamera])

  return {
    stream,
    error,
    captureFrame,
    startCamera,
    stopCamera,
  }
}
