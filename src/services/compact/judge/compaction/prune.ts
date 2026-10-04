import type { CallItem, HistoryItem } from "./history.ts";

/** What the judge said about one call. `null` means nobody trusted answered. */
export interface CallVerdict {
	readonly kind: string | null;
	readonly keepResult: number | null;
	readonly keepCall: number | null;
}

/** What code alone can tell about a call. */
export interface CallFacts {
	readonly index: number;
	/** A later call made this output obsolete; the text says how. */
	readonly stale?: string;
	/** Share of the call's own terms (file names, identifiers, patterns) that the live part of the conversation still uses. */
	readonly relevance: number;
}

export interface PruneOptions {
	/** A result scoring below this is pruned. */
	readonly keepThreshold: number;
	/** Results shorter than this are never worth pruning. */
	readonly minChars: number;
	/** Characters of a pruned result that stay. */
	readonly headChars: number;
	/** The serialized history must fit in this many characters; results are pruned lowest score first until it does. */
	readonly targetChars: number;
}

export interface CallPlan {
	readonly index: number;
	readonly action: "keep" | "prune" | "drop";
	readonly score: number;
	readonly reason: string;
}

const PATH_KEYS = ["path", "file_path", "filePath", "file"];
const READ_TOOLS = new Set(["read"]);
const WRITE_TOOLS = new Set(["edit", "write"]);

/** What a result of this kind is usually worth later, when no capable judge has looked at it. */
const PRIOR: Readonly<Record<string, number>> = {
	error: 0.3,
	listing: 0.3,
	log: 0.25,
	content: 0.55,
	data: 0.65,
	other: 0.5,
};

const COMMON = new Set([
	"src",
	"lib",
	"test",
	"tests",
	"index",
	"main",
	"packages",
	"node_modules",
	"dist",
	"build",
	"true",
	"false",
	"null",
	"grep",
	"find",
	"cat",
	"head",
	"tail",
	"echo",
	"bash",
	"read",
	"edit",
	"write",
	"with",
	"from",
	"this",
	"that",
	"the",
	"and",
]);

function pathOf(call: Pick<CallItem, "input">): string | undefined {
	for (const key of PATH_KEYS) {
		const value = call.input[key];
		if (typeof value === "string" && value) return value.replace(/^\.\//, "");
	}
	return undefined;
}

function commandOf(call: Pick<CallItem, "input">): string | undefined {
	const value = call.input.command;
	return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ") : undefined;
}

/** File names, identifiers and search patterns: the words by which later turns would refer back to this call. */
export function termsOf(call: Pick<CallItem, "input">): string[] {
	const terms = new Set<string>();
	for (const value of Object.values(call.input)) {
		if (typeof value !== "string") continue;
		for (const word of value.slice(0, 400).split(/[^\p{L}\p{N}_.-]+/u)) {
			const term = word.replace(/^[.-]+|[.-]+$/g, "").toLowerCase();
			if (term.length >= 3 && !COMMON.has(term) && !/^\d+$/.test(term)) terms.add(term);
		}
	}
	return [...terms].slice(0, 16);
}

export function fallbackKind(call: Pick<CallItem, "tool" | "isError">): string {
	if (call.isError) return "error";
	if (READ_TOOLS.has(call.tool)) return "content";
	if (["grep", "find", "ls", "locate"].includes(call.tool)) return "listing";
	if (call.tool === "bash") return "log";
	if (call.tool === "browse" || call.tool === "delegate") return "data";
	return "other";
}

/**
 * Rules before the judge. A file that was read again or changed since, and a
 * command that was run again since, left output that describes a state of the
 * world that no longer exists. That takes no judgment, and it is exact.
 */
export function analyze(
	items: readonly HistoryItem[],
	live: { readonly text: string; readonly calls: readonly Pick<CallItem, "tool" | "input">[] },
): CallFacts[] {
	const liveText = live.text.toLowerCase();
	const later = (from: number): Pick<CallItem, "tool" | "input">[] => [
		...items.slice(from + 1).filter((item): item is CallItem => item.kind === "call"),
		...live.calls,
	];
	const facts: CallFacts[] = [];
	items.forEach((item, index) => {
		if (item.kind !== "call") return;
		const path = pathOf(item);
		const command = commandOf(item);
		let stale: string | undefined;
		if (path && READ_TOOLS.has(item.tool)) {
			const next = later(index).find(
				(call) => pathOf(call) === path && (READ_TOOLS.has(call.tool) || WRITE_TOOLS.has(call.tool)),
			);
			if (next)
				stale = READ_TOOLS.has(next.tool)
					? "the same file was read again later"
					: "the file was changed after this read";
		} else if (command && later(index).some((call) => commandOf(call) === command)) {
			stale = "the same command was run again later";
		}
		const terms = termsOf(item);
		const used = terms.filter((term) => liveText.includes(term)).length;
		facts.push({ index, stale, relevance: terms.length === 0 ? 0.5 : used / terms.length });
	});
	return facts;
}

/** One number per call: how much its complete output is still worth. */
export function scoreCall(
	call: CallItem,
	facts: CallFacts,
	verdict: CallVerdict | undefined,
): { score: number; reason: string } {
	if (facts.stale) return { score: 0, reason: facts.stale };
	if (verdict?.keepResult !== null && verdict?.keepResult !== undefined) {
		return {
			score: 0.8 * verdict.keepResult + 0.2 * facts.relevance,
			reason: `judge ${verdict.keepResult.toFixed(2)}, relevance ${facts.relevance.toFixed(2)}`,
		};
	}
	const kind = verdict?.kind ?? fallbackKind(call);
	const prior = PRIOR[kind] ?? PRIOR.other;
	return {
		score: 0.6 * prior + 0.4 * facts.relevance,
		reason: `${kind}${verdict?.kind ? "" : " (by tool)"}, relevance ${facts.relevance.toFixed(2)}`,
	};
}

function sizeOf(item: HistoryItem, headChars: number, pruned: boolean): number {
	if (item.kind !== "call") return item.text.length + 16;
	return 120 + (pruned ? Math.min(item.result.length, headChars) : item.result.length);
}

/**
 * Threshold first, budget second: everything below the threshold goes, and if
 * that is not enough the lowest scores follow until the history fits. What
 * people said is never touched, so a history of mostly talk may not fit at all;
 * `fits` says so and the caller falls back to a summary.
 */
export function plan(
	items: readonly HistoryItem[],
	facts: readonly CallFacts[],
	verdicts: ReadonlyMap<number, CallVerdict>,
	options: PruneOptions,
): { plans: CallPlan[]; chars: number; fits: boolean } {
	const plans = new Map<number, CallPlan>();
	for (const fact of facts) {
		const call = items[fact.index] as CallItem;
		const prunable = !call.pinned && call.state === "full" && call.result.length >= options.minChars;
		const { score, reason } = scoreCall(call, fact, verdicts.get(fact.index));
		const verdict = verdicts.get(fact.index);
		// Dropping the call itself takes a capable judge saying so; one line is cheap and "I already ran this" is worth it.
		const forgettable = verdict?.keepCall !== null && verdict?.keepCall !== undefined && verdict.keepCall <= 0.2;
		const action = call.pinned
			? "keep"
			: forgettable && score < options.keepThreshold
				? "drop"
				: prunable && score < options.keepThreshold
					? "prune"
					: "keep";
		plans.set(fact.index, {
			index: fact.index,
			action,
			score,
			reason: call.pinned ? "part of the current turn" : reason,
		});
	}
	const total = () =>
		items.reduce((sum, item, index) => {
			const action = plans.get(index)?.action;
			return action === "drop"
				? sum
				: sum +
						sizeOf(
							item,
							options.headChars,
							action === "prune" || (item.kind === "call" && item.state === "pruned"),
						);
		}, 0);

	let chars = total();
	if (chars > options.targetChars) {
		const candidates = [...plans.values()]
			.filter((entry) => {
				const call = items[entry.index] as CallItem;
				return (
					entry.action === "keep" &&
					!call.pinned &&
					call.state === "full" &&
					call.result.length >= options.minChars
				);
			})
			.sort((a, b) => a.score - b.score || a.index - b.index);
		for (const entry of candidates) {
			if (chars <= options.targetChars) break;
			plans.set(entry.index, { ...entry, action: "prune", reason: `${entry.reason}; pruned to fit the budget` });
			chars = total();
		}
	}
	return { plans: [...plans.values()].sort((a, b) => a.index - b.index), chars, fits: chars <= options.targetChars };
}

/** Carries the plan out. `archive` saves a complete output and returns where, or undefined when it could not. */
export function apply(
	items: readonly HistoryItem[],
	plans: readonly CallPlan[],
	options: Pick<PruneOptions, "headChars">,
	archive: (call: CallItem) => string | undefined,
): HistoryItem[] {
	const byIndex = new Map(plans.map((entry) => [entry.index, entry]));
	const result: HistoryItem[] = [];
	items.forEach((item, index) => {
		const entry = byIndex.get(index);
		if (item.kind !== "call" || !entry || entry.action === "keep") result.push(item);
		else if (entry.action === "prune") {
			result.push({
				...item,
				state: "pruned",
				archive: archive(item),
				result: item.result.slice(0, options.headChars),
			});
		}
	});
	return result;
}
