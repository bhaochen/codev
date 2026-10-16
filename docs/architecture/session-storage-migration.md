# Session Storage Migration: JSONL → SQLite

## Overview

Codev migrated session transcript storage from append-only JSONL files to a SQLite database (`~/.claude/sessions/sessions.db`). This document describes the schema, migration process, performance characteristics, and trade-offs.

---

## Database Location

```
~/.claude/sessions/sessions.db      # Main database (WAL mode)
~/.claude/sessions/sessions.db-shm  # Shared memory (WAL)
~/.claude/sessions/sessions.db-wal  # Write-ahead log
```

---

## Schema

### `sessions` Table (2,870 rows — 251 `main` + 2,619 `subagent`)

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
| `kind` | TEXT | `'main'` (user session) or `'subagent'` (sidechain transcript, migration 004) |
| `parent_session_id` | TEXT | Session that spawned the subagent (NULL for `main`, migration 004) |

### `messages` Table (2,223,288 rows)

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
CREATE INDEX idx_sessions_kind ON sessions(kind);               -- picker: kind='main'
CREATE INDEX idx_sessions_parent ON sessions(parent_session_id); -- subagent roll-up
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
| 4 | `004-subagent-sessions` | `sessions.kind` + `sessions.parent_session_id` + indexes |

Separately, `CURRENT_SESSION_MIGRATION_VERSION` (`src/main.tsx`, currently **5**)
gates the background *import* pass: bumping it re-runs the scanner
(migrate / repair / prune). v5 added the walk that also imports subagent trees;
the repair + prune semantics below apply to it.

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
| ②-A | ✅ | — | **Compaction subagents excluded from the mirror** (storage fix A): `agent-acompact-*` never mirrored (writer + scanner) and pruned by the migration pass; `CODEV_MIRROR_COMPACTION_SUBAGENTS=1` restores the old behavior |
| D4 | ✅ | — | **Deferred export**: the append path no longer writes JSONL by default; the file is materialized on demand for external readers (hooks/statusline), `CODEV_SESSION_EXPORT=1` restores eager export |

> **Open item after ②**: mirroring subagent transcripts literally re-stores
> each parent's context once per subagent — ~94.5 % of the 9.19 GB payload is
> redundant and the DB grew 124.8 MB → 11.13 GB. Worse, **93.6 % of that
> payload (8.60 GB) is failed compaction retries** (`agent-acompact-*` that end
> in an API/rate-limit error). **Fix A (exclude compaction subagents) is
> implemented**; the remaining question is **fix B** — stop the recording layer
> from persisting the full forked context (the 8.86 GB of subagent JSONL on
> disk). See "Case Study: Why Mirror Subagent Transcripts Duplicates Context".

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
  (Item ② later mirrors subagent transcripts *deliberately*, as their own
  `kind='subagent'` rows — see the case study below for what that costs.)

Pruning also enforces **mirror policy**: `agent-acompact-*` rows are deleted
regardless of whether their file exists (they are never mirrored — fix A), so a
migration pass self-heals any database populated before the policy.

`VACUUM` runs when a pass changed data **or** when the freelist exceeds 20% of
pages (reclaims space left behind by large prunes); vacuum failures are
non-fatal.

### Real-World Result (legacy bulk import)

| Phase | Sessions table | Messages table | DB size |
|-------|---------------|----------------|---------|
| After first bulk migration | 3,117 (incl. 2,883 orphans) | 2,267,520 | 11.2 GB |
| After repair + prune | 243 (real top-level sessions) | 29,727 | 11.2 GB (freelist) |
| After `VACUUM` | 243 | 29,727 | **124.8 MB** |

The 11 GB → 125 MB shrink shows why pruning mattered: the bulk of the original
2.2M rows were subagent transcripts + duplicated keys, not user sessions.

---

## Case Study: Why "Mirror Subagent Transcripts" Duplicates Context (②)

Item ② sounds additive: mirror subagent transcripts, one row-set per subagent.
It is not. The CLI hands *every* subagent the **parent's whole message history**
as context, and the subagent's transcript records that context verbatim before
its own turns. Mirroring such a transcript therefore re-stores the parent's
context once per subagent — and compaction subagents (`agent-acompact-*`) are
spawned over and over, so the same context is stored **hundreds of times**.

### A single compaction subagent re-stores 99.6 % of its parent

Parent `d8744217-b983-44cf-b194-311073443a9a` (1,091 entries, 3.84 MB) has 189
compaction subagents. Take one child:

| Scope | Entries | Bytes |
|-------|---------|-------|
| Parent session | 1,091 | 3,844,013 |
| Child `…/subagents/agent-acompact-00303fa8be0f529d` | 370 | 1,794,478 |
| — entries whose `uuid` also occurs in the parent | **368** | **1,787,053 (99.6 %)** |
| — genuinely new (compaction prompt + result) | **2** | **7,425** |

The child's whole 1.79 MB row-set carries **7.4 KB** of information the parent
did not already have: a `user` prompt (6,184 B) and an `assistant` reply
(1,241 B). Everything else is the parent's own entries stored again.

### A single entry, stored 187 times

`uuid` `a7dc5e04-eb14-4769-9da5-292b29bb390a` is the parent's
`system`/`compact_boundary` marker (`content: "Conversation compacted"`). The
DB holds it **187 times** — once in the parent and 186 times across that
parent's compaction subagents. The copies are not byte-identical (the subagent
variant sets `isSidechain: true` and adds an `agentId`), but they describe the
same boundary marker; the only "variation" is full-context-copy bookkeeping.
The most-reused single `uuid` is stored **939 times**.

### Most of the bloat is failed compaction retries

`agent-acompact-*` sessions split by whether their last entry is an API
error (the free tier rate-limits compaction):

| Status | Sessions | Rows | `data_json` bytes |
|--------|----------|------|-------------------|
| **Errored** (API error / rate limit) | 2,135 (90 %) | 2,099,489 | **8.60 GB (93.6 % of all payload)** |
| Succeeded | 237 | 78,476 | 0.41 GB |
| Non-compaction subagents | 247 | 15,495 | 0.07 GB |
| Main sessions | 251 | — | 0.10 GB |

Each failed attempt still forks the full parent context, writes a fresh
`agent-acompact-*` transcript and is mirrored into the DB — then a retry does it
all again. The *successful* compaction's real output already lands in the parent
as an `isCompactSummary` entry, so the subagent transcripts are redundant even
when they succeed. **Skipping `agent-acompact-*` mirroring would drop the DB
payload from 9.19 GB to ~0.17 GB** (main + non-compaction subagents).

### Aggregate impact

Measured on the live DB after the v5 subagent import (Oct 2026):

| Quantity | Value |
|----------|-------|
| Sessions | 2,870 = 251 `main` + 2,619 `subagent` |
| Message rows | 2,223,288 |
| `data_json` bytes, total | 9.19 GB |
| — `main` | 0.10 GB (1.1 %) |
| — `subagent` | 9.09 GB (**98.9 %**) |
| —— of which `agent-acompact-*` (2,372 sessions) | 9.01 GB |
| —— other subagents (247 sessions) | 0.07 GB |
| Distinct-`uuid` union (deduped footprint) | **0.50 GB** |
| Redundant bytes | **8.69 GB (94.5 %)** |
| DB file | **11.13 GB** (124.8 MB before ②) |
| JSONL on disk | 9.1 GB (subagent files: 2,619 / 8.86 GB) |

Every mirrored subagent transcript already exists as a JSONL file (8.86 GB), so
naive ② nearly doubled `~/.claude` (≈9.2 GB → ≈20.2 GB) to keep the same
context a second time. Only ~5.5 % of the stored payload is distinct content;
the remaining ~94.5 % is the same entries re-serialised per subagent (modulo
per-copy bookkeeping such as `isSidechain` / `agentId`).

The worst offender is parent `3f57403f-60f0-48e9-be77-6447e69fada5` (25.8 MB):
**944** compaction subagents totalling **5.15 GB** — 200× the parent. Parent
`7a2ddda2-6a61-448b-bf11-1a57821eaeab` is 735 KB yet carries **755** subagents
totalling 2.61 GB.

### Root cause and storage-policy options

The duplication comes from the **recording layer**, not from a bug in ②:
compaction is implemented as a *forked agent*
(`src/utils/forkedAgent.ts` → `recordSidechainTranscript([...forkContextMessages,
...promptMessages], agentId)`), so each attempt persists the parent's whole
context as its own `<sid>/subagents/agent-acompact-*.jsonl`. The fork exists to
share the main thread's prompt cache; the context must reach the summariser, so
"subagents shouldn't know the parent context" is not a valid fix for compaction.
The ② code path is correct (subagent transcripts read from rows, `kind='subagent'`
+ `parent_session_id`); the open question is only *how to store* them.

Options, cheapest/most-targeted first:

1. **Skip `agent-acompact-*` mirroring** — ✅ **implemented**. These are
   ephemeral compaction attempts; the durable summary is already in the parent
   (`isCompactSummary`). The writer + migration scanner ignore that path and
   pruning removes existing rows (`mirrorExcludesSubagent()` in `shadowWriter`;
   set `CODEV_MIRROR_COMPACTION_SUBAGENTS=1` to restore the old behavior).
   Est. DB 11.13 GB → ~0.2 GB, **zero change to spawn/compaction semantics**.
2. **Content-addressed dedup** — a `message_content` table keyed by content
   hash, with `messages` referencing it. Est. DB ≈ 0.6–0.7 GB; keeps every
   transcript, read callers unchanged.
3. **Opt-in mirroring** — mirror subagents only when enabled (e.g.
   `CODEV_MIRROR_SUBAGENTS=1`); default back to ~125 MB.
4. **Fix the recording layer** — record only the delta (the agent's own turns)
   or a reference to the parent's `seq` range instead of the full fork context.
   This is the only option that also shrinks the **8.86 GB of subagent JSONL on
   disk**; larger change (touches `forkedAgent` / `recordSidechainTranscript`).
5. **Keep as-is / roll back ②** — 11.13 GB, or delete `subagent` rows + `VACUUM`
   → ~125 MB and revisit later.

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

### Storage (user sessions)

| Metric | JSONL source | SQLite mirror | Notes |
|--------|-------------|---------------|-------|
| **Disk size (main sessions)** | 0.16 GB | **124.8 MB** | After v4 repair + prune + vacuum; main sessions only |
| **Sessions (main)** | ~250 top-level | ~250 rows | Subagents handled separately (see ② below) |
| **Messages (main)** | — | ~30k rows | Reduced view (boundary/walkChain applied) |
| **Per-message overhead** | — | +13% vs raw JSONL | Same JSON text + columns + indexes (pre-cleanup measurement) |

**After ② (subagent mirroring, v5)** the picture is dominated by shared
context: 2,619 extra subagent sessions raise the `data_json` payload to 9.19 GB
(8.69 GB / 94.5 % redundant — every subagent re-stores its parent's history),
the DB file to **11.13 GB**, and `~/.claude` total to ≈20.2 GB (JSONL 9.1 GB +
DB 11.13 GB). See "Case Study: Why Mirror Subagent Transcripts Duplicates
Context" above for the breakdown and the storage-policy options.

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
sqlite3 ~/.claude/sessions/sessions.db
sqlite3 -header -column ~/.claude/sessions/sessions.db  # pretty
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
sqlite3 -header -column ~/.claude/sessions/sessions.db \
  "SELECT id, project_dir, title, message_count FROM sessions ORDER BY updated_at DESC LIMIT 10;"

# Largest sessions
sqlite3 -header -column ~/.claude/sessions/sessions.db \
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
   `~/.claude/sessions/sessions.db*` loses nothing — everything rebuilds
   from the JSONL via the background migration.

D4 (deferred export) is itself a flag: `CODEV_SESSION_EXPORT=1` restores
per-append export writing without touching the primary-mode read/write
semantics, for external tools that watch the file.

No data loss path exists in either direction: the DB is flag-guarded, the
export files are repaired from rows on append failure (eager mode) or
materialized from rows on demand (deferred mode), and the legacy reader
self-heals unmarked rows by one resync.