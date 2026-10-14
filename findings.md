# Findings: Codev LLM Architecture Audit

## Current Architecture (Phase 0)

### Core Types
- `LLMRequest`: Provider-neutral request with model, messages, systemPrompt, tools, signal, config, context
- `LLMStreamEvent` = `StreamEvent`: Agent semantic stream event
- `LLMRoute`: { provider, protocol, model, endpoint? }
- `ProviderId`: firstParty | openai | openrouter | opencode | nvidia | bedrock | vertex | foundry | local
- `ProtocolId`: anthropic-messages | openai-chat | openai-responses | openai-compatible-chat | gemini | bedrock-converse

### ModelRuntime (orchestration)
- Thin wrapper: resolveRoute → getModelMetadata → getClientForRoute → client.query(route, request)
- No combo/fallback logic at this level
- modelMeta unused (reserved for future capabilities)

### withRetry (6-layer retry)
- Layer 1: HTTP transport retry (retryHttpRequest.ts) — exponential backoff, pre-stream
- Layer 2: OpenAI stream recovery (capacity retries + non-streaming fallback)
- Layer 3: Anthropic non-streaming fallback (withRetry)
- Layer 4: Free model fallback (OpenCode 500 → big-pickle)
- Layer 5: Upstream error detection in SSE streams
- Layer 6: Model-level fallback (FallbackTriggeredError)
- Key safety invariant: once published=true, no retries attempted

### Session Storage (current: JSONL)
- Location: ~/.claude/projects/<sanitized-project-dir>/<sessionId>.jsonl
- Format: One JSON Entry per line, append-only
- Entry type: discriminated union (TranscriptMessage | SummaryMessage | CustomTitleMessage | ...)
- Write: batched (100ms), dedup by UUID, O_APPEND
- Read: chunked forward read for >5MB, compact boundary truncation, head/tail lite for picker
- DAG structure: parentUuid linked list, supports fork/branch

### Opencode DB Storage (reference)
- SQLite with WAL mode, 5s busy_timeout, 64MB cache
- Tables: session_v2 (metadata), session_message (messages with seq), session_pending, session_inbox
- Event-sourced inbox → projection into message log
- Cursor-based pagination for UI, full load for LLM context
- Custom TypeScript migration system (50+ migrations)
- Claim/suspension mechanism for crash recovery

### 9Router DB Storage (reference)
- Adapter chain: bun:sqlite → better-sqlite3 → node:sqlite → sql.js
- Global caching for Next.js HMR
- Fail-open RTK compression
- Provider registry with auto-generated index

## Key Gaps Identified

1. **No combo fallback**: Single model per request, no multi-model cascade
2. **No token optimization**: Tool results stored verbatim, no compression
3. **No quota management**: No per-provider usage tracking or limits
4. **Provider logic scattered**: openaiChat.ts is ~1431 lines with provider-specific branches
5. **JSONL performance**: Large sessions may slow down with full-file reads
6. **No structured logging**: Console output not session-aware

## Design Constraints (from user)

1. **No fallback after first stream event**: Once content reaches TUI, cannot switch models
2. **Raw data preservation**: Compressed tool results must keep original reference
3. **Shared retry budget**: ComboEngine must not duplicate withRetry's retries
4. **Provider boundary**: Switching providers = sending data to different service, needs explicit user consent
5. **Model capabilities must be declared**: Context window, tool support, protocol per model
