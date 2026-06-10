import { useState, useRef, useCallback } from 'react'

export function useScreenShare() {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [isSharing, setIsSharing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const startScreenShare = useCallback(async () => {
    try {
      const mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      })

      streamRef.current = mediaStream
      setStream(mediaStream)
      setIsSharing(true)
      setError(null)

      // Create hidden video + canvas for frame capture
      const video = document.createElement('video')
      video.srcObject = mediaStream
      video.playsInline = true
      video.muted = true
      video.autoplay = true
      videoRef.current = video

      const canvas = document.createElement('canvas')
      canvas.width = 640
      canvas.height = 480
      canvasRef.current = canvas

      await video.play()

      // When user stops sharing via the browser's built-in "Stop sharing" button
      mediaStream.getVideoTracks()[0]?.addEventListener('ended', () => {
        stopScreenShare()
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // User cancelled the permission dialog
      if (message.includes('cancelled') || message.includes('Permission denied')) {
        setError(null)
        return
      }
      setError(`Screen share failed: ${message}`)
    }
  }, [])

  const stopScreenShare = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
    videoRef.current = null
    canvasRef.current = null
    setStream(null)
    setIsSharing(false)
  }, [])

  const captureFrame = useCallback(async (): Promise<string | null> => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas || video.readyState < 2) return null

    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    // Maintain aspect ratio while fitting to canvas
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw === 0 || vh === 0) return null

    const scale = Math.min(canvas.width / vw, canvas.height / vh)
    const dw = vw * scale
    const dh = vh * scale
    const dx = (canvas.width - dw) / 2
    const dy = (canvas.height - dh) / 2

    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(video, dx, dy, dw, dh)

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

  return {
    stream,
    isSharing,
    error,
    captureFrame,
    startScreenShare,
    stopScreenShare,
  }
}
