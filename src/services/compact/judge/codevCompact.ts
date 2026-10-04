import type { Message } from '../../../types/message.js'
import type { DecisionEngine } from './decision.ts'
import type { JudgeLike } from './judge.ts'
import type { LedgerSink } from './ledger.ts'
import { contextCompact, type CompactCallInput } from './decisions/context-compact.ts'
import { analyze, plan, apply, type CallVerdict, type PruneOptions } from './compaction/prune.ts'
import { serializeHistory, type HistoryItem, type CallItem } from './compaction/history.ts'
import { codevMessagesToHistoryItems } from './codevHistory.ts'

/**
 * Options for the codev compaction feature.
 */
export interface CodevCompactOptions {
	/** The decision engine that runs the judge. */
	readonly engine: DecisionEngine
	/** The model's context window in characters; the budget never exceeds `maxWindowShare` of it. */
	readonly contextWindow: number
	/** Minimum result length to be worth pruning. */
	readonly minChars: number
	/** Characters of a pruned result that stay. */
	readonly headChars: number
	/** Keep threshold: results scoring below this are pruned. */
	readonly keepThreshold: number
	/** The pruned history may take this share of what it replaces. */
	readonly targetRatio: number
	/** ...and at most this share of the model's context window. */
	readonly maxWindowShare: number
	/** Histories up to this size are never squeezed by the budget, only by the threshold. */
	readonly freeChars: number
	/** At most this many calls are asked about, largest results first. */
	readonly maxJudged: number
	/** Archive function: saves a complete output and returns where, or undefined. */
	readonly archive?: (call: CallItem) => string | undefined
	/** Abort signal. */
	readonly signal?: AbortSignal
}

/**
 * Result of a successful compaction.
 */
export interface CodevCompactResult {
	/** The serialized history text that replaces the compacted messages. */
	readonly historyText: string
	/** The pruned history items (for inspection/testing). */
	readonly items: readonly HistoryItem[]
	/** The plans (for inspection/testing). */
	readonly plans: readonly { index: number; action: string; score: number; reason: string }[]
	/** Total characters after pruning. */
	readonly chars: number
	/** Whether the history fits within the target budget. */
	readonly fits: boolean
	/** Number of calls that were pruned. */
	readonly prunedCount: number
	/** Number of calls that were dropped. */
	readonly droppedCount: number
}

/**
 * Tries to compact messages using the `context.compact` decision.
 *
 * The algorithm:
 * 1. Convert codev messages to history items
 * 2. Run `analyze()` to detect staleness and compute lexical relevance
 * 3. Ask the judge about each call (kind, result_needed, call_matters)
 * 4. Run `plan()` to get keep/prune/drop decisions
 * 5. Run `apply()` to produce pruned history
 * 6. Serialize the pruned history to text
 *
 * Returns null when:
 * - There are no tool calls to prune
 * - The judge is unavailable and no calls are stale
 * - The pruned history doesn't fit the budget (caller should fallback to LLM summary)
 */
export async function tryCodevCompact(
	messages: readonly Message[],
	options: CodevCompactOptions,
): Promise<CodevCompactResult | null> {
	const items = codevMessagesToHistoryItems(messages)
	const calls = items.filter((item): item is CallItem => item.kind === 'call')

	// No tool calls to prune — let the LLM summary handle it
	if (calls.length === 0) return null

	// What relevance is measured against: everything that was said. codev compacts the whole conversation, so
	// there is no kept tail to measure against — and passing the calls themselves as "later calls" would make every
	// call look like it was read again since (it would match itself).
	const liveText = items
		.flatMap((item) => {
			if (item.kind === 'call') return []
			return [(item as { text: string }).text]
		})
		.join('\n')

	// Step 1: Analyze — detect staleness and compute relevance
	const facts = analyze(items, { text: liveText, calls: [] })

	// The budget: never squeeze a small history, and never ask for more than the window allows.
	const before = serializeHistory(items).length
	const targetChars = Math.min(
		options.contextWindow * options.maxWindowShare,
		Math.max(before * options.targetRatio, Math.min(before, options.freeChars)),
	)

	// Step 2: Ask the judge about the calls worth asking about — stale ones go by rule, and a long
	// history judges its largest results first, where the tokens buy the most.
	const goal = extractGoal(items)
	const judged = facts
		.filter((fact) => {
			const call = items[fact.index] as CallItem
			return !fact.stale && call.state === "full" && call.result.length >= options.minChars
		})
		.sort((a, b) => (items[b.index] as CallItem).result.length - (items[a.index] as CallItem).result.length)
		.slice(0, options.maxJudged)

	const verdicts = new Map<number, CallVerdict>()
	for (const fact of judged) {
		const call = items[fact.index] as CallItem
		const input: CompactCallInput = {
			goal,
			call: describeCall(call),
			resultHead: call.result.slice(0, 600),
			resultChars: call.resultChars,
			isError: call.isError,
			since: facts.slice(fact.index + 1).map((f) => {
				const c = items[f.index] as CallItem
				return `${c.tool}(${Object.keys(c.input).join(',')})`
			}),
		}
		const decision = await options.engine.decide(contextCompact, input, {
			signal: options.signal,
		})
		// The judge scores whatever the mode: in shadow the plan is only reported, never applied.
		const verdict = decision.judged ?? decision.outcome
		verdicts.set(fact.index, {
			kind: verdict.kind,
			keepResult: verdict.keepResult,
			keepCall: verdict.keepCall,
		})
	}

	// Step 3: Plan — get keep/prune/drop decisions
	const pruneOptions: PruneOptions = {
		keepThreshold: options.keepThreshold,
		minChars: options.minChars,
		headChars: options.headChars,
		targetChars,
	}
	const { plans, chars, fits } = plan(items, facts, verdicts, pruneOptions)

	// If nothing was pruned, no point in using this result
	const prunedCount = plans.filter((p) => p.action === 'prune').length
	const droppedCount = plans.filter((p) => p.action === 'drop').length
	if (prunedCount === 0 && droppedCount === 0) return null
	// What people said alone is over the budget. Nothing said is ever pruned, so a history that still does not fit
	// is not a smaller history — it is the same work for less. The caller's summary can say it in a sentence.
	if (!fits) return null

	// Step 4: Apply — produce pruned history
	const prunedItems = apply(items, plans, { headChars: options.headChars }, options.archive ?? (() => undefined))

	// Step 5: Serialize
	const historyText = serializeHistory(prunedItems)

	return {
		historyText,
		items: prunedItems,
		plans,
		chars,
		fits,
		prunedCount,
		droppedCount,
	}
}

/**
 * Extracts the user's goal from the most recent user messages.
 * Used as the `goal` field in CompactCallInput.
 */
function extractGoal(items: readonly HistoryItem[]): string {
	const userTexts = items
		.filter((item): item is Extract<HistoryItem, { text: string }> => item.kind === 'user')
		.map((item) => item.text)
		.slice(-3)
		.join('\n')
	return userTexts.slice(0, 500)
}

/**
 * Describes a call on one line for the judge.
 */
function describeCall(call: CallItem): string {
	const args = Object.entries(call.input)
		.map(([key, value]) => {
			const text = typeof value === 'string' ? value : JSON.stringify(value)
			const flat = (text ?? '').replace(/\s+/g, ' ')
			return `${key}=${flat.length > 160 ? `${flat.slice(0, 160)}…` : flat}`
		})
		.join(' ')
	return args ? `${call.tool} ${args}` : call.tool
}
