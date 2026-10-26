import { Text } from '../../ink.js'
import { MessageResponse } from '../MessageResponse.js'

type RateLimitMessageProps = {
  text: string
  onOpenRateLimitOptions?: () => void
}

export function RateLimitMessage({ text }: RateLimitMessageProps) {
  return (
    <MessageResponse height={1}>
      <Text color="error">{text}</Text>
    </MessageResponse>
  )
}
