# Codev application data storage

Default user data root: `${XDG_DATA_HOME:-~/.local/share}/codev`.
`CODEV_DATA_DIR` and `CODEV_CONFIG_DIR` override it. `CLAUDE_CONFIG_DIR` is
still accepted as a compatibility override.

## SQLite (`codev.db`)

- Session metadata, transcript entries, and session process state.
- Auto-memory rows in `memory_files`; files remain a working/export copy so
  normal file tools and editors can still read and edit project memory.
- Workflow run state and events. Existing `workflows/state.sqlite` is
  imported into the unified database and retained as a recovery copy.
- Structured application state belongs in `app_documents` (or dedicated
  relational tables where it needs indexing or concurrent updates).

`codev.db` is the sole durable store for structured application state: global
config, ordinary user preferences, adapter config and adapter session state,
scheduled-task definitions and run history, prompt history, stats cache,
sessions, task lists, team metadata, and workflow run state. No JSON
compatibility or recovery copy is written for these records, and no legacy
JSON file is read, backed up, or restored.

## Files in the data root

User-authored skills, agents, hooks, workflows, and MCP configuration remain
files because users and tools edit them directly. Attachments, images, debug
logs, and file-history snapshots also remain files; putting large or binary
payloads in SQLite would make incremental writes less efficient. Regenerable
caches should eventually move to XDG cache storage.

- Keep as files: `CLAUDE.md`, plans and other user-authored documents, skills,
  agents, hooks, workflow definitions, MCP/plugin definitions, browser profile
  and browser-context archives, session environment scripts, attachments/paste
  cache, voice media, diagnostics/debug logs, and file-history snapshots.
  Statsig data remains a regenerable cache.

## Legacy migration

The first launch creates the data root and database without scanning or
importing `~/.claude`, `~/.codev`, or legacy JSON files. Existing global JSON
files are ignored. There is no JSON fallback copy, compatibility import, or
file backup of the global config.
