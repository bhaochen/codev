import type { Message, UserMessage, AssistantMessage } from '../../../types/message.js'
import type { AgentContentBlock, AgentToolUseBlock, AgentToolResultBlock, AgentTextBlock } from '../../../types/agentMessage.js'
import { itemsFromMessages, type HistoryItem, type MessageLike } from './compaction/history.js'

/**
 * Converts codev's `Message[]` to the compaction kernel's `MessageLike[]` so it
 * can process them. Only user and assistant messages are converted;
 * system/progress/attachment messages are UI-level and not part of the
 * conversation history that compaction sees.
 *
 * The kernel's shape is not codev's:
 * - a tool call is a `toolCall` block (`id`, `name`, `arguments`) inside assistant content, where codev
 *   uses `AgentToolUseBlock` (`type: 'tool_use'`, `id`, `name`, `input`)
 * - a tool result is its own `toolResult` message, where codev keeps it as an `AgentToolResultBlock`
 *   inside a user message
 */
export function codevMessagesToMessageLikes(messages: readonly Message[]): MessageLike[] {
	const result: MessageLike[] = []

	for (const message of messages) {
		if (message.type === 'user') {
			const content = (message as UserMessage).message.content
			const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
			const text = extractText(blocks)
			if (text) {
				result.push({ role: 'user', content: text })
			}
			for (const block of blocks) {
				if (block.type !== 'tool_result') continue
				const b = block as AgentToolResultBlock
				const resultContent = typeof b.content === 'string' ? b.content : extractText(b.content ?? [])
				result.push({
					role: 'toolResult',
					toolCallId: b.tool_use_id,
					toolName: 'tool',
					content: resultContent,
					isError: b.is_error === true,
				})
			}
		} else if (message.type === 'assistant') {
			const content = (message as AssistantMessage).message.content
			const text = extractText(content)
			// Convert codev's tool_use blocks to the kernel's toolCall blocks
			const convertedBlocks: Record<string, unknown>[] = []
			for (const block of content) {
				if (block.type === 'tool_use') {
					const b = block as AgentToolUseBlock
					convertedBlocks.push({ type: 'toolCall', id: b.id, name: b.name, arguments: b.input })
				} else if (block.type === 'text') {
					const b = block as AgentTextBlock
					convertedBlocks.push({ type: 'text', text: b.text })
				}
				// Skip thinking, images, documents, etc.
			}

			// Push assistant message with converted content (text + tool calls)
			// itemsFromMessages reads content as string or block array
			const assistantContent = convertedBlocks.length > 0 ? convertedBlocks : text
			if (assistantContent) {
				result.push({ role: 'assistant', content: assistantContent })
			}
		}
		// Skip system, progress, attachment, tombstone, etc.
	}

	return result
}

function extractText(blocks: readonly AgentContentBlock[]): string {
	return blocks
		.filter((b): b is AgentTextBlock => b.type === 'text')
		.map((b) => b.text)
		.join('\n')
		.trim()
}

/**
 * Converts codev `Message[]` to `HistoryItem[]` for compaction.
 * This is the main entry point used by the compaction feature.
 */
export function codevMessagesToHistoryItems(messages: readonly Message[]): HistoryItem[] {
	const messageLikes = codevMessagesToMessageLikes(messages)
	return itemsFromMessages(messageLikes)
}
