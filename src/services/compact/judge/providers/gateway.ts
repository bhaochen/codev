import { JudgeError, type JudgeErrorKind } from "../errors.ts";
import type { Answer, JudgeProvider, JudgeRequest, JudgeUsage, ProviderResponse } from "../types.ts";
import { MAX_ERROR_MESSAGE_LENGTH, messageFromErrorBody, readWarnings } from "./http.ts";

const DEFAULT_BASE_URL = "https://ai-gateway.vercel.sh/v4/ai";
const DEFAULT_MODEL = "typesafe-ai/jev";
/** Matches AI_GATEWAY_PROTOCOL_VERSION in @ai-sdk/gateway@4.0.87. */
const GATEWAY_PROTOCOL_VERSION = "0.0.1";

/**
 * Resolves an API key per request, so the host owns credential storage.
 * Called on every evaluate, allowing keys to be rotated without restart.
 */
export type ApiKeyResolver = () => string | undefined | Promise<string | undefined>;

export interface GatewayJudgeProviderOptions {
	/** A key, or a resolver called per request so the host owns credential storage. */
	apiKey: string | ApiKeyResolver;
	model?: string;
	baseUrl?: string;
	fetch?: typeof fetch;
}

interface GatewayResponseBody {
	answers?: Record<string, Answer>;
	usage?: JudgeUsage;
	warnings?: unknown;
}

function errorKindForStatus(status: number, message: string): JudgeErrorKind {
	if (status === 401) return "auth";
	if (status === 402) return "payment_required";
	if (status === 403) return /credit card|payment|billing/i.test(message) ? "payment_required" : "auth";
	if (status === 429) return "rate_limited";
	if (status >= 500) return "server";
	return "bad_request";
}

/**
 * Calls a judge model through the Vercel AI Gateway `evaluation-model` endpoint.
 *
 * Uses `fetch` directly so the kernel has no runtime dependencies. Error
 * messages never contain the key or the submitted state.
 */
export class GatewayJudgeProvider implements JudgeProvider {
	readonly id: string;
	private readonly apiKey: string | ApiKeyResolver;
	private readonly model: string;
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;

	constructor(options: GatewayJudgeProviderOptions) {
		this.apiKey = options.apiKey;
		this.model = options.model ?? DEFAULT_MODEL;
		this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
		this.fetchImpl = options.fetch ?? fetch;
		this.id = `gateway:${this.model}`;
	}

	async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
		const apiKey = typeof this.apiKey === "string" ? this.apiKey : await this.apiKey();
		if (!apiKey) throw new JudgeError("auth", "No AI Gateway API key is configured");

		let response: Response;
		try {
			response = await this.fetchImpl(`${this.baseUrl}/evaluation-model`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					"ai-gateway-protocol-version": GATEWAY_PROTOCOL_VERSION,
					"ai-gateway-auth-method": "api-key",
					"ai-evaluation-model-specification-version": "4",
					"ai-model-id": this.model,
				},
				body: JSON.stringify({ state: request.state, questions: request.questions }),
				signal: request.signal,
			});
		} catch (error) {
			// Aborts are classified by the kernel, which knows whether its timeout or the caller fired.
			if (error instanceof Error && error.name === "AbortError") throw error;
			throw new JudgeError("unreachable", "Could not reach the AI Gateway", { cause: error });
		}

		if (!response.ok) {
			const body: unknown = await response.json().catch(() => undefined);
			const message = messageFromErrorBody(body).slice(0, MAX_ERROR_MESSAGE_LENGTH);
			throw new JudgeError(
				errorKindForStatus(response.status, message),
				message || `AI Gateway responded with HTTP ${response.status}`,
				{ status: response.status },
			);
		}

		const body = (await response.json().catch(() => undefined)) as GatewayResponseBody | undefined;
		if (!body || typeof body.answers !== "object" || body.answers === null) {
			throw new JudgeError("invalid_response", "AI Gateway response has no answers", { status: response.status });
		}
		return {
			answers: body.answers,
			usage: body.usage,
			modelId: this.model,
			warnings: readWarnings(body.warnings),
		};
	}
}
