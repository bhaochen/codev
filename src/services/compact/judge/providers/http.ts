import type { JudgeWarning } from "../types.ts";

export const MAX_ERROR_MESSAGE_LENGTH = 300;

/** Reads `{error: {message}}`, `{error: "..."}`, `{message}` or `{detail: "..."}`; returns "" when there is none. */
export function messageFromErrorBody(body: unknown): string {
	if (typeof body !== "object" || body === null) return "";
	const record = body as Record<string, unknown>;
	const nested = record.error;
	if (typeof nested === "object" && nested !== null) {
		const nestedMessage = (nested as Record<string, unknown>).message;
		if (typeof nestedMessage === "string") return nestedMessage;
	}
	if (typeof nested === "string") return nested;
	if (typeof record.message === "string") return record.message;
	// FastAPI's shape, which CLM's server answers with. A list there echoes the request back, and is left out.
	return typeof record.detail === "string" ? record.detail : "";
}

/** Keeps well-formed warnings and drops the rest, so a provider cannot break a call with a bad diagnostic. */
export function readWarnings(value: unknown): JudgeWarning[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const warnings: JudgeWarning[] = [];
	for (const item of value) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		if (typeof record.type !== "string") continue;
		warnings.push({
			type: record.type,
			message: typeof record.message === "string" ? record.message.slice(0, MAX_ERROR_MESSAGE_LENGTH) : undefined,
			questionId: typeof record.questionId === "string" ? record.questionId : undefined,
		});
	}
	return warnings.length > 0 ? warnings : undefined;
}
