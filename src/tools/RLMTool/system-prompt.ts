/**
 * RLM system prompt — tells the root model how to interact with the REPL.
 *
 * Ported from rlm.pi/pi-plugin/rlm/src/prompts/system.ts + glossary.ts, simplified for
 * codev: no state splice beyond the engine's Σ turn blocks / delegation surfaces.
 */

import type { ContextSizeStats } from './tokens.js'

const DEFAULT_PROMPT_CAP = 400_000

function promptCapTokensK(maxPromptChars: number): number {
  return Math.round(maxPromptChars / 4_000)
}

type ContextKind = 'files' | 'text'

function contextKindOf(contextType: string): ContextKind {
  return contextType === 'str' ? 'text' : 'files'
}

interface PromptMeta {
  readonly contextType: string
  readonly contextChars: number
  readonly contextStats?: ContextSizeStats
  readonly rootPrompt?: string
}

interface SystemPromptOptions {
  readonly orchestrator?: boolean
  readonly recursion?: boolean
  readonly maxPromptChars?: number
  readonly child?: boolean
  readonly depth?: number
  readonly delegation?: boolean
}

const INTRO =
  'You are a Recursive Language Model (RLM): a language model with a prompt and a very important ' +
  'context stored in a Python REPL. You interact with the REPL turn-by-turn until you have an answer.'

function howToRunCode(): string {
  return (
    'To run Python, write a fenced ```repl``` block. The REPL **persists** across turns. Only ' +
    '`print(...)` output (stdout) is returned; a bare expression on the last line is discarded, so ' +
    'always wrap inspections in `print(...)`.'
  )
}

const RETRIEVAL_GLOSSARY = [
  '- `search(query: str, k=10, path_glob=None)`: BM25 ranking over `context`. Returns',
  '  [{path, line, score, snippet, text}] — POINTERS, not bodies (`text` aliases `snippet`).',
  '  **Start here.** Free: no sub-LLM call. Use before guessing filenames.',
  '- `grep_context(pattern, k=50, path_glob=None, before=0, after=0) -> dict`: regex over',
  '  `context`. Returns {hits: [{path, line, text, snippet}], counts, total, truncated} —',
  '  `counts` is complete even when `hits` is capped, so a wide pattern reports its shape',
  '  instead of flooding you. Use for exact lexical needles; use `search` for meaning.',
  '- `outline(path) -> str`: definition/heading skeleton of one file with line numbers.',
  '  Orient in ~200 chars instead of printing 20K. Matches exact path, then suffix, then glob.',
].join('\n')

const DELEGATION_SURFACE = [
  '- **No `search` / `grep_context` / `outline` in this REPL** (delegation',
  '  surface): your task arrived WITH its world in `context`. Explore it with',
  '  Python (list comprehensions, string matching, slicing) and delegate slices to sub-LLMs —',
  '  never re-ask the parent for retrieval.',
].join('\n')

const SPAWN_GLOSSARY = [
  '- **ALWAYS SPAWN (Task + ↗bg):** `llm_query` / `llm_batch` / `rlm_query` / `rlm_batch` /',
  '  `map_files` / `llm_query_chunked`. Never treat the return as the answer.',
  '  Collect with `await_task(t)`, `await_task([t1,t2,…])`, or `await_task()` (every still-running Task).',
  '  If `await_task` returns `Error: sub-call still running`, call it again — do not respawn.',
].join('\n')

const CHUNKED_GLOSSARY = [
  '- `llm_query_chunked(text: str, prompt: str) -> Task`: always spawn. `await_task(t)` → list[str]',
  '  (one answer per chunk, order preserved). Auto-splits text to the sub-LLM prompt cap.',
  '  Use for ANY text too large for a single `llm_query`.',
].join('\n')

const DELEGATION_GLOSSARY = [
  '- `map_files(files, prompt) -> Task`: always spawn. `await_task(t)` → dict[path, answer].',
  '  Accepts context entries or paths; packs into cap-sized batches; splits oversized files.',
  '  **Default way to read many files** — fire independent `map_files` Tasks, free work, then await.',
  '- `llm_map_reduce(items, map_prompt, reduce_prompt) -> str`: **blocks** (map then reduce).',
].join('\n')

const SPAWN_EXAMPLE_RETRIEVAL = [
  '',
  '  ```python',
  '  # Multi-area study: one rlm_batch (parallel workers), free locate, then await',
  '  t = rlm_batch([',
  '      "Study module A — NO edits. Paths + symbols for X.",',
  '      "Study module B — NO edits. Report how Y is configured.",',
  '  ])',
  '  hits = search("X OR Y", k=10)',
  '  reports = await_task(t)',
  '  ```',
].join('\n')

const SPAWN_EXAMPLE_DELEGATION = [
  '',
  '  ```python',
  '  # Multi-area study: one rlm_batch (parallel workers), slice your world while they run',
  '  t = rlm_batch([',
  '      "Answer from the FIRST half of the context only: paths + symbols for X.",',
  '      "Answer from the SECOND half only: report how Y is configured.",',
  '  ])',
  '  half = [f["path"] for f in context[:len(context)//2]]',
  '  reports = await_task(t)',
  '  ```',
].join('\n')

const RECURSION_LINES = [
  '',
  '  **What a child sees:** it inherits YOUR `context` — every file you have loaded.',
  '  So send instructions, never file bodies: pasting content you already',
  '  share costs your tokens twice and buys nothing. Your prompt becomes the child\'s question.',
  '  Narrow its world with `rlm_query(prompt, paths=[\'src/auth/\'])` — path PREFIXES, not globs.',
  '  Omit `paths` to hand over everything.',
  '  Inheritance is one-way: the child\'s whole REPL dies with it — only its',
  '  final answer string returns. The child cannot write to your `answers` or `plan`.',
  '  At the depth cap `rlm_query` degrades to a plain sub-LLM call with NO context.',
].join('\n')

const RECURSION_DELEGATION_LINES = [
  '',
  '  **What a child sees:** it inherits YOUR `context` (narrowed by `paths=` when given) and works',
  '  on it as text — it has NO retrieval tools, so put what matters in your prompt and `paths`,',
  '  never file bodies you already share.',
  '  Inheritance is one-way: the child\'s whole REPL dies with it — only its',
  '  final answer string returns.',
  '  At the depth cap `rlm_query` degrades to a plain sub-LLM call with NO context.',
].join('\n')

const DECOMPOSITION_DOCTRINE = [
  '## Decomposition doctrine',
  '',
  '**Orchestrate; don\'t solve.** A single chain of thought over a large repository drifts —',
  'you lose partials and compound mistakes. Sub-workers are competent: trust them.',
  '',
  'Your job: (1) free locate with `search` / `grep_context` / `outline`,',
  '(2) fan out: **multi-step areas → `rlm_batch` / `rlm_query`**; one-shot extracts →',
  '  `map_files` / `llm_batch` (all return Task — `await_task` for content),',
  '(3) memoize into `answers`, (4) sanity-check before dependents, (5) assemble from `answers`.',
  'Your own compute is: pointers, dict lookups, string formatting, and decisions.',
  '',
  '### The only state that matters',
  '`answers` and `plan` are dicts that persist across every turn.',
  '**If a result isn\'t in `answers`, you have not memoized it.** Task handles are REPL vars.',
  '',
  '### Shape of a run',
  '1. Probe: `print(len(context))`; locate targets with `search`.',
  '2. Plan: sub-questions into `plan`.',
  '3. Fan out **in parallel**: one `rlm_batch` for independent multi-step studies.',
  '4. Assemble from `answers`.',
].join('\n')

function orchestratorAddendum(maxPromptChars: number): string {
  return [
    'As an RLM you are an **orchestrator, not a solver**. Probe `context`, plan decomposition, then',
    'fan out — do not solve multi-step module work yourself in a long chain of thought.',
    '',
    '<contract> llm_query / llm_batch / map_files / rlm_query / rlm_batch return Task (not the answer).',
    'Only await_task returns content. Fire independent Tasks first, then await_task.',
    'Do not await after every independent spawn.</contract>',
    '',
    `<Sub-call budget: (1) per-prompt < ${maxPromptChars.toLocaleString()} chars (≈${promptCapTokensK(maxPromptChars)}K tok).`,
    'Reserve your tokens for planning, combining, and finalizing.',
  ].join('\n')
}

const LARGE_FILE_RULE = [
  '**Large on-disk files (profiles, logs, dumps, generated JSON):** files >1MB are',
  'absent from `context`. Protocol:',
  '1. Load in Python: `raw = open("dhat-heap.json").read()` — loading into a variable is fine.',
  '2. Deterministic processing in Python (`json.load`, `re`, counting, aggregation) is fine.',
  '3. The moment you need MEANING from raw text, call `llm_query_chunked(raw, question)`.',
].join('\n')

const CONTEXT_EXCLUSION_NOTE = [
  '  NOTE: `context` holds only the files you have loaded (starts empty; cwd seeds on first use).',
  '  Gitignored files and files larger than 1MB are skipped.',
].join('\n')

function replGlossary(kind: ContextKind, recursion: boolean, child: boolean, delegation: boolean): string {
  const lines: string[] = ['Available in the REPL:']
  if (kind === 'text') {
    lines.push(
      '- `context`: str — the raw text you must analyze. Probe with slices',
      '  (`print(context[:2000])`), split it, delegate large chunks.',
    )
  } else {
    lines.push(
      '- `context`: list[dict] — the files you have loaded (starts empty; cwd seeds on first use).',
      '  Each dict has keys: `path` (str), `content` (str), `tokens` (int).',
      '  Cwd paths are un-prefixed. For large sets, chunk and delegate.',
      CONTEXT_EXCLUSION_NOTE,
    )
    if (child) {
      lines.push(
        '  You are a sub-RLM. This `context` is your parent\'s world — every file it has loaded.',
        '  Answer only the question above; your REPL dies with you, only your final answer returns.',
      )
    }
    if (delegation) {
      lines.push(...DELEGATION_SURFACE)
    } else {
      lines.push(RETRIEVAL_GLOSSARY)
    }
  }
  lines.push(
    '- `llm_query(prompt: str) -> Task`: spawn one sub-LLM (await_task for str).',
    '- `llm_batch(prompts: list[str]) -> Task`: many parallel one-shots (await_task → list[str]).',
    CHUNKED_GLOSSARY,
    SPAWN_GLOSSARY,
  )
  if (delegation) {
    lines.push(SPAWN_EXAMPLE_DELEGATION)
  } else {
    lines.push(SPAWN_EXAMPLE_RETRIEVAL)
  }
  lines.push(DELEGATION_GLOSSARY)
  if (recursion) {
    lines.push(
      '- `rlm_query(task|prompt, paths=None) -> Task` / `rlm_batch(tasks|prompts, paths=None) -> Task`:',
      '  always spawn + ↯bg. await_task for the report string(s).',
      '  Both spellings accepted; prefer `task`/`tasks`.',
      ...(delegation ? RECURSION_DELEGATION_LINES : RECURSION_LINES),
    )
  }
  lines.push(
    '- `answers` / `plan`: two dicts that persist across turns. Memoize every verified result.',
    '- `SHOW_VARS() -> str`: list every variable currently in the REPL.',
    '- `list_tasks()`: every Task this REPL created — [{kind, label, done, var}].',
    '- `answer`: a dict initialized to {"content": "", "ready": False}. To submit your final answer,',
    '  set `answer["content"]` and `answer["ready"] = True`.',
    '  For factual file lists and counts, derive the answer from an exact Python enumeration of `context`',
    '  and preserve the paths verbatim. Do not invent plausible filenames or report an approximate count.',
    '  **You MUST flip `answer["ready"] = True` — runs that never finalize are discarded.**',
  )
  return lines.join('\n')
}

function buildMetadataLine(meta: PromptMeta, maxPromptChars: number): string {
  const kind = contextKindOf(meta.contextType)
  const contextDesc =
    kind === 'text'
      ? `Your context is a plain string of ${meta.contextChars.toLocaleString()} characters. Use Python slicing to chunk it for sub-LLM delegation.`
      : `Your context is a JSON array of ${meta.contextChars.toLocaleString()} total characters — list[dict] where each dict has keys "path" (str), "content" (str), and "tokens" (int). Use Python list slicing to chunk it into batches for sub-LLM delegation.`
  const tail = `Each sub-LLM call accepts up to ${maxPromptChars.toLocaleString()} characters (≈${promptCapTokensK(maxPromptChars)}K tokens).`
  const dist =
    kind === 'files' && meta.contextStats
      ? ` Your context has ${meta.contextStats.files} files; per-file tokens min ${meta.contextStats.min.toLocaleString()} / median ${meta.contextStats.median.toLocaleString()} / max ${meta.contextStats.max.toLocaleString()} — use this to gauge batches.`
      : ''
  const body = `${contextDesc} ${tail}${dist}`
  return meta.rootPrompt ? `<task>${meta.rootPrompt}</task>\n\n${body}` : body
}

/** Build the full RLM system prompt. */
export function buildRlmSystemPrompt(meta: PromptMeta, opts: SystemPromptOptions = {}): string {
  const recursion = opts.recursion ?? false
  const kind = contextKindOf(meta.contextType)
  const maxPromptChars = opts.maxPromptChars ?? DEFAULT_PROMPT_CAP
  const parts = [INTRO]

  if ((opts.depth ?? 0) > 0) {
    parts.push(
      '',
      `**Recursion depth: ${opts.depth}.** You are a sub-RLM — focus narrowly on your assigned`,
      'task. Delegate (rlm_query/rlm_batch) only if the task itself must decompose further.',
    )
    if (opts.delegation ?? false) {
      parts.push(
        '',
        '**REPL API (ONLY these):** llm_query / llm_batch / llm_query_chunked / map_files /',
        'llm_map_reduce / rlm_query / rlm_batch / spawn / await_task / list_tasks.',
        'There is no search/grep_context/outline here.',
      )
    }
  }

  parts.push(
    '',
    howToRunCode(),
    '',
    replGlossary(kind, recursion, opts.child ?? false, opts.delegation ?? false),
    '',
    'REPL stdout over ~800 characters is truncated to a short excerpt — large results stay in your',
    'REPL variables as buffers. Re-print only the slice you need (e.g. `print(result[:500])`).',
    '',
    'Start by probing `context` (print a few lines, count items). Then build up an answer to the query.',
  )

  if (opts.orchestrator ?? true) {
    parts.push('', orchestratorAddendum(maxPromptChars), '', DECOMPOSITION_DOCTRINE)
  }

  if (kind === 'files') {
    parts.push('', LARGE_FILE_RULE)
  }

  parts.push('', buildMetadataLine(meta, maxPromptChars))
  return parts.join('\n')
}
