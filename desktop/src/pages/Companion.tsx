import { useEffect, useRef, useCallback } from 'react'
import { useCompanionStore } from '../stores/companionStore'
import { useCompanionWebSocket } from '../hooks/useCompanionWebSocket'
import { useWebcam } from '../hooks/useWebcam'
import { useMicrophone } from '../hooks/useMicrophone'
import { useCompanionAudio } from '../hooks/useCompanionAudio'
import { useScreenShare } from '../hooks/useScreenShare'
import { useCameraDevices } from '../hooks/useCameraDevices'
import { CompanionVideoPanel } from '../components/companion/CompanionVideoPanel'
import { CompanionTranscript } from '../components/companion/CompanionTranscript'
import { CompanionControls } from '../components/companion/CompanionControls'
import { CompanionTopBar } from '../components/companion/CompanionTopBar'
import { ScenarioSelector } from '../components/companion/ScenarioSelector'
import { ScreenShareDialog } from '../components/companion/ScreenShareDialog'

export function Companion() {
  const status = useCompanionStore((s) => s.status)
  const speaking = useCompanionStore((s) => s.speaking)
  const generating = useCompanionStore((s) => s.generating)
  const transcript = useCompanionStore((s) => s.transcript)
  const fullTranscript = useCompanionStore((s) => s.fullTranscript)
  const micEnabled = useCompanionStore((s) => s.micEnabled)
  const cameraEnabled = useCompanionStore((s) => s.cameraEnabled)
  const cameraFacingMode = useCompanionStore((s) => s.cameraFacingMode)
  const error = useCompanionStore((s) => s.error)
  const scenario = useCompanionStore((s) => s.scenario)
  const statusText = useCompanionStore((s) => s.statusText)
  const setMicEnabled = useCompanionStore((s) => s.setMicEnabled)
  const setCameraEnabled = useCompanionStore((s) => s.setCameraEnabled)
  const setCameraFacingMode = useCompanionStore((s) => s.setCameraFacingMode)
  const setCameraDevices = useCompanionStore((s) => s.setCameraDevices)
  const setActiveCameraLabel = useCompanionStore((s) => s.setActiveCameraLabel)
  const setCameraFullscreen = useCompanionStore((s) => s.setCameraFullscreen)
  const setScreenShareStream = useCompanionStore((s) => s.setScreenShareStream)
  const setScreenShareDialogOpen = useCompanionStore((s) => s.setScreenShareDialogOpen)
  const setStatusText = useCompanionStore((s) => s.setStatusText)
  const reset = useCompanionStore((s) => s.reset)
  const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const screenShareIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Audio playback
  const companionAudio = useCompanionAudio()
  const onAudioReceived = useCallback(
    (data: ArrayBuffer) => {
      companionAudio.enqueueAudio(data)
    },
    [companionAudio],
  )
  const onDone = useCallback(() => {
    companionAudio.flush()
  }, [companionAudio])

  // WebSocket
  const ws = useCompanionWebSocket({ onAudioReceived, onDone })

  // Camera devices
  const cameraDevices = useCameraDevices()

  // Screen share
  const screenShare = useScreenShare()

  // Webcam runs independently (toggle on/off without needing connection)
  const webcam = useWebcam(cameraEnabled)
  // Mic only runs when connected (sends audio over WS)
  useMicrophone(ws.connected && micEnabled, ws.sendAudio)

  // Enumerate cameras when camera is enabled
  useEffect(() => {
    if (cameraEnabled) {
      cameraDevices.enumerateCameras().then((devices) => {
        setCameraDevices(devices)
        if (devices.length > 0) {
          setActiveCameraLabel(devices[0]?.label ?? null)
        }
      })
    }
  }, [cameraEnabled, cameraDevices, setCameraDevices, setActiveCameraLabel])

  // Update status text based on state
  useEffect(() => {
    if (status === 'connected') {
      if (generating) {
        setStatusText('AI 说话中...')
      } else if (speaking) {
        setStatusText('请说话')
      } else {
        setStatusText('你可以开始说话')
      }
    } else if (status === 'connecting') {
      setStatusText('连接中...')
    } else {
      setStatusText('')
    }
  }, [status, generating, speaking, setStatusText])

  // Periodic webcam frame capture (only send when connected)
  useEffect(() => {
    if (ws.connected && cameraEnabled) {
      frameIntervalRef.current = setInterval(async () => {
        const frame = await webcam.captureFrame()
        if (frame) {
          ws.sendFrame(frame)
        }
      }, 1000)
    } else {
      if (frameIntervalRef.current) {
        clearInterval(frameIntervalRef.current)
        frameIntervalRef.current = null
      }
    }
    return () => {
      if (frameIntervalRef.current) {
        clearInterval(frameIntervalRef.current)
        frameIntervalRef.current = null
      }
    }
  }, [ws.connected, cameraEnabled, webcam, ws])

  // Periodic screen share frame capture
  useEffect(() => {
    if (ws.connected && screenShare.isSharing) {
      screenShareIntervalRef.current = setInterval(async () => {
        const frame = await screenShare.captureFrame()
        if (frame) {
          ws.sendFrame(frame)
        }
      }, 1000)
    } else {
      if (screenShareIntervalRef.current) {
        clearInterval(screenShareIntervalRef.current)
        screenShareIntervalRef.current = null
      }
    }
    return () => {
      if (screenShareIntervalRef.current) {
        clearInterval(screenShareIntervalRef.current)
        screenShareIntervalRef.current = null
      }
    }
  }, [ws.connected, screenShare.isSharing, screenShare, ws])

  // Send scenario context when connecting
  useEffect(() => {
    if (ws.connected && scenario) {
      ws.sendText(`[Scenario: ${scenario}]`)
    }
  }, [ws.connected]) // only send on connect

  // Sync screen share stream to store
  useEffect(() => {
    setScreenShareStream(screenShare.stream)
  }, [screenShare.stream, setScreenShareStream])

  const handleSendText = useCallback(
    (text: string) => {
      ws.sendText(text)
    },
    [ws],
  )

  const handleResumeAudio = useCallback(() => {
    companionAudio.resume()
  }, [companionAudio])

  const handleToggleMic = useCallback(() => {
    setMicEnabled(!micEnabled)
  }, [micEnabled, setMicEnabled])

  const handleToggleCamera = useCallback(() => {
    const next = !cameraEnabled
    setCameraEnabled(next)
    // When camera turns on, show as fullscreen background
    if (next) {
      setCameraFullscreen(true)
    } else {
      setCameraFullscreen(false)
    }
  }, [cameraEnabled, setCameraEnabled, setCameraFullscreen])

  const handleFlipCamera = useCallback(async () => {
    const nextMode = cameraFacingMode === 'user' ? 'environment' : 'user'
    setCameraFacingMode(nextMode)
    await cameraDevices.getStreamForFacingMode(nextMode)
  }, [cameraFacingMode, setCameraFacingMode, cameraDevices])

  const handleScreenShareClick = useCallback(() => {
    if (screenShare.isSharing) {
      screenShare.stopScreenShare()
    } else {
      setScreenShareDialogOpen(true)
    }
  }, [screenShare, setScreenShareDialogOpen])

  const handleStartScreenShare = useCallback(async () => {
    await screenShare.startScreenShare()
  }, [screenShare])

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      {/* Video background + content */}
      <CompanionVideoPanel
        webcamStream={webcam.stream}
        speaking={speaking}
        generating={generating}
        status={status}
        onFlipCamera={handleFlipCamera}
      />

      {/* Top bar with scenario selector + subtitle toggle */}
      <CompanionTopBar />

      {/* Scenario selection panel overlay */}
      <ScenarioSelector />

      {/* Screen share dialog overlay */}
      <ScreenShareDialog onStartScreenShare={handleStartScreenShare} />

      {/* Error overlay */}
      {error && (
        <div className="absolute top-14 left-1/2 -translate-x-1/2 px-4 py-2 rounded-xl bg-red-500/20 border border-red-500/30 text-red-300 text-sm z-20">
          {error}
        </div>
      )}

      {/* Status text bar */}
      {statusText && (
        <div className="absolute bottom-[88px] left-1/2 -translate-x-1/2 z-10">
          <span className="text-white/30 text-xs tracking-widest">{statusText}</span>
        </div>
      )}

      {/* Transcript + text input */}
      <CompanionTranscript
        transcript={transcript}
        fullTranscript={fullTranscript}
        generating={generating || speaking}
        onSendText={handleSendText}
        disabled={status !== 'connected'}
      />

      {/* Bottom controls */}
      <CompanionControls
        status={status}
        micEnabled={micEnabled}
        cameraEnabled={cameraEnabled}
        generating={generating}
        isSharing={screenShare.isSharing}
        onToggleMic={handleToggleMic}
        onToggleCamera={handleToggleCamera}
        onScreenShareClick={handleScreenShareClick}
        onConnect={ws.connect}
        onDisconnect={() => {
          ws.disconnect()
          if (screenShare.isSharing) {
            screenShare.stopScreenShare()
          }
          reset()
        }}
        onStop={ws.sendStop}
        onResumeAudio={handleResumeAudio}
      />
    </div>
  )
}
