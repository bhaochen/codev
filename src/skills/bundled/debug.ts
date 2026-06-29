import { open, stat } from 'fs/promises'
import { DEBUG_SESSION_TOOL_NAME } from 'src/tools/DebugSessionTool.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from 'src/tools/FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { registerBundledSkill } from '../bundledSkills.js'

const ALLOWED_TOOLS = [
  FILE_READ_TOOL_NAME,
  GLOB_TOOL_NAME,
  GREP_TOOL_NAME,
  FILE_EDIT_TOOL_NAME,
  FILE_WRITE_TOOL_NAME,
  BASH_TOOL_NAME,
  AGENT_TOOL_NAME,
  DEBUG_SESSION_TOOL_NAME,
]

const DEBUG_SESSION_DIR = '.versperclaw-debug'

function buildDebugPrompt(args: string): string {
  const issue = args.trim() || 'The user did not provide a bug description yet.'

  return `# /debug - Runtime Debugging

You are in VersperClaw debug mode. Debug mode is evidence-driven: insert temporary probes, collect runtime data, identify the root cause from logs, fix, verify, and clean up.

Debug artifact directory: \`${DEBUG_SESSION_DIR}/\`
Runtime log file: \`${DEBUG_SESSION_DIR}/debug.log\`
Use the \`${DEBUG_SESSION_TOOL_NAME}\` tool to initialize the session, add run separators, read logs, add verify separators, and clean up the debug directory.

## User Issue

${issue}

## Mandatory Checkpoints

Print each checkpoint marker exactly before moving past that step:

- \`CHECKPOINT 0: Context gathered\`
- \`CHECKPOINT 1: Probe plan created - N probes planned\`
- \`CHECKPOINT 2: Log collector initialized\`
- \`CHECKPOINT 3: N probes inserted into source files\`
- \`CHECKPOINT 4: N log entries collected\`
- \`CHECKPOINT 5: Root cause identified with log evidence\`
- \`CHECKPOINT 6: Fix applied and verified with probes\`
- \`CHECKPOINT 7: All probes removed, cleanup complete\`

Hard rules:

1. Do not print CHECKPOINT 5 until checkpoints 1-4 are complete.
2. Do not propose or apply a fix until you can cite specific collected log entries, except for asking the user for missing reproduction details.
3. Probe insertion must use the Edit tool to physically add probe blocks to source files.
4. Probe cleanup must use the Edit tool to remove every probe block.
5. Before final response, grep for \`DEBUG PROBE\`; no probe code may remain.
6. Use at most 3 instrumentation iterations. If still unresolved, summarize evidence and ask for the next reproduction clue.

## Workflow

### Step 0: Triage

If the user did not provide expected behavior, actual behavior, reproduction steps, consistency, and relevant errors, ask only for the missing details. If enough context is already present, continue.

After this, print:
\`CHECKPOINT 0: Context gathered\`

### Step 1: Understand and Plan Probes

Read relevant code. Form 2-3 hypotheses. Plan minimal probes on critical paths.

Output a compact table:

| # | File:Line | Label | Variables | Hypothesis |
|---|-----------|-------|-----------|------------|

Choose logging strategy:

- CLI, server, worker, script: file-based logging to \`${DEBUG_SESSION_DIR}/debug.log\`.
- Browser or frontend-only: \`console.log\` probes with \`[DEBUG PROBE N]\`; ask the user to paste console output if it cannot be captured directly.

Then print:
\`CHECKPOINT 1: Probe plan created - N probes planned\`

### Step 2: Initialize Debug Session

Call \`${DEBUG_SESSION_TOOL_NAME}\` with \`{"action":"init"}\` for file-based or hybrid logging.

Then print:
\`CHECKPOINT 2: Log collector initialized\`

### Step 3: Insert Probes

Every probe block must include START and END markers:

\`\`\`ts
// DEBUG PROBE [1] label
try {
  require('fs').appendFileSync('${DEBUG_SESSION_DIR}/debug.log', \`[\${new Date().toISOString()}] [js] file.ts:42 | label | value=\${JSON.stringify(value)}\\n\`)
} catch {}
// DEBUG PROBE END [1]
\`\`\`

Python probe example:

\`\`\`py
# DEBUG PROBE [1] label
try:
    import datetime
    open("${DEBUG_SESSION_DIR}/debug.log", "a").write(f"[{datetime.datetime.now().isoformat()}] [python] file.py:42 | label | value={value}\\n")
except Exception:
    pass
# DEBUG PROBE END [1]
\`\`\`

Go probe example:

\`\`\`go
// DEBUG PROBE [1] label
import "os"
f, _ := os.OpenFile("${DEBUG_SESSION_DIR}/debug.log", os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
if f != nil {
    fmt.Fprintf(f, "[%s] [go] file.go:42 | label | value=%v\\n", time.Now().Format(time.RFC3339), value)
    f.Close()
}
// DEBUG PROBE END [1]
\`\`\`

Rust probe example:

\`\`\`rust
// DEBUG PROBE [1] label
{
    use std::fs::OpenOptions;
    use std::io::Write;
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open("${DEBUG_SESSION_DIR}/debug.log") {
        writeln!(f, "[{}] [rust] file.rs:42 | label | value={:?}", chrono::Utc::now().to_rfc3339(), value).ok();
    }
}
// DEBUG PROBE END [1]
\`\`\`

For other languages, adapt the probe to that language's normal append-to-file API. Keep the same \`DEBUG PROBE [N]\` / \`DEBUG PROBE END [N]\` markers, timestamp, file:line, label, and observed variables.

Probe code must observe only; it must not alter program behavior.
If a probe requires a temporary import, include, or helper function, wrap that temporary addition in its own \`DEBUG PROBE [N]\` / \`DEBUG PROBE END [N]\` markers too.

Then print:
\`CHECKPOINT 3: N probes inserted into source files\`

### Step 4: Reproduce and Collect Logs

For file-based runs, call \`${DEBUG_SESSION_TOOL_NAME}\` with \`{"action":"begin_run","label":"short label"}\` before each reproduction command. Run the reproduction with Bash. For intermittent issues, collect 2-3 runs.

Read logs with \`${DEBUG_SESSION_TOOL_NAME}\` using \`{"action":"read_log","tailLines":200}\`.

Then print:
\`CHECKPOINT 4: N log entries collected\`

### Step 5: Analyze Evidence

Analyze ordering, missing probes, unexpected values, duplicates, timing gaps, and before/after differences. Cite exact log lines.

Then print:
\`CHECKPOINT 5: Root cause identified with log evidence\`

### Step 6: Fix and Verify

Apply the smallest targeted fix. Keep probes in place. Call \`${DEBUG_SESSION_TOOL_NAME}\` with \`{"action":"begin_verify","label":"fix verification"}\`, rerun reproduction, then read logs again.

Compare failing runs and VERIFY logs. The problematic value, ordering, or missing path must be corrected.

Then print:
\`CHECKPOINT 6: Fix applied and verified with probes\`

### Step 7: Cleanup

Remove all probe blocks from source files using Edit. Search with Grep for \`DEBUG PROBE\` and continue cleanup until there are zero matches. Then call \`${DEBUG_SESSION_TOOL_NAME}\` with \`{"action":"cleanup"}\`.

Then print:
\`CHECKPOINT 7: All probes removed, cleanup complete\`

## Final Response

Summarize the root cause, the log evidence, the fix, the verification result, and cleanup status.`
}

export function registerDebugSkill(): void {
  registerBundledSkill({
    name: 'debug',
    description:
      'Runtime debug mode: insert temporary probes, collect logs, identify root cause, fix, verify, and clean up.',
    allowedTools: ALLOWED_TOOLS,
    argumentHint: '<bug description>',
    disableModelInvocation: true,
    userInvocable: true,
    async getPromptForCommand(args) {
      return [{ type: 'text', text: buildDebugPrompt(args) }]
    },
  })
}
