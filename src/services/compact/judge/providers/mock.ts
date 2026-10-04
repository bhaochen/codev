import { neutralAnswer } from "../policy.ts";
import type { Answer, JudgeProvider, JudgeRequest, ProviderResponse } from "../types.ts";

export { neutralAnswer };

export type MockResponder = (
	request: JudgeRequest,
) => Readonly<Record<string, Answer>> | Promise<Readonly<Record<string, Answer>>>;

/**
 * Deterministic judge for tests and offline development.
 *
 * Without a responder every answer is neutral, so decisions abstain and the
 * caller's fallback path runs. Partial responders are filled with neutral answers.
 */
export class MockJudgeProvider implements JudgeProvider {
	readonly id: string;
	readonly calls: JudgeRequest[] = [];
	private readonly responder: MockResponder | undefined;

	constructor(responder?: MockResponder, id = "mock") {
		this.responder = responder;
		this.id = id;
	}

	async evaluate(request: JudgeRequest): Promise<ProviderResponse> {
		this.calls.push(request);
		const scripted = this.responder ? await this.responder(request) : {};
		const answers: Record<string, Answer> = {};
		for (const [id, question] of Object.entries(request.questions)) {
			answers[id] = scripted[id] ?? neutralAnswer(question);
		}
		return { answers, usage: { inputTokens: 0, outputTokens: 0 }, modelId: "mock" };
	}
}
