# Session Storage Migration: JSONL → SQLite

## Overview

Codev migrated session transcript storage from append-only JSONL files to a SQLite database (`~/.claude/sessions/sessions.sqlite`). This document describes the schema, migration process, performance characteristics, and trade-offs.

---

## Database Location

```
~/.claude/sessions/sessions.sqlite      # Main database (WAL mode)
~/.claude/sessions/sessions.sqlite-shm  # Shared memory (WAL)
~/.claude/sessions/sessions.sqlite-wal  # Write-ahead log
```

---

## Schema

### `sessions` Table (2,867 rows)

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PK | Session UUID (matches JSONL filename) |
| `project_dir` | TEXT | Encoded project directory (e.g., `-home-yuki-Code-Agent-coding-codev`) |
| `title` | TEXT | Session custom title (last-wins projection) |
| `tag` | TEXT | Session tag |
| `agent_id` | TEXT | Agent ID if agent session |
| `agent_name` | TEXT | Agent display name |
| `agent_color` | TEXT | Agent color theme |
| `model` | TEXT | Model used |
| `created_at` | INTEGER | Unix ms from first entry |
| `updated_at` | INTEGER | Last write time |
| `message_count` | INTEGER | Total message rows (includes meta) |
| `metadata_json` | TEXT | Legacy JSON blob (kept for compat) |
| `synced_size` | INTEGER | JSONL byte size at last sync |
| `synced_mtime` | INTEGER | JSONL mtime at last sync |
| `synced_path` | TEXT | Canonical JSONL path (for path-aware freshness) |

### `messages` Table (2,237,119 rows)

| Column | Type | Description |
|--------|------|-------------|
| `seq` | INTEGER PK | Auto-increment (append order) |
| `session_id` | TEXT FK | → `sessions.id` |
| `uuid` | TEXT | Entry UUID (synthesized for metadata entries) |
| `parent_uuid` | TEXT | Parent message UUID (nullable) |
| `entry_type` | TEXT | e.g., `user`, `assistant`, `system`, `custom-title`, `tag`, `file-history-snapshot` |
| `data_json` | TEXT | Full entry JSON (round-trip fidelity) |
| `created_at` | INTEGER | Write timestamp |
| `role` | TEXT | `'main'` (transcript) or `'meta'` (pre-boundary session metadata) |

### Indexes

```sql
CREATE INDEX idx_messages_session_id ON messages(session_id);
CREATE INDEX idx_messages_uuid ON messages(uuid);  -- 366× faster UUID lookups
```

### `migrations` Table

| Column | Type |
|--------|------|
| `id` | TEXT PK (e.g., `001-initial`) |
| `applied_at` | INTEGER (unix ms) |

---

## Migration Pipeline

### Automatic (on startup)
```typescript
// main.tsx → runMigrations() → runSessionMigration()
if (config.sessionMigrationVersion !== CURRENT_SESSION_MIGRATION_VERSION) {
  await runSessionMigration()  // fires in background with spinner
}
```

### Manual (explicit)
```bash
# Dry run
bun run src/services/db/migrateSessions.ts --dry-run

# Full migration + repair + prune (+ vacuum when beneficial)
bun run src/services/db/migrateSessions.ts --verbose --vacuum

# Keep orphaned rows (skip pruning)
bun run src/services/db/migrateSessions.ts --no-prune

# Specific project
bun run src/services/db/migrateSessions.ts --project-dir -home-yuki-Code-Agent-coding-codev
```

### Migration Versions

| Version | Migration ID | Description |
|---------|--------------|-------------|
| 1 | `001-initial` | Base schema: sessions + messages + indexes |
| 2 | `002-sync-columns` | `synced_size`, `synced_mtime` for cache freshness |
| 3 | `003-cache-roles` | `messages.role` (main/meta), `sessions.synced_path` |
| 4 | (logic) | Repair pass: re-sync stale rows + prune orphaned rows |

---

## JSONL → DB-Primary Roadmap

Phased migration from "JSONL source of truth + SQLite cache" toward
"SQLite source of truth + JSONL export", each phase independently shipped
and tested:

| Phase | Status | Commit | What |
|-------|--------|--------|------|
| A | ✅ | `510ee6c` | Shadow writer: every JSONL append mirrors into SQLite (guarded incremental + boundary/threshold full resync); write seams from the queue, sync metadata path, speculation, server |
| C1 | ✅ | `beebf3d` | DB-first listing/picker metadata (lastPrompt/title/tag/gitBranch/…) via `listingProjection`; file scan fallback |
| C2 | ✅ | `4c0c2db` | Server `getSessionMessages` served from rows (fresh + ≤5MB gate, file fallback) |
| C3 | ✅ | `2ae0851` | Server session lookup (row query vs dir scan) + all transcript read call sites flipped |
| C4 | ✅ | `3118093` | `--resume <path.jsonl>` / deep-link readers via `loadTranscriptViaCache` (exported, projects-root guarded) |
| D0 | ✅ | `7e2ccd1` | DB→JSONL export/repair tool (`exportSession.ts`) — the self-heal prerequisite for the write flip |
| D1 | ✅ | `f4cc239` | DB-primary write mode (`CODEV_DB_PRIMARY`): rows authoritative, export best-effort, export-failure repair |
| C5 | ✅ | `e691253` | Forks read the source from rows in primary mode (lagging/missing export safe) |
| C6 | ✅ | `662691b` | `/resume` listing supplements the dir scan with DB rows — sessions stay listed (with DB titles) even when the projects tree is gone |
| D3 | ✅ | `2e4b127` | **Default flip**: primary mode ON by default; `CODEV_DB_PRIMARY=0` reverts to JSONL-as-truth |
| ② | ✅ | `d8ac182` | **Subagent transcripts mirrored**: composite ids (`<sid>/subagents/…`, `kind='subagent'`, `parent_session_id`), migration 004, migration scanner walks subagent trees (v5), `getAgentTranscript` DB-first |
| D4 | ✅ | — | **Deferred export**: the append path no longer writes JSONL by default; the file is materialized on demand for external readers (hooks/statusline), `CODEV_SESSION_EXPORT=1` restores eager export |

### DB-Primary Mode (current default)

```
CODEV_DB_PRIMARY    unset/1  → SQLite is the session store of truth (default)
                    =0/false → legacy: JSONL source of truth + SQLite mirror
CODEV_SESSION_EXPORT=1       → eager export: write the JSONL file on every
                               append (the pre-D4 D3 behavior)
```

Behavior in primary mode:

- **Reads** serve rows whenever the session is *primary-owned* (rows written by
  the primary path, marked `metadata.__primary`) or the file is missing.
  Unmarked rows (pre-v4 legacy) keep the freshness-gated shadow semantics and
  self-heal by one file resync before being adopted.
- **Writes** (drain seam): rows buffered + flushed first (mandatory). By
  default (D4) the JSONL file is **not** touched by the append path — see
  "Deferred export" below. With `CODEV_SESSION_EXPORT=1` the file is appended
  after the rows as a best-effort export.
- **Export repair**: any failed export append triggers a full-file rewrite
  from the rows (`exportSession`), so external file readers recover.
- **Forks** (`/branch`, `--fork-session`) source from rows.

#### Deferred export (D4)

The JSONL file is an export, not the record. D4 stops the high-frequency
append path from writing it at all:

- Nothing is at risk — the rows are durable first (D1 ordering), and the file
  is reconstructable from them at any time.
- External consumers get a file **on demand**, right before they read it:
  - `utils/hooks.ts` calls `materializeExportForPath` for every hook/statusline
    input that carries `transcript_path` (or `agent_transcript_path`) — the
    file is complete and current for the command that is about to run.
  - `bun run src/services/db/exportSession.ts <id>` (or `--all`) rewrites from
    rows explicitly.
- **Materialization cost**: a per-session watermark (last row seq + file size
  after we wrote it) makes the common case an append of only the missing rows.
  A full rewrite happens on the first touch in a process, after an external
  modification/truncation, or when pending pre-boundary metadata must precede
  the boundary.
- **Continuous file watchers** (an editor extension polling the path) should
  run the CLI/server with `CODEV_SESSION_EXPORT=1` to restore per-append
  export writing.

Residual trade-offs (documented, flag-gated): an export that fails before the
process can repair it leaves the file lagging until the next materialization or
a manual `bun run src/services/db/exportSession.ts <id>` — file-only readers
(`/insights`, `stats`, external tools) may see the lag, while all primary
reads serve the full rows.

**Deliberate file-only readers** (left on JSONL by design): `/insights` +
`stats.ts` (batch analytics, keepAllLeaves / include subagent files),
`findUnresolvedToolUse` (hot mid-session path). Subagent transcripts are
mirrored (item ②) and served from rows by `getAgentTranscript`.

### Skip / Repair / Prune Semantics

A session is **skipped only when its SQLite rows are the canonical view of the
current file**: `synced_path` matches the live realpath and
`synced_size`/`synced_mtime` match the live stat. Anything else is handled:

| Condition | Action |
|-----------|--------|
| No rows yet | **Migrate** |
| Rows exist, no/stale sync info | **Repair** (re-sync via `parseTranscriptFile`) |
| Rows current | **Skip** |
| DB row whose top-level source JSONL is gone | **Prune** (delete row) |

Orphans pruned include the two artifacts of pre-v4 bugs:

- rows keyed **with** the `.jsonl` extension (old sessionId format),
- **subagent transcripts** (`<sessionId>/subagents/agent-*.jsonl`) wrongly
  migrated as top-level sessions — subagent JSONL files on disk are untouched.

`VACUUM` runs when a pass changed data **or** when the freelist exceeds 20% of
pages (reclaims space left behind by large prunes); vacuum failures are
non-fatal.

### Real-World Result (2,867 legacy sessions)

| Phase | Sessions table | Messages table | DB size |
|-------|---------------|----------------|---------|
| After first bulk migration | 3,117 (incl. 2,883 orphans) | 2,267,520 | 11.2 GB |
| After repair + prune | 243 (real top-level sessions) | 29,727 | 11.2 GB (freelist) |
| After `VACUUM` | 243 | 29,727 | **124.8 MB** |

The 11 GB → 125 MB shrink shows why pruning mattered: the bulk of the original
2.2M rows were subagent transcripts + duplicated keys, not user sessions.

---

## Read-Through Cache

The SQLite DB is a **derived mirror** of JSONL (source of truth). On read:

1. `statSync(jsonlPath)` → compare with `synced_size/mtime/path`
2. **Fresh** → serve directly from SQLite (no JSONL parse)
3. **Stale** → `parseTranscriptFile()` (canonical pipeline) → `syncSession()` → `setSyncInfo()` → serve

**Fidelity guarantees:**
- Uses exact same `parseTranscriptFile()` as `loadTranscriptFile()` (fd-level attr-snap skip, compact-boundary truncate, metadata recovery, walkChain pruning)
- Two-pass reducer preserved via `role` column (`meta` pass first, `main` overwrites)
- Large-file (>5 MB) behavior identical: boundary truncation + metadata recovery + walkChain pruning

---

## Quantitative Metrics

### Storage (after v4 repair + prune + vacuum)

| Metric | JSONL source | SQLite mirror | Notes |
|--------|-------------|---------------|-------|
| **Disk size (user sessions)** | 9.1 GB (all JSONL incl. subagents) | **124.8 MB** | Mirror excludes subagent transcripts (read from JSONL directly) |
| **Sessions** | 243 top-level (+ ~2,600 subagent files) | 243 rows | Subagents deliberately not mirrored |
| **Messages** | — | 29,727 rows | Reduced view (boundary/walkChain applied) |
| **Per-message overhead** | — | +13% vs raw JSONL | Same JSON text + columns + indexes (pre-cleanup measurement) |

### Performance (5,000-message session, ~17 MB JSONL)

| Metric | JSONL | SQLite | Delta |
|--------|-------|--------|-------|
| **Append latency (p50)** | 25 ms | 150 ms | **6× slower** |
| **Batch append (100)** | baseline | 1.5× slower | — |
| **Full read (all msgs)** | baseline | 3× faster | ✅ |
| **Tail-50 read** | baseline | 55× faster | ✅ |
| **UUID lookup (indexed)** | O(n) scan | O(log n) | **366× faster** |
| **Memory (151 MB session)** | 316 MB RSS | ~155 MB RSS | **2× less** |

### Benchmark Methodology
- 5,000 messages, ~17 MB JSONL
- Bun v1.4.2, Node 26.10.0 (native `node:sqlite`)
- Measured via `src/services/db/benchmarks/`

---

## Trade-offs

### Pros (SQLite)

| Benefit | Impact |
|---------|--------|
| **Indexed UUID lookups** | 366× faster for `getMessageByUuid`, parent-chain resolution |
| **Tail reads** | 55× faster — critical for `--resume` picker |
| **Structured queries** | SQL for session listing, filtering, analytics |
| **ACID transactions** | Safe concurrent access, crash recovery (WAL) |
| **Lower memory for large sessions** | No full-file parse; fd-level streaming |
| **Read-through correctness** | Cache self-heals on any writer (fork, speculation, server) |

### Cons (SQLite)

| Cost | Mitigation |
|------|------------|
| **+13% disk** | Acceptable for local dev; `VACUUM` reclaims fragmentation |
| **6× slower appends** | Batched writes (1.5×); async queue masks latency |
| **Schema migrations** | Versioned, idempotent, atomic — zero-downtime |
| **Complexity** | Encapsulated in `SessionStore` + `transcriptCache` |

---

## Usage

### Open database
```bash
sqlite3 ~/.claude/sessions/sessions.sqlite
sqlite3 -header -column ~/.claude/sessions/sessions.sqlite  # pretty
```

### Common queries

```sql
-- Migration status
SELECT * FROM migrations ORDER BY version;

-- Session summary (last 20)
SELECT id, project_dir, title, tag, message_count,
       synced_size, synced_mtime, synced_path
FROM sessions ORDER BY updated_at DESC LIMIT 20;

-- Messages per session
SELECT session_id, COUNT(*) as msgs
FROM messages GROUP BY session_id ORDER BY msgs DESC LIMIT 20;

-- Role distribution
SELECT role, COUNT(*) FROM messages GROUP BY role;

-- UUID lookup (uses idx_messages_uuid)
SELECT * FROM messages WHERE uuid = '00000000-0000-4000-8000-000000000001' LIMIT 1;

-- Pre-boundary metadata (role='meta')
SELECT session_id, seq, entry_type,
       json_extract(data_json, '$.customTitle') as title,
       json_extract(data_json, '$.tag') as tag
FROM messages WHERE role = 'meta' ORDER BY session_id, seq;

-- Unsynced sessions (need background sync)
SELECT id, project_dir, message_count
FROM sessions WHERE synced_path IS NULL ORDER BY message_count DESC LIMIT 20;

-- Search content
SELECT session_id, seq, json_extract(data_json, '$.message.content') as content
FROM messages WHERE json_extract(data_json, '$.message.content') LIKE '%bug%'
LIMIT 10;
```

### One-liners
```bash
# Recent sessions
sqlite3 -header -column ~/.claude/sessions/sessions.sqlite \
  "SELECT id, project_dir, title, message_count FROM sessions ORDER BY updated_at DESC LIMIT 10;"

# Largest sessions
sqlite3 -header -column ~/.claude/sessions/sessions.sqlite \
  "SELECT s.id, s.project_dir, s.title, m.msg_count 
   FROM sessions s JOIN (SELECT session_id, COUNT(*) msg_count FROM messages GROUP BY session_id) m 
   ON s.id = m.session_id ORDER BY m.msg_count DESC LIMIT 10;"
```

---

## Key Implementation Files

| File | Purpose |
|------|---------|
| `src/services/db/SessionStore.ts` | Singleton, schema, CRUD, sync, migrations |
| `src/services/db/transcriptCache.ts` | Read-through cache (`loadTranscriptCached`) |
| `src/services/db/driver.ts` | Adapter chain: `bun:sqlite` → `node:sqlite` → `sql.js` |
| `src/services/db/migrations/001-initial.ts` | Base schema |
| `src/services/db/migrations/002-sync-columns.ts` | Sync tracking columns |
| `src/services/db/migrations/003-cache-roles.ts` | Role column + path-aware freshness |
| `src/utils/sessionStorage.ts` | `parseTranscriptFile()`, `loadTranscriptViaCache()`, wiring |
| `src/services/db/migrateSessions.ts` | CLI migration tool + progress callback |
| `src/main.tsx` | Background migration on startup |

---

## Fidelity Verification

### Differential Tests (`transcriptShape.differential.test.ts`)
```typescript
// Proves: buildTranscriptShape(parsed) ≡ loadTranscriptFile(file)
await runDifferential(buildEntries())           // 22 entry types
await runDifferential(buildEntriesWithBoundary()) // compact boundary
```

### Round-trip Tests (`transcriptRoundtrip.test.ts`)
```typescript
// writeTranscript → loadTranscript ≡ loadTranscriptFile
await roundTrip(buildEntries())                 // 3 cases, deep-equal
```

### Large-file Cache Tests (`transcriptCacheLarge.test.ts`)
```typescript
// >5 MB fixtures with boundary + walkChain pruning
// Cache ≡ loadTranscriptFile (all 20 fields)
// Fresh fast-path also matches
```

---

## Future Optimizations

| Idea | Status |
|------|--------|
| Delta sync (append-only) | Designed — needs byte-offset tracking |
| `data_json` compression (zstd) | Opt-in, saves ~40% |
| Page-level compression (SQLite 3.43+) | Requires compile flag |
| Drop `idx_messages_uuid` if unused | Saves ~1.2 GB |
| Session listing from SQLite | Replace file-stat picker |

---

## Rollback Plan

SQLite is now the source of truth (DB-primary default), with the JSONL
export kept current on every write path. Rollback is a flag, at any level:

1. **Instant, per-process**: run with `CODEV_DB_PRIMARY=0` — reads and writes
   revert to the legacy JSONL-as-truth behavior (the mirror keeps updating).
2. **Repair before/after rollback**: `bun run src/services/db/exportSession.ts
   <sessionId>` (or `--all`) rewrites the JSONL files from the rows, so the
   legacy path sees exactly the DB content. (Under D4 the files are not
   continuously written, so run this before rolling back.)
3. **Full return**: with the files exported and the flag off, deleting
   `~/.claude/sessions/sessions.sqlite*` loses nothing — everything rebuilds
   from the JSONL via the background migration.

D4 (deferred export) is itself a flag: `CODEV_SESSION_EXPORT=1` restores
per-append export writing without touching the primary-mode read/write
semantics, for external tools that watch the file.

No data loss path exists in either direction: the DB is flag-guarded, the
export files are repaired from rows on append failure (eager mode) or
materialized from rows on demand (deferred mode), and the legacy reader
self-heals unmarked rows by one resync.