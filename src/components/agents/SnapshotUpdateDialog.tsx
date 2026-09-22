import { useEffect } from 'react'

type Props = {
  agentType: string
  scope: unknown
  snapshotTimestamp: string
  onComplete: (choice: 'merge' | 'keep' | 'replace') => void
  onCancel: () => void
}

export function SnapshotUpdateDialog({ onCancel }: Props) {
  useEffect(() => {
    onCancel()
  }, [onCancel])

  return null
}

export function buildMergePrompt(agentType: string, memory: unknown): string {
  const serialized = JSON.stringify(memory, null, 2)
  return `# Merge pending memory snapshot (${agentType})\n\nA pending memory snapshot is available. Merge it into the agent memory.\n\n<memory_snapshot>\n${serialized}\n</memory_snapshot>`
}
