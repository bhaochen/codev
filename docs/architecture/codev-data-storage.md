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

`codev.db` is the source of truth for global config, adapters, adapter session
mappings, scheduled task definitions and run history, prompt history, stats
cache, sessions, and workflow run state. JSON copies are not read or written
for these records.

## Files in the data root

User-authored skills, agents, hooks, workflows, and MCP configuration remain
files because users and tools edit them directly. Attachments, images, debug
logs, file-history backups, and generated assets also remain files; putting
large or binary payloads in SQLite would make backups and incremental writes
less efficient. Regenerable caches should eventually move to XDG cache storage.

Other data-root entries are classified by content, not extension:

- Stored in `codev.db`: global config; ordinary user preferences; adapter
  config and adapter session state; scheduled-task definitions and run
  history; session/transcript and prompt history; stats cache; and workflow
  run state.
- Still to migrate: task lists and team metadata. Their current file APIs are
  also used for cross-process coordination and filesystem watching, so their
  writers and watchers must move together before those JSON files can stop
  being authoritative. Auto-memory is currently synchronized with
  `memory_files` but still uses files as its live interface.
- Keep as files: `CLAUDE.md`, plans and other user-authored documents, skills,
  agents, hooks, workflow definitions, MCP/plugin definitions, browser profile
  and browser context archives, session environment scripts, attachments/paste
  cache, voice media, diagnostics/debug logs, backups, and file-history
  snapshots. Statsig data remains a regenerable cache.
- Keep as files: `CLAUDE.md`, plans and other user-authored documents, skills,
  agents, hooks, workflow definitions, MCP/plugin definitions, browser profile
  data, session environment files, attachments/paste cache, voice media,
  diagnostics/debug logs, backups, and file-history snapshots.

Some directories mix state and content. Plugin files and user-authored agent
content stay on disk; structured team/task records are migration work still
underway.

## Legacy migration

The first launch creates the data root and database without scanning or
importing `~/.claude`, `~/.codev`, or legacy JSON files. Existing global JSON
files are ignored. There is no JSON fallback copy or compatibility import.
