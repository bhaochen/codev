import { getSettingsForSource } from "../../../utils/settings/settings.js";
import type { JudgeProfile } from "./cascade.ts";
import type { DecisionMode } from "./decision.ts";
import { judgeEnv, judgeTiersEnv } from "./naming.ts";

/**
 * How one judge is reached. The decision points never see this: they ask
 * typed questions, and whichever model is configured here answers them.
 *
 * - `gateway`: a judge model behind the Vercel AI Gateway (Jev).
 * - `clm`:     CLM-8B behind `clm-serve`, which answers the same questions Jev does.
 * - `local`:   the Laya sidecar, at `CODEV_JUDGE_LOCAL_JUDGE_URL` or its default address.
 * - `http`:    any endpoint that takes `{state, questions}` and returns `{answers}`.
 * - `llm`:     a generative model from the host's model registry, prompted to answer as JSON.
 * - `mock`:    neutral answers, for tests and offline work.
 */
export interface JudgeConfig {
	/**
	 * `jev` is Jev by whichever access this machine has: TypeSafe directly when TYPESAFE_API_KEY is set, else
	 * OpenRouter when CODEV_JUDGE_OPENROUTER_API_KEY is set, else the Vercel AI Gateway. `typesafe` is Jev over
	 * System One at `baseUrl` (TypeSafe's own, OpenRouter's, a relay's), `gateway` through the Vercel AI Gateway.
	 * `clm` is CLM-8B (github.com/Contrastive-LM/CLM) at the address of a `clm-serve`, which speaks System One too.
	 */
	readonly type: "jev" | "typesafe" | "clm" | "gateway" | "local" | "http" | "llm" | "mock";
	/** jev, typesafe, gateway: judge model id. clm: a model the server serves, default "clm-latest". llm: "provider/model-id". */
	readonly model?: string;
	/**
	 * gateway, local, http, clm, and the System One route (`typesafe`, or `jev` when a TypeSafe key is set).
	 * For System One this is the endpoint URL; empty uses TypeSafe's own. For clm, the server's address
	 * (`http://host:8700` is enough); empty is http://127.0.0.1:8700.
	 */
	readonly baseUrl?: string;
	/** http: request path, default "/evaluate". */
	readonly path?: string;
	/**
	 * http, typesafe, clm: name of the environment variable holding a bearer token. The token itself never goes in the
	 * file. A typesafe judge keyed by CODEV_JUDGE_OPENROUTER_API_KEY, CODEV_JUDGE_CUSTOM_API_KEY or
	 * CODEV_JUDGE_CLM_API_KEY needs its own `baseUrl`: those keys belong to another service and never go to
	 * TypeSafe. clm reads CODEV_JUDGE_CLM_API_KEY unless told otherwise, and calls without a key when it is not set:
	 * a CLM server asks for one only when it was started with CLM_API_KEY.
	 */
	readonly apiKeyEnv?: string;
	/** llm: thinking level for the judge model, default "off". */
	readonly thinking?: string;
	readonly timeoutMs?: number;
	readonly profile?: JudgeProfile;
}

export interface KyrnConfig {
	/** Judges tried in order; each later one only sees what the earlier ones left uncertain. */
	readonly tiers: readonly string[];
	/** Named judges, merged over the built-in ones (`jev` and its routes, `clm`, `laya`, `mock`). */
	readonly judges: Readonly<Record<string, JudgeConfig>>;
	/** `default` plus per-decision overrides keyed by spec id. */
	readonly modes: Readonly<Record<string, DecisionMode>>;
	/**
	 * Decision id -> its own tiers, for a decision point that needs another judge than the rest,
	 * e.g. `{ "browser.step": ["luna"] }` while everything else runs on a small local model.
	 */
	readonly routes: Readonly<Record<string, readonly string[]>>;
	/** Per-feature switches and options, read by each feature. */
	readonly features: Readonly<Record<string, unknown>>;
	/** "provider/model-id" of a small generative model for the things a judge cannot do: task frames, lessons. */
	readonly writer?: string;
	/** Store judged states in the ledger (needed to distil a local judge). Off by default: states hold user content. */
	readonly recordState: boolean;
}

export const BUILT_IN_JUDGES: Readonly<Record<string, JudgeConfig>> = {
	jev: { type: "jev" },
	"jev-direct": { type: "typesafe" },
	// OpenRouter serves Jev over the same System One protocol. The key is Jev's own, not the one for OpenRouter's
	// chat models, so setting one never changes the other.
	"jev-openrouter": {
		type: "typesafe",
		baseUrl: "https://openrouter.ai/api/v1/systemone",
		model: "~typesafe/jev-latest",
		apiKeyEnv: "CODEV_JUDGE_OPENROUTER_API_KEY",
	},
	"jev-gateway": { type: "gateway", model: "typesafe-ai/jev" },
	// CLM-8B on this machine, where `clm-serve` listens by default. Its profile is not measured on these questions yet.
	clm: { type: "clm" },
	// Measured: the base Laya checkpoint classifies one text well, says "yes" to
	// nearly every relational question, and cannot use a rubric or judge the request itself.
	laya: { type: "local", profile: { capabilities: { relate: false, rate: false, meta: false } } },
	mock: { type: "mock" },
};

export const DEFAULT_CONFIG: KyrnConfig = {
	tiers: ["jev"],
	judges: {},
	modes: { default: "shadow" },
	routes: {},
	features: {},
	recordState: false,
};

const MODES: readonly string[] = ["off", "shadow", "active"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModes(value: unknown): Record<string, DecisionMode> {
	const modes: Record<string, DecisionMode> = {};
	if (!isRecord(value)) return modes;
	for (const [specId, mode] of Object.entries(value)) {
		if (typeof mode === "string" && MODES.includes(mode)) modes[specId] = mode as DecisionMode;
	}
	return modes;
}

function readTiers(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return raw
		.filter((tier): tier is string => typeof tier === "string")
		.map((tier) => tier.trim())
		.filter(Boolean);
}

function readRoutes(value: unknown): Record<string, readonly string[]> {
	const routes: Record<string, readonly string[]> = {};
	if (!isRecord(value)) return routes;
	for (const [specId, tiers] of Object.entries(value)) {
		const parsed = readTiers(tiers);
		if (parsed.length > 0) routes[specId] = parsed;
	}
	return routes;
}

function readJudges(value: unknown): Record<string, JudgeConfig> {
	const judges: Record<string, JudgeConfig> = {};
	if (!isRecord(value)) return judges;
	for (const [name, config] of Object.entries(value)) {
		if (!isRecord(config) || typeof config.type !== "string") continue;
		if (!["jev", "typesafe", "clm", "gateway", "local", "http", "llm", "mock"].includes(config.type)) continue;
		judges[name] = config as unknown as JudgeConfig;
	}
	return judges;
}

/** Parses the `judge` key of `settings.json`. Unknown or malformed parts fall back to defaults instead of throwing. */
export function parseConfig(value: unknown): KyrnConfig {
	if (!isRecord(value)) return DEFAULT_CONFIG;
	const tiers = Array.isArray(value.tiers)
		? value.tiers.filter((tier): tier is string => typeof tier === "string")
		: [];
	return {
		tiers: tiers.length > 0 ? tiers : DEFAULT_CONFIG.tiers,
		judges: readJudges(value.judges),
		modes: { ...DEFAULT_CONFIG.modes, ...readModes(value.modes) },
		routes: readRoutes(value.routes),
		features: isRecord(value.features) ? value.features : {},
		writer: typeof value.writer === "string" ? value.writer : undefined,
		recordState: value.recordState === true,
	};
}

export interface ConfigSource {
	/** Overrides reading settings.json, for tests. */
	readonly settings?: unknown;
	readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * The `judge` key of `~/.claude/settings.json`, then environment overrides:
 *   CODEV_JUDGE        comma-separated tiers, e.g. "local" or "local,jev"; "off" disables the kernel
 *   CODEV_JUDGE_MODE   default mode for every decision
 *
 * Only trusted sources are read — user, local, flag and policy settings, never the project's.
 * A project must not be able to point the judge, which sees user messages, at an endpoint of its choosing.
 */
export function loadConfig(source: ConfigSource = {}): { config: KyrnConfig; disabled: boolean; problem?: string } {
	const env = source.env ?? process.env;
	let config = DEFAULT_CONFIG;
	let problem: string | undefined;
	if (source.settings !== undefined) {
		config = parseConfig(source.settings);
	} else {
		try {
			config = parseConfig(readJudgeSettings());
		} catch (error) {
			problem = `settings.json could not be read: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	const judge = judgeTiersEnv(env)?.trim();
	if (judge === "off") return { config, disabled: true, problem };
	if (judge) {
		const tiers = judge.split(",").map((tier) => tier.trim());
		config = { ...config, tiers: tiers.filter(Boolean) };
	}
	const mode = judgeEnv("MODE", env);
	if (mode && MODES.includes(mode)) config = { ...config, modes: { ...config.modes, default: mode as DecisionMode } };
	const writer = judgeEnv("WRITER", env);
	if (writer) config = { ...config, writer };
	return { config, disabled: false, problem };
}

/**
 * The `judge` object out of the settings sources that a person controls. `projectSettings` is left out on purpose:
 * a repository that could redirect the judge would be reading the user's messages somewhere of its own choosing.
 */
function readJudgeSettings(): unknown {
	let merged: Record<string, unknown> = {};
	for (const source of ["userSettings", "localSettings", "flagSettings", "policySettings"] as const) {
		const settings = getSettingsForSource(source) as Record<string, unknown> | null;
		const judge = settings?.judge;
		if (judge && typeof judge === "object") merged = { ...merged, ...judge };
	}
	return merged;
}

/** A feature's options: its defaults, overridden by `features.<name>` when that is an object; `false` disables it. */
export function featureOptions<T extends { enabled: boolean }>(config: KyrnConfig, name: string, defaults: T): T {
	const value = config.features[name];
	if (value === false) return { ...defaults, enabled: false };
	if (value === true) return { ...defaults, enabled: true };
	if (isRecord(value)) return { ...defaults, ...value } as T;
	return defaults;
}
