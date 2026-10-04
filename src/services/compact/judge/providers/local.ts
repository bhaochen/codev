import { JudgeError } from "../errors.ts";
import type { Answer, JudgeProvider, JudgeRequest, JudgeUsage, ProviderResponse } from "../types.ts";
import { MAX_ERROR_MESSAGE_LENGTH, messageFromErrorBody, readWarnings } from "./http.ts";

export const DEFAULT_LOCAL_JUDGE_URL = "http://127.0.0.1:47823";

export interface LocalJudgeProviderOptions {
	/** Base URL of the judge sidecar. */
	baseUrl?: string;
	/** Request path, default "/evaluate". */
	path?: string;
	/** Ledger id, default "local:laya". Set it when this client talks to some other judge server. */
	id?: string;
	/** Extra request headers, resolved per request so tokens can come from the host. */
	headers?: () => Record<string, string> | Promise<Record<string, string>>;
	fetch?: typeof fetch;
}

interface LocalAnswerSignals {
	confidence?: unknown;
	actProbability?: unknown;
}

interface LocalResponseBody {
	answers?: Record<string, Answer>;
	usage?: JudgeUsage;
	warnings?: unknown;
	providerMetadata?: { laya?: { model?: unknown; answers?: Record<string, LocalAnswerSignals | undefined> } };
}

function unitInterval(value: unknown): number | undefined {
	return typeof value === "number" && value >= 0 && value <= 1 ? value : undefined;
}

/**
 * Calls the local judge sidecar, which serves an open-weight typed decision
 * model (Laya on Core ML) over the same request and answer shapes as the AI
 * Gateway. Nothing leaves the machine and there is no key.
 *
 * The sidecar reads a bounded window (1024 tokens for the default checkpoint,
 * shared by the question, its options and the state) and keeps the head of the
 * state, so decision specs must put the decisive content first. Anything cut is
 * reported through `warnings`.
 */
export class LocalJudgeProvider implements JudgeProvider {
	readonly id: string;
	private readonly baseUrl: string;
	private readonly path: string;
	private readonly headers: LocalJudgeProviderOptions["headers"];
	private readonly fetchImpl: typeof fetch;

	constructor(options: LocalJudgeProviderOptions = {}) {
		this.id = options.id ?? "local:laya";
		this.baseUrl = (options.baseUrl || DEFAULT_LOCAL_JUDGE_URL).replace(/\/+$/, "");
		this.path = options.path ?? "/evaluate";
		this.headers = options.headers;
		this.fetchImpl = options.fetch ?? fetch;
	}

	async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
		let response: Response;
		try {
			const extraHeaders = this.headers ? await this.headers() : {};
			response = await this.fetchImpl(`${this.baseUrl}${this.path}`, {
				method: "POST",
				headers: { ...extraHeaders, "Content-Type": "application/json" },
				body: JSON.stringify({ state: request.state, questions: request.questions }),
				signal: request.signal,
			});
		} catch (error) {
			// Aborts are classified by the kernel, which knows whether its timeout or the caller fired.
			if (error instanceof Error && error.name === "AbortError") throw error;
			throw new JudgeError(
				"unreachable",
				`Judge server is not reachable at ${this.baseUrl}`,
				{ cause: error },
			);
		}

		if (!response.ok) {
			const body: unknown = await response.json().catch(() => undefined);
			const message = messageFromErrorBody(body).slice(0, MAX_ERROR_MESSAGE_LENGTH);
			throw new JudgeError(
				response.status >= 500 ? "server" : "bad_request",
				message || `Local judge responded with HTTP ${response.status}`,
				{ status: response.status },
			);
		}

		const body = (await response.json().catch(() => undefined)) as LocalResponseBody | undefined;
		if (!body || typeof body.answers !== "object" || body.answers === null) {
			throw new JudgeError("invalid_response", "Local judge response has no answers", { status: response.status });
		}

		const metadata = body.providerMetadata?.laya;
		const answers: Record<string, Answer> = {};
		for (const [id, answer] of Object.entries(body.answers)) {
			const signals = metadata?.answers?.[id];
			answers[id] = {
				...answer,
				confidence: unitInterval(signals?.confidence),
				actProbability: unitInterval(signals?.actProbability),
			};
		}

		return {
			answers,
			usage: body.usage,
			modelId: typeof metadata?.model === "string" ? metadata.model : undefined,
			warnings: readWarnings(body.warnings),
		};
	}
}
