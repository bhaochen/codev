import * as React from 'react'
import { Clawd } from './Clawd.js'

/**
 * Thin wrapper for click-triggered animations (delegated to Clawd's own
 * onClick). Render this in place of bare <Clawd /> in environments where
 * mouse tracking is active (alt-screen / fullscreen).
 *
 * Container height is fixed at 3 so layout never shifts during a crouch.
 */
export function AnimatedClawd({
  gradientStops,
}: { gradientStops?: [string, string, ...string[]] } = {}): React.ReactNode {
  return <Clawd gradientStops={gradientStops} suppressIdleAnim />
}
