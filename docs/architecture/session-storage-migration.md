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

JSONL remains **source of truth** until explicit flip:
1. Disable background migration: `sessionMigrationVersion = 999` in config
2. Delete `~/.claude/sessions/sessions.sqlite*`
3. All reads fall back to `loadTranscriptFile()` (current behavior)

No data loss possible — SQLite is a rebuildable cache.