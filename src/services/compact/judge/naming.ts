type Env = Readonly<Record<string, string | undefined>>

/**
 * Names the judge kernel is configured under, all of them codev's own.
 *
 * The judge is reached over the same protocols whatever it is called, so nothing here depends on another tool:
 * a judge is named `CODEV_JUDGE_*` in the environment and configured under `judge` in `~/.claude/settings.json`.
 */

const PREFIX = "CODEV_JUDGE";

/** `CODEV_JUDGE` itself, the bare name: which tiers run, or "off" to run none. */
export function judgeTiersEnv(env: Env = process.env): string | undefined {
	return env[PREFIX] || undefined;
}

/** `CODEV_JUDGE_<name>`, the only spelling: there is no earlier name to keep working. */
export function judgeEnv(name: string, env: Env = process.env): string | undefined {
	return env[`${PREFIX}_${name}`] || undefined;
}
