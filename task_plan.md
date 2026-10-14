# Codev LLM Architecture Improvement Plan

## Goal
Improve codev's LLM runtime reliability, token efficiency, and maintainability by implementing:
- P0: Combo Fallback with safe streaming semantics
- P1: Provider Executor separation
- P2: RTK Token Saver for tool output compression
- P3: Usage/Quota tracking
- P4: Translator Registry (deferred)
- P5: SQLite session storage migration
- P6: Session-aware structured logging

## Constraints (Non-negotiable)
1. **Reliability > fallback coverage**: Never break in-flight streaming responses
2. **Raw data preservation**: Compressed tool results must retain original reference
3. **Abstraction driven by real need**: No speculative interfaces

## Phases

### Phase 0: Baseline Audit & Tests
- [ ] Document current LLMRequest, ResolvedRoute, LLMStreamEvent types
- [ ] Document current withRetry 6-layer retry system
- [ ] Add regression tests for streaming cancel, tool calls, error propagation
- [ ] Benchmark current JSONL session append performance

### Phase 1: P0 Combo Fallback
- [ ] Design ComboEngine interface (candidate selection + cross-model fallback)
- [ ] Define error classification (pre-stream vs post-stream failures)
- [ ] Implement "no fallback after first event" safety invariant
- [ ] Integrate with existing withRetry (shared budget)
- [ ] Add combo configuration to settings
- [ ] Tests: pre-stream failure, post-stream failure, 429, timeout, cancel, all exhausted

### Phase 2: P1 Provider Executor Separation
- [ ] Define ProviderAdapter interface (auth, URL, headers, timeout)
- [ ] Define ProtocolWireAdapter interface (request/response/stream)
- [ ] Define CompatibilityPolicy interface (model-specific quirks)
- [ ] Migrate OpenRouter-specific logic first (most complex)
- [ ] Migrate NVIDIA-specific logic
- [ ] Migrate OpenCode-specific logic
- [ ] Tests: request/response snapshots, SSE event order, tool calls, usage

### Phase 3: P2 RTK Token Saver
- [ ] Design CompressionResult interface (content + raw ref + metadata)
- [ ] Implement per-tool-type filters (bash, grep, git diff, file read)
- [ ] Integrate at tool execution → context construction boundary
- [ ] Add artifact store for original content
- [ ] Tests: compression integrity, original recovery, error preservation

### Phase 4: P3 Usage/Quota + P6 Logging
- [ ] Implement UsageTracker (per-request token/retry/failure recording)
- [ ] Implement PricingService (versioned pricing table)
- [ ] Implement QuotaManager (atomic reserve + settle)
- [ ] Implement structured session-aware logging
- [ ] Tests: concurrent reserve, window reset, rate limit headers

### Phase 5: P5 SQLite Session Storage
- [ ] Design schema (sessions, messages, metadata tables)
- [ ] Implement SQLite driver with WAL mode
- [ ] Implement JSONL → SQLite migration tool
- [ ] Implement pagination for message reads
- [ ] Tests: JSON migration, crash recovery, concurrent access, large session benchmark

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
