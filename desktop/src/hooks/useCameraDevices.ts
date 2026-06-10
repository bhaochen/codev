import { useState, useCallback } from 'react'

export function useCameraDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null)

  const enumerateCameras = useCallback(async () => {
    try {
      const allDevices = await navigator.mediaDevices.enumerateDevices()
      const videoInputs = allDevices.filter((d) => d.kind === 'videoinput')
      setDevices(videoInputs)
      return videoInputs
    } catch {
      return []
    }
  }, [])

  const switchCamera = useCallback(
    async (deviceId: string): Promise<MediaStream | null> => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: deviceId },
            width: { ideal: 640 },
            height: { ideal: 480 },
          },
          audio: false,
        })
        setActiveDeviceId(deviceId)
        return stream
      } catch (err) {
        console.error('Failed to switch camera:', err)
        return null
      }
    },
    [],
  )

  const getStreamForFacingMode = useCallback(
    async (facingMode: 'user' | 'environment'): Promise<MediaStream | null> => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode,
            width: { ideal: 640 },
            height: { ideal: 480 },
          },
          audio: false,
        })
        return stream
      } catch (err) {
        console.error('Failed to get camera with facing mode:', err)
        return null
      }
    },
    [],
  )

  return {
    devices,
    activeDeviceId,
    enumerateCameras,
    switchCamera,
    getStreamForFacingMode,
  }
}
