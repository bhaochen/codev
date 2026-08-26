export const DESCRIPTION =
  'Operate multi-step workflows defined in .claude/workflows/*.workflow.ts — list, start, pause, resume, cancel, answer checkpoints, and submit structured step output'

export function getPrompt(): string {
  return `${DESCRIPTION}

Actions:
- list: enumerate discovered workflows and any runs in this session.
- start: begin a run. Pass "name" and optional "input_json" (a JSON object, e.g. {"task": "..."}).
- status: report the current run of this session (node, step count, attempts, errors).
- pause / resume / cancel: control the active run.
- answer: deliver a JSON value to a parked checkpoint node ("value_json").
- submit: deliver the structured output of the workflow step you are currently
  executing ("output"). Only call submit when a step prompt asked you to.

Step contract: when you receive a <workflow-step> prompt, perform the step and
then call this tool exactly once with action="submit". The step completes only
through submit; plain text replies do not advance the workflow.`
}
