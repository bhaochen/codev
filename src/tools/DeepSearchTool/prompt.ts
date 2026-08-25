export const DEEPSEARCH_TOOL_NAME = 'deepsearch'

export const DESCRIPTION = `Run a deep research (deepsearch) benchmark: a ReAct search loop answers a dataset of questions by searching the web, then the run is scored (LLM-as-judge correctness + per-step credit) and analyzed (context growth, LongSeeker meta-op suggestions). Returns the full report: metrics, per-question table, step scores, context-growth chart, and suggestions.

Use when you need to evaluate a deep web-research pipeline on a question set, or run a deep research sweep and read the resulting report. The report is delivered as the tool result and saved under .codev-benchmarks/.

Datasets: built-in "deepsearch-demo", or a path to a JSON file of {id, query, gt} objects.`
