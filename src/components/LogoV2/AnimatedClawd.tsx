import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, useAnimationFrame } from '../../ink.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { Clawd, type ClawdPose } from './Clawd.js'

type Frame = { pose: ClawdPose; offset: number }

function hold(pose: ClawdPose, offset: number, frames: number): Frame[] {
  return Array.from({ length: frames }, () => ({ pose, offset }))
}

// Offset semantics: marginTop in a fixed-height-3 container. 0 = normal,
// 1 = crouched. Container height stays 3 so the layout never shifts; during
// a crouch (offset=1) Clawd's feet row dips below the container and gets
// clipped — reads as "ducking below the frame" before springing back up.

const JUMP_WAVE: readonly Frame[] = [
  ...hold('default', 1, 2),
  ...hold('arms-up', 0, 3),
  ...hold('default', 0, 1),
  ...hold('default', 1, 2),
  ...hold('arms-up', 0, 3),
  ...hold('default', 0, 1),
]

const LOOK_AROUND: readonly Frame[] = [
  ...hold('look-right', 0, 5),
  ...hold('look-left', 0, 5),
  ...hold('default', 0, 1),
]

const CLICK_ANIMATIONS: readonly (readonly Frame[])[] = [JUMP_WAVE, LOOK_AROUND]

const IDLE: Frame = { pose: 'default', offset: 0 }
const FRAME_MS = 60
const CLAWD_HEIGHT = 3

/**
 * Clawd with click-triggered animations (crouch-jump with arms up, or
 * look-around). Container height is fixed at CLAWD_HEIGHT — same footprint
 * as a bare `<Clawd />` — so the surrounding layout never shifts. During a
 * crouch only the feet row clips (see comment above). Click only fires when
 * mouse tracking is enabled (i.e. inside `<AlternateScreen>` / fullscreen);
 * elsewhere this renders and behaves identically to plain `<Clawd />`.
 *
 * Animation timing is driven by the shared clock via `useAnimationFrame` so
 * it auto-pauses when offscreen and stays in sync with other animations.
 */
export function AnimatedClawd({ gradientStops }: { gradientStops?: [string, string, ...string[]] } = {}): React.ReactNode {
  const [reducedMotion] = useState(
    () => getInitialSettings().prefersReducedMotion ?? false,
  )

  const sequenceRef = useRef<readonly Frame[]>(JUMP_WAVE)
  const [animStart, setAnimStart] = useState<number | null>(null)
  const [ref, time] = useAnimationFrame(animStart !== null ? FRAME_MS : null)

  const onClick = () => {
    if (reducedMotion || animStart !== null) return
    sequenceRef.current =
      CLICK_ANIMATIONS[Math.floor(Math.random() * CLICK_ANIMATIONS.length)]!
    setAnimStart(time)
  }

  // Auto-reset when animation completes
  useEffect(() => {
    if (animStart === null) return
    const elapsed = time - animStart
    if (elapsed >= sequenceRef.current.length * FRAME_MS) {
      setAnimStart(null)
    }
  }, [time, animStart])

  // Compute current frame from elapsed time (not frame index, so clock drift
  // or skipped ticks don't cause frame-skips or late completions).
  const totalFrames = sequenceRef.current.length
  const frameIndex =
    animStart !== null
      ? Math.min(Math.floor((time - animStart) / FRAME_MS), totalFrames - 1)
      : -1
  const current =
    frameIndex >= 0 && frameIndex < totalFrames
      ? sequenceRef.current[frameIndex]
      : IDLE

  return (
    <Box height={CLAWD_HEIGHT} flexDirection="column" onClick={onClick} ref={ref}>
      <Box marginTop={current.offset} flexShrink={0}>
        <Clawd pose={current.pose} gradientStops={gradientStops} />
      </Box>
    </Box>
  )
}
