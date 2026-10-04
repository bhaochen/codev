/**
 * Why a judge call failed. Callers never branch on message text.
 *
 * - `auth`: no usable key, or no judge configured at all. The next call fails
 *   the same way until the user sets one up.
 * - `payment_required`: the account behind the key cannot service requests yet
 *   (AI Gateway answers 403 until a payment card is on file).
 */
export type JudgeErrorKind =
	| "timeout"
	| "aborted"
	| "unreachable"
	| "auth"
	| "payment_required"
	| "rate_limited"
	| "bad_request"
	| "server"
	| "invalid_response";

export class JudgeError extends Error {
	readonly kind: JudgeErrorKind;
	readonly status: number | undefined;

	constructor(kind: JudgeErrorKind, message: string, options?: { status?: number; cause?: unknown }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause });
		this.name = "JudgeError";
		this.kind = kind;
		this.status = options?.status;
	}
}

export function isJudgeError(error: unknown): error is JudgeError {
	return error instanceof JudgeError;
}
