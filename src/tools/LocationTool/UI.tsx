import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { Box, Text } from '../../ink.js'
import { truncate } from '../../utils/format.js'

export function renderToolUseMessage(
  input: Partial<{
    action: string
    location: string
    destination: string
    query: string
  }>,
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const { action, location, destination, query } = input
  if (!action || !location) {
    return null
  }

  const actionLabel: Record<string, string> = {
    geocode: '地理编码',
    search_places: '搜索地点',
    get_directions: '路线规划',
    plan_trip: '行程规划',
  }

  let msg = `${actionLabel[action] || action}: ${location}`
  if (destination) msg += ` → ${destination}`
  if (query && verbose) msg += ` (${query})`

  return msg
}

export function renderToolUseProgressMessage(): React.ReactNode {
  return null
}

export function renderToolResultMessage(output: {
  action: string
  region?: string
  geocoding?: { formattedAddress: string; lat: number; lng: number }
  places?: unknown[]
  directions?: { origin: string; destination: string; totalDistance: string; totalDuration: string }
  error?: string
}): React.ReactNode {
  if (!output) return null

  if (output.error) {
    return (
      <MessageResponse>
        <Text color="red">Location error: {output.error}</Text>
      </MessageResponse>
    )
  }

  const parts: string[] = []
  const regionLabel = output.region === 'china' ? '中国大陆' : '海外'

  if (output.geocoding) {
    const g = output.geocoding
    parts.push(`坐标: ${g.lat}, ${g.lng}`)
  }
  if (output.places?.length) {
    parts.push(`找到 ${output.places.length} 个地点`)
  }
  if (output.directions) {
    const d = output.directions
    parts.push(`${d.origin} → ${d.destination}: ${d.totalDistance}, ${d.totalDuration}`)
  }

  return (
    <MessageResponse>
      <Text>
        [{regionLabel}] {parts.join(' | ')}
      </Text>
    </MessageResponse>
  )
}

export function getToolUseSummary(
  input: Partial<{
    action: string
    location: string
    destination: string
    query: string
  }> | undefined,
): string | null {
  if (!input?.action || !input?.location) return null
  let summary = `${input.action}: ${input.location}`
  if (input.destination) summary += ` → ${input.destination}`
  return truncate(summary, TOOL_SUMMARY_MAX_LENGTH)
}
