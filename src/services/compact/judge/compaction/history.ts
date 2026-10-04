/**
 * The conversation as compaction sees it: what people and the model said, and
 * the tool calls in between. Compaction never rewrites the first kind and only
 * ever shortens the results of the second, so the model that serializes the
 * history is also the record of what was done to it.
 */
export type HistoryItem =
	| { readonly kind: "user" | "assistant" | "note"; readonly text: string; readonly pinned?: boolean }
	| CallItem;

export interface CallItem {
	readonly kind: "call";
	readonly id: string;
	readonly tool: string;
	readonly input: Readonly<Record<string, unknown>>;
	/** The output as it stands: complete, or only its beginning once pruned. */
	readonly result: string;
	readonly isError: boolean;
	readonly state: "full" | "pruned";
	/** Length of the complete output. */
	readonly resultChars: number;
	/** Where the complete output was saved when it was pruned. */
	readonly archive?: string;
	/** Part of the turn still in progress: never pruned. */
	readonly pinned?: boolean;
}

/** The part of a pi-ai message this module reads. Structural, so the kernel needs no model SDK. */
export interface MessageLike {
	readonly role: string;
	readonly content?: unknown;
	readonly toolCallId?: string;
	readonly toolName?: string;
	readonly isError?: boolean;
}

function blocks(content: unknown): readonly Record<string, unknown>[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return [];
	return content.filter((block): block is Record<string, unknown> => typeof block === "object" && block !== null);
}

function textOf(content: unknown): string {
	return blocks(content)
		.map((block) =>
			block.type === "text" && typeof block.text === "string" ? block.text : block.type === "image" ? "[image]" : "",
		)
		.filter(Boolean)
		.join("\n")
		.trim();
}

/**
 * Pairs every tool call with its result and drops the model's private
 * thinking, which is neither something that was said nor something that was done.
 */
export function itemsFromMessages(messages: readonly MessageLike[], pinned = false): HistoryItem[] {
	const items: HistoryItem[] = [];
	const callAt = new Map<string, number>();
	for (const message of messages) {
		if (message.role === "user") {
			const text = textOf(message.content);
			if (text) items.push({ kind: "user", text, pinned: pinned || undefined });
		} else if (message.role === "assistant") {
			const said = textOf(message.content);
			if (said) items.push({ kind: "assistant", text: said, pinned: pinned || undefined });
			for (const block of blocks(message.content)) {
				if (block.type !== "toolCall" || typeof block.id !== "string") continue;
				callAt.set(block.id, items.length);
				items.push({
					kind: "call",
					id: block.id,
					tool: typeof block.name === "string" ? block.name : "tool",
					input:
						typeof block.arguments === "object" && block.arguments !== null
							? (block.arguments as Record<string, unknown>)
							: {},
					result: "",
					isError: false,
					state: "full",
					resultChars: 0,
					pinned: pinned || undefined,
				});
			}
		} else if (message.role === "toolResult") {
			const result = textOf(message.content);
			const index = message.toolCallId === undefined ? undefined : callAt.get(message.toolCallId);
			const patch = { result, isError: message.isError === true, resultChars: result.length };
			if (index === undefined) {
				// A result whose call was cut off by an earlier boundary still happened.
				items.push({
					kind: "call",
					id: message.toolCallId ?? `orphan-${items.length}`,
					tool: message.toolName ?? "tool",
					input: {},
					state: "full",
					pinned: pinned || undefined,
					...patch,
				});
			} else {
				items[index] = { ...(items[index] as CallItem), ...patch };
			}
		}
	}
	return items;
}

/** `read path="src/a.ts"`: the call on one line, long values cut. */
export function describeCall(call: Pick<CallItem, "tool" | "input">, valueChars = 160): string {
	const args = Object.entries(call.input)
		.map(([key, value]) => {
			const text = typeof value === "string" ? value : JSON.stringify(value);
			const flat = (text ?? "").replace(/\s+/g, " ");
			return `${key}=${JSON.stringify(flat.length > valueChars ? `${flat.slice(0, valueChars)}…` : flat)}`;
		})
		.join(" ");
	return args ? `${call.tool} ${args}` : call.tool;
}

export const HISTORY_HEADER = `This is the earlier part of the conversation, word for word. Nothing was summarized. What the user and the assistant said is complete and in order. Only tool output was pruned: a result marked "pruned" was judged no longer needed, so only its beginning is shown, and its complete text is in the file named there. Read that file, or run the tool again, if it turns out to matter.`;

/** The history as the text that replaces the compacted messages. Call ids are renumbered t1, t2, ... to save tokens. */
export function serializeHistory(items: readonly HistoryItem[], header: string = HISTORY_HEADER): string {
	const parts: string[] = [header];
	let calls = 0;
	for (const item of items) {
		if (item.kind !== "call") {
			const label =
				item.kind === "user" ? "User" : item.kind === "assistant" ? "Assistant" : "Summary of what came before";
			parts.push(`[${label}]\n${item.text}`);
		} else {
			const id = `t${++calls}`;
			const failed = item.isError ? ", failed" : "";
			const label =
				item.state === "pruned"
					? `[Tool result ${id}${failed}, pruned: first ${item.result.length} of ${item.resultChars} chars${item.archive ? `; complete text: ${item.archive}` : ""}]`
					: `[Tool result ${id}${failed}]`;
			parts.push(`[Tool call ${id}] ${describeCall(item)}\n${label}${item.result ? `\n${item.result}` : ""}`);
		}
	}
	return parts.join("\n\n");
}
