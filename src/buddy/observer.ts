import { getCompanion } from './companion.js'

type MessageLike = {
  type?: string
  message?: {
    content?: unknown
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  return content
    .map(block => {
      if (!block || typeof block !== 'object') return ''
      const candidate = block as { type?: string; text?: string }
      return candidate.type === 'text' && typeof candidate.text === 'string'
        ? candidate.text
        : ''
    })
    .join(' ')
    .trim()
}

function findLastText(
  messages: MessageLike[],
  targetType: 'assistant' | 'user',
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message?.type !== targetType) continue
    const text = extractText(message.message?.content)
    if (text) return text
  }
  return ''
}

function chooseReaction(userText: string, assistantText: string): string | undefined {
  const companion = getCompanion()
  if (!companion) return undefined

  const loweredUser = userText.toLowerCase()
  const loweredAssistant = assistantText.toLowerCase()
  const directMention =
    loweredUser.includes(companion.name.toLowerCase()) ||
    loweredUser.includes('buddy')

  if (!directMention) return undefined

  if (/\b(thanks|thank you|nice|great|good job|cute)\b/.test(loweredUser)) {
    return `${companion.name} looks smug for exactly one second.`
  }
  if (/\b(help|idea|thought|opinion|what do you think)\b/.test(loweredUser)) {
    return `${companion.name} votes for the less cursed option.`
  }
  if (/\b(refactor|bug|error|failed|fix)\b/.test(loweredAssistant)) {
    return `${companion.name} squints at the bug like it owes rent.`
  }
  if (/\b(done|finished|fixed|works)\b/.test(loweredAssistant)) {
    return `${companion.name} seems satisfied with the outcome.`
  }
  return `${companion.name} is paying attention from the edge of the prompt box.`
}

export async function fireCompanionObserver(
  messages: MessageLike[],
  onReaction: (reaction: string | undefined) => void,
): Promise<void> {
  const companion = getCompanion()
  if (!companion) {
    onReaction(undefined)
    return
  }

  const userText = findLastText(messages, 'user')
  const assistantText = findLastText(messages, 'assistant')
  onReaction(chooseReaction(userText, assistantText))
}
