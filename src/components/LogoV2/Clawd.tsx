import * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Box, Text, useAnimationFrame } from '../../ink.js'
import { env } from '../../utils/env.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { interpolateColor, parseRGB, toRGBColor } from '../Spinner/utils.js'

export type ClawdPose =
  | 'default'
  | 'arms-up'
  | 'look-left'
  | 'look-right'
  | 'blink'

type Props = {
  pose?: ClawdPose
  gradientStops?: [string, string, ...string[]]
  suppressIdleAnim?: boolean
}

// ==================== Art definition ====================

const COLS = 9
const ROWS = 3

const BG_MASK: boolean[][] = [
  [false, false, true,  true,  true,  true,  true,  false, false],
  [false, false, true,  true,  true,  true,  true,  false, false],
  [false, false, false, false, false, false, false, false, false],
]

type Segments = { r1L: string; r1E: string; r1R: string; r2L: string; r2R: string }

const POSES: Record<ClawdPose, Segments> = {
  default: { r1L: ' ▐', r1E: '▛███▜', r1R: '▌', r2L: '▝▜', r2R: '▛▘' },
  'look-left': { r1L: ' ▐', r1E: '▟███▟', r1R: '▌', r2L: '▝▜', r2R: '▛▘' },
  'look-right': { r1L: ' ▐', r1E: '▙███▙', r1R: '▌', r2L: '▝▜', r2R: '▛▘' },
  'arms-up': { r1L: '▗▟', r1E: '▛███▜', r1R: '▙▖', r2L: ' ▜', r2R: '▛ ' },
  blink: { r1L: ' ▐', r1E: '█████', r1R: '▌', r2L: '▝▜', r2R: '▛▘' },
}

const APPLE_EYES: Record<ClawdPose, string> = {
  default: ' ▗   ▖ ',
  'look-left': ' ▘   ▘ ',
  'look-right': ' ▝   ▝ ',
  'arms-up': ' ▗   ▖ ',
  blink: ' █   █ ',
}

const FEET = '  ▘▘ ▝▝'

/** Reconstruct a 2D grid (ROWS x COLS) from segment representation. */
function buildGrid(seg: Segments): string[][] {
  const r0 = (seg.r1L + seg.r1E + seg.r1R).padEnd(COLS, ' ')
  const r1 = (seg.r2L + '█████' + seg.r2R).padEnd(COLS, ' ')
  const r2 = FEET
  return [r0.split(''), r1.split(''), r2.split('')]
}

// ==================== Gradient utilities ====================

type RGB = { r: number; g: number; b: number }

/** Diagonal position t in [0, 1), bottom-left → top-right, with phase sweep. */
function diagonalT(x: number, y: number, cols: number, rows: number, phase: number): number {
  const span = Math.max(1, cols + rows - 1)
  const base = (x + (rows - 1 - y)) / span
  return (((base + phase) % 1) + 1) % 1
}

/** Multi-stop gradient sampling. */
function sampleGradient(t: number, stops: readonly RGB[]): RGB {
  if (stops.length === 0) return { r: 0, g: 0, b: 0 }
  if (stops.length === 1) return stops[0]
  const seg = t * (stops.length - 1)
  const i = Math.min(stops.length - 2, Math.floor(seg))
  const f = seg - i
  return interpolateColor(stops[i], stops[i + 1], f)
}

// ==================== Animation constants ====================

const INTRO_DURATION = 1500
const INTRO_SWEEPS = 2
const BLINK_INTERVAL = 6000
const BLINK_DURATION = 160
const FRAME_MS = 60

type Frame = { pose: ClawdPose; offset: number }

function hold(pose: ClawdPose, offset: number, frames: number): Frame[] {
  return Array.from({ length: frames }, () => ({ pose, offset }))
}

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

const IDLE_ANIMS: readonly (readonly Frame[])[] = [JUMP_WAVE, LOOK_AROUND]
const IDLE_ANIM_DELAY_MIN = 25000
const IDLE_ANIM_DELAY_MAX = 50000

// ==================== Main component ====================

export function Clawd({ pose = 'default', gradientStops, suppressIdleAnim = false }: Props = {}): React.ReactNode {
  const [reducedMotion] = useState(() => getInitialSettings().prefersReducedMotion ?? false)
  const [introDone, setIntroDone] = useState(reducedMotion)

  const startRef = useRef<number | null>(null)
  const [ref, time] = useAnimationFrame(33)

  // Set start time at render — same pattern as AnimatedAsterisk
  if (startRef.current === null && !introDone) {
    startRef.current = time
  }

  useEffect(() => {
    if (introDone) return
    const elapsed = time - (startRef.current ?? time)
    if (elapsed >= INTRO_DURATION) {
      setIntroDone(true)
    }
  }, [time, introDone])

  // Gradient phase: sweep during intro, static 0 after
  const elapsed = introDone ? INTRO_DURATION : Math.max(0, time - (startRef.current ?? time))
  const introProgress = Math.min(elapsed / INTRO_DURATION, 1)
  const eased = 1 - (1 - introProgress) ** 3
  const gradientPhase = introDone ? 0 : (((1 - eased) * INTRO_SWEEPS) % 1 + 1) % 1

  // Idle blink animation
  const [blinkPose, setBlinkPose] = useState<ClawdPose | null>(null)

  useEffect(() => {
    if (reducedMotion) return
    const intervalId = setInterval(() => {
      setBlinkPose('blink')
      setTimeout(() => setBlinkPose(null), BLINK_DURATION)
    }, BLINK_INTERVAL)
    return () => clearInterval(intervalId)
  }, [reducedMotion])

  // Idle animation (jump-wave / look-around)
  const runIdleAnim = !suppressIdleAnim && introDone && !reducedMotion
  const [idleAnim, setIdleAnim] = useState<{
    frames: readonly Frame[]
    startTime: number
  } | null>(null)
  const nextAnimRef = useRef(0)

  useEffect(() => {
    if (!runIdleAnim) return

    if (idleAnim !== null) {
      const elapsed = time - idleAnim.startTime
      if (elapsed >= idleAnim.frames.length * FRAME_MS) {
        setIdleAnim(null)
        nextAnimRef.current =
          time + IDLE_ANIM_DELAY_MIN + Math.random() * (IDLE_ANIM_DELAY_MAX - IDLE_ANIM_DELAY_MIN)
      }
    } else if (nextAnimRef.current > 0 && time >= nextAnimRef.current) {
      const picked = IDLE_ANIMS[Math.floor(Math.random() * IDLE_ANIMS.length)]!
      setIdleAnim({ frames: picked, startTime: time })
    }
  }, [time, runIdleAnim, idleAnim])

  useEffect(() => {
    if (runIdleAnim && nextAnimRef.current === 0) {
      nextAnimRef.current = time + 20000 + Math.random() * 10000
    }
  }, [runIdleAnim, time])

  // Clear idle animation state when externally suppressed
  useEffect(() => {
    if (suppressIdleAnim) setIdleAnim(null)
  }, [suppressIdleAnim])

  const hasActiveAnim = !suppressIdleAnim && idleAnim !== null
  const frameIndex = hasActiveAnim
    ? Math.min(Math.floor((time - idleAnim.startTime) / FRAME_MS), idleAnim.frames.length - 1)
    : -1
  const animFrame = frameIndex >= 0 ? idleAnim!.frames[frameIndex]! : null
  const bounceOffset = animFrame?.offset ?? 0
  const animPose = animFrame?.pose

  const effectivePose = animPose ?? blinkPose ?? pose

  // Apple Terminal fallback
  if (env.terminal === 'Apple_Terminal') {
    return <AppleTerminalClawd pose={effectivePose} />
  }

  // Determine content
  let innerContent: React.ReactNode
  if (gradientStops && gradientStops.length >= 2) {
    const stops = gradientStops
      .map(s => parseRGB(s))
      .filter((s): s is RGB => s !== null)
    if (stops.length >= 2) {
      innerContent = renderGradientGrid(effectivePose, stops, gradientPhase)
    } else {
      innerContent = renderPlainGrid(effectivePose)
    }
  } else {
    innerContent = renderPlainGrid(effectivePose)
  }

  return (
    <Box ref={ref} flexDirection="column">
      <Box marginTop={bounceOffset} flexShrink={0}>
        {innerContent}
      </Box>
    </Box>
  )
}

// ==================== Plain (single-color) rendering ====================

function renderPlainGrid(pose: ClawdPose): React.ReactNode {
  const p = POSES[pose]
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="clawd_body">{p.r1L}</Text>
        <Text color="clawd_body" backgroundColor="clawd_background">
          {p.r1E}
        </Text>
        <Text color="clawd_body">{p.r1R}</Text>
      </Text>
      <Text>
        <Text color="clawd_body">{p.r2L}</Text>
        <Text color="clawd_body" backgroundColor="clawd_background">
          █████
        </Text>
        <Text color="clawd_body">{p.r2R}</Text>
      </Text>
      <Text color="clawd_body">{FEET}</Text>
    </Box>
  )
}

// ==================== Gradient rendering ====================

function renderGradientGrid(pose: ClawdPose, stops: readonly RGB[], phase: number): React.ReactNode[] {
  const grid = buildGrid(POSES[pose])
  return grid.map((row, y) => {
    const cells: React.ReactNode[] = []
    for (let x = 0; x < row.length; x++) {
      const char = row[x]
      if (char === ' ') {
        cells.push(' ')
        continue
      }
      const t = diagonalT(x, y, COLS, ROWS, phase)
      const rgb = sampleGradient(t, stops)
      const colorStr = toRGBColor(rgb)
      if (BG_MASK[y]?.[x]) {
        cells.push(
          <Text key={`${y}-${x}`} color={colorStr} backgroundColor="clawd_background">
            {char}
          </Text>,
        )
      } else {
        cells.push(<Text key={`${y}-${x}`} color={colorStr}>{char}</Text>)
      }
    }
    return <Text key={y}>{cells}</Text>
  })
}

// ==================== Apple Terminal fallback ====================

function AppleTerminalClawd({ pose }: { pose: ClawdPose }): React.ReactNode {
  return (
    <Box flexDirection="column" alignItems="center">
      <Text>
        <Text color="clawd_body">▗</Text>
        <Text color="clawd_background" backgroundColor="clawd_body">
          {APPLE_EYES[pose]}
        </Text>
        <Text color="clawd_body">▖</Text>
      </Text>
      <Text backgroundColor="clawd_body">{' '.repeat(7)}</Text>
      <Text color="clawd_body">▘▘ ▝▝</Text>
    </Box>
  )
}
