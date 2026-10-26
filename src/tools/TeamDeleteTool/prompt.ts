export function getPrompt(): string {
  return `
# TeamDelete

Remove team records when the swarm work is complete.

This operation:
- Removes team and task state from \`codev.db\`
- Removes inbox and live coordination files
- Clears team context from the current session

**IMPORTANT**: TeamDelete will fail if the team still has active members. Gracefully terminate teammates first, then call TeamDelete after all teammates have shut down.

Use this when all teammates have finished their work and you want to clean up the team resources. The team name is automatically determined from the current session's team context.
`.trim()
}
