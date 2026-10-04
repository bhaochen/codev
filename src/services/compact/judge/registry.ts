import { CascadeJudge, type CascadeTier } from "./cascade.ts";
import { BUILT_IN_JUDGES, type JudgeConfig, type KyrnConfig } from "./config.ts";
import { JudgeError } from "./errors.ts";
import { Judge, type JudgeLike } from "./judge.ts";
import { judgeEnv } from "./naming.ts";
import { GatewayJudgeProvider } from "./providers/gateway.ts";
import { LocalJudgeProvider } from "./providers/local.ts";
import { MockJudgeProvider } from "./providers/mock.ts";
import { CLM_DEFAULT_MODEL, clmEndpoint, TypeSafeJudgeProvider } from "./providers/typesafe.ts";
import type { JudgeProvider } from "./types.ts";

/**
 * What the host application supplies to reach a judge: the environment its
 * keys live in, and the `fetch` the providers call with.
 */
export interface JudgeHost {
	env?: Readonly<Record<string, string | undefined>>;
	fetch?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS: Readonly<Record<JudgeConfig["type"], number>> = {
	// Jev answers in well under a second, but a cold connection over a long route can take several.
	jev: 10_000,
	typesafe: 10_000,
	// A CLM server embeds every question together with the state: a batch of long ones takes seconds on a small GPU.
	clm: 8000,
	gateway: 4000,
	local: 4000,
	http: 8000,
	llm: 30_000,
	mock: 1000,
};

/**
 * Keys for a service other than TypeSafe (Jev on OpenRouter, an address of the user's own, a CLM server). Any other
 * variable may hold a TypeSafe key under a name of its own, and goes to TypeSafe when no address is set.
 */
const KEYS_FOR_ELSEWHERE: ReadonlySet<string> = new Set([
	"CODEV_JUDGE_OPENROUTER_API_KEY",
	"CODEV_JUDGE_CUSTOM_API_KEY",
	"CODEV_JUDGE_CLM_API_KEY",
]);

/** `llm:provider/model` names an LLM judge inline, without a `judges` entry. */
export function resolveJudgeConfig(name: string, config: KyrnConfig): JudgeConfig | undefined {
	if (name.startsWith("llm:")) return { type: "llm", model: name.slice("llm:".length) };
	return config.judges[name] ?? BUILT_IN_JUDGES[name];
}

function createProvider(name: string, judge: JudgeConfig, host: JudgeHost): JudgeProvider {
	switch (judge.type) {
		case "mock":
			return new MockJudgeProvider();
		case "local":
			return new LocalJudgeProvider({
				baseUrl: judge.baseUrl ?? judgeEnv("LOCAL_JUDGE_URL", host.env ?? {}),
				fetch: host.fetch,
			});
		case "http": {
			const apiKeyEnv = judge.apiKeyEnv;
			return new LocalJudgeProvider({
				id: `http:${name}`,
				baseUrl: judge.baseUrl,
				path: judge.path,
				headers: (): Record<string, string> => {
					const token = apiKeyEnv ? host.env?.[apiKeyEnv] : undefined;
					return token ? { Authorization: `Bearer ${token}` } : {};
				},
				fetch: host.fetch,
			});
		}
		case "llm":
			// codev's compaction integration reaches judges over System One; a generative model would need the host's
			// model registry wired in, which it does not have.
			throw new TypeError(`Judge "${name}": llm judges are not wired in codev's compaction`);
		case "typesafe": {
			const keyName = judge.apiKeyEnv ?? "TYPESAFE_API_KEY";
			// A key set up for another service goes only to the address it was set up with, never to TypeSafe's.
			if (KEYS_FOR_ELSEWHERE.has(keyName) && !judge.baseUrl) {
				throw new TypeError(`Judge "${name}" needs a baseUrl: its key ${keyName} is not sent to TypeSafe`);
			}
			return new TypeSafeJudgeProvider({
				apiKey: () => host.env?.[keyName],
				keyName,
				model: judge.model,
				baseUrl: judge.baseUrl,
				fetch: host.fetch,
			});
		}
		case "clm": {
			// `clm-serve` asks for a key only when it was started with CLM_API_KEY; without one set here, none is sent.
			const keyName = judge.apiKeyEnv ?? "CODEV_JUDGE_CLM_API_KEY";
			return new TypeSafeJudgeProvider({
				apiKey: () => host.env?.[keyName],
				keyName,
				keyOptional: true,
				judgeName: "CLM",
				model: judge.model || CLM_DEFAULT_MODEL,
				baseUrl: clmEndpoint(judge.baseUrl),
				fetch: host.fetch,
			});
		}
		case "jev": {
			// A TypeSafe key is the direct route, a key for Jev on OpenRouter the next; without either, Jev is reached
			// through the Vercel AI Gateway. Each service names the model its own way: a model set here is TypeSafe's
			// ("jev-latest"), and reaches the gateway only when it is written the gateway's way ("typesafe-ai/jev").
			if (host.env?.[judge.apiKeyEnv ?? "TYPESAFE_API_KEY"])
				return createProvider(name, { ...judge, type: "typesafe" }, host);
			const openRouter = BUILT_IN_JUDGES["jev-openrouter"];
			if (openRouter.apiKeyEnv && host.env?.[openRouter.apiKeyEnv]) return createProvider(name, openRouter, host);
			const model = judge.model?.includes("/") ? judge.model : "typesafe-ai/jev";
			return createProvider(name, { ...judge, type: "gateway", model }, host);
		}
		default:
			return new GatewayJudgeProvider({
				apiKey: judge.apiKeyEnv ? () => host.env?.[judge.apiKeyEnv!] : (() => host.env?.AI_GATEWAY_API_KEY),
				model: judge.model,
				baseUrl: judge.baseUrl,
				fetch: host.fetch,
			});
	}
}

export interface BuiltJudge {
	readonly judge: JudgeLike;
	/** Tiers that could not be created, with the reason. The cascade runs without them. */
	readonly problems: readonly string[];
}

/** The configured tiers as one judge. Unknown or unavailable tiers are reported, not fatal. */
export function buildJudge(config: KyrnConfig, host: JudgeHost = {}): BuiltJudge {
	const tiers: CascadeTier[] = [];
	const problems: string[] = [];
	for (const name of config.tiers) {
		const judgeConfig = resolveJudgeConfig(name, config);
		if (!judgeConfig) {
			problems.push(`unknown judge "${name}"`);
			continue;
		}
		try {
			const provider = createProvider(name, judgeConfig, host);
			const timeoutMs = judgeConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS[judgeConfig.type];
			tiers.push({ judge: new Judge({ provider, timeoutMs }), profile: judgeConfig.profile });
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (tiers.length === 0) {
		problems.push("no usable judge; every decision falls back");
		tiers.push({ judge: new Judge({ provider: new UnavailableJudgeProvider() }) });
	}
	return { judge: new CascadeJudge(tiers), problems };
}

/** No judge at all fails as a judge without a key does: nothing answers until the user sets one up. */
class UnavailableJudgeProvider implements JudgeProvider {
	readonly id = "none";
	async evaluate(): Promise<never> {
		throw new JudgeError("auth", "No judge is configured");
	}
}
