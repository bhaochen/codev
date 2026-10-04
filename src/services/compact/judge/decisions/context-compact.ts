import { defineDecision } from "../decision.ts";
import type { AnswerSignals } from "../types.ts";

/**
 * E1, compaction without a summary: when the context fills up, every old tool
 * call is scored and only the output that is still worth its tokens stays,
 * word for word. Nothing anyone said is rewritten, so nothing is lost to a
 * paraphrase: a path, an exact error, a constraint.
 *
 * The idea of replacing the compaction summary with keep/drop decisions about
 * tool calls follows tamaratran/fast-jev-compaction (MIT). This version asks
 * about one call at a time with a small state, so a judge with a 1K window can
 * do it, and it puts rules and a lexical relevance match in front of the judge.
 */
export interface CompactCallInput {
	/** What the user is after, from their latest messages. */
	readonly goal: string;
	/** `bash command="npm test"`. */
	readonly call: string;
	/** The beginning of the output. */
	readonly resultHead: string;
	readonly resultChars: number;
	readonly isError: boolean;
	/** What is known to have happened since, e.g. "12 more tool calls". */
	readonly since: readonly string[];
}

export type CompactCallOutcome = {
	readonly kind: string | null;
	readonly keepResult: number | null;
	readonly keepCall: number | null;
};

const answered = (answer: AnswerSignals | undefined): boolean =>
	answer !== undefined && answer.judge !== "untrusted" && answer.judge !== "unavailable";

export const contextCompact = defineDecision({
	id: "context.compact",
	version: 1,
	// It rewrites the prefix, but only at a compaction, where the cache is lost anyway.
	cacheImpact: "prefix-mutating",
	latency: "background",
	// A small judge can say what a piece of output is; whether it is still needed takes a stronger one.
	capabilities: { kind: "classify", result_needed: "relate", call_matters: "relate" },
	questions: {
		kind: {
			type: "choice",
			instructions: "What is `result`?",
			criteria: {
				error: "An error or failure message",
				listing: "File names or search matches",
				content: "Source code or document text",
				log: "Build, test or progress output",
				data: "Facts or values looked up for the task",
				other: "Something else",
			},
		},
		result_needed: { type: "boolean", instructions: "Is the full text of `result` still needed to finish `goal`?" },
		call_matters: { type: "boolean", instructions: "Does it still matter for `goal` that `call` was made?" },
	},
	// Decisive content first: a judge with a bounded window keeps the head of the state.
	buildState(input: CompactCallInput) {
		return {
			result: input.resultHead,
			call: input.call,
			goal: input.goal,
			result_chars: input.resultChars,
			failed: input.isError,
			since: input.since,
		};
	},
	policy(answers): CompactCallOutcome {
		const { kind, result_needed: needed, call_matters: matters } = answers;
		const picked = answered(kind) && kind.choice !== "other" && (kind.probabilities?.[kind.choice] ?? 1) >= 0.5;
		return {
			kind: picked ? kind.choice : null,
			keepResult: answered(needed) ? needed.probability : null,
			keepCall: answered(matters) ? matters.probability : null,
		};
	},
	fallback(): CompactCallOutcome {
		return { kind: null, keepResult: null, keepCall: null };
	},
});
