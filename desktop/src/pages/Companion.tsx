import { useEffect, useRef, useCallback } from 'react'
import { useCompanionStore } from '../stores/companionStore'
import { useCompanionWebSocket } from '../hooks/useCompanionWebSocket'
import { useWebcam } from '../hooks/useWebcam'
import { useMicrophone } from '../hooks/useMicrophone'
import { useCompanionAudio } from '../hooks/useCompanionAudio'
import { CompanionVideoPanel } from '../components/companion/CompanionVideoPanel'
import { CompanionTranscript } from '../components/companion/CompanionTranscript'
import { CompanionControls } from '../components/companion/CompanionControls'

export function Companion() {
  const status = useCompanionStore((s) => s.status)
  const speaking = useCompanionStore((s) => s.speaking)
  const generating = useCompanionStore((s) => s.generating)
  const transcript = useCompanionStore((s) => s.transcript)
  const fullTranscript = useCompanionStore((s) => s.fullTranscript)
  const micEnabled = useCompanionStore((s) => s.micEnabled)
  const cameraEnabled = useCompanionStore((s) => s.cameraEnabled)
  const error = useCompanionStore((s) => s.error)
  const setMicEnabled = useCompanionStore((s) => s.setMicEnabled)
  const setCameraEnabled = useCompanionStore((s) => s.setCameraEnabled)
  const reset = useCompanionStore((s) => s.reset)
  const frameIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

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

  const ws = useCompanionWebSocket({ onAudioReceived, onDone })
  const webcam = useWebcam(ws.connected && cameraEnabled)
  useMicrophone(ws.connected && micEnabled, ws.sendAudio)

  // Periodic frame capture when connected and camera enabled
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

  const handleSendText = useCallback(
    (text: string) => {
      ws.sendText(text)
    },
    [ws],
  )

  // Resume audio context on user interaction
  const handleResumeAudio = useCallback(() => {
    companionAudio.resume()
  }, [companionAudio])

  const handleToggleMic = useCallback(() => {
    setMicEnabled(!micEnabled)
  }, [micEnabled, setMicEnabled])

  const handleToggleCamera = useCallback(() => {
    setCameraEnabled(!cameraEnabled)
  }, [cameraEnabled, setCameraEnabled])

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      {/* Video background + PiP */}
      <CompanionVideoPanel
        webcamStream={webcam.stream}
        speaking={speaking}
        generating={generating}
        status={status}
      />

      {/* Error overlay */}
      {error && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-xl bg-red-500/20 border border-red-500/30 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Transcript + text input */}
      <CompanionTranscript
        transcript={transcript}
        fullTranscript={fullTranscript}
        onSendText={handleSendText}
        disabled={status !== 'connected'}
      />

      {/* Controls */}
      <CompanionControls
        status={status}
        micEnabled={micEnabled}
        cameraEnabled={cameraEnabled}
        generating={generating}
        onToggleMic={handleToggleMic}
        onToggleCamera={handleToggleCamera}
        onConnect={ws.connect}
        onDisconnect={() => {
          ws.disconnect()
          reset()
        }}
        onStop={ws.sendStop}
        onResumeAudio={handleResumeAudio}
      />
    </div>
  )
}
