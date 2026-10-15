# Task Plan: Implement Kiro AWS EventStream Protocol Handler

## Goal
Implement the AWS EventStream protocol handler so Kiro provider in codev can actually perform inference (like 9router's MITM handler does).

## Background
- 9router uses MITM proxy: intercepts Kiro IDE's EventStream requests → converts to OpenAI → routes inference → converts back to EventStream
- codev needs a native protocol handler that speaks EventStream directly to `q.us-east-1.amazonaws.com` / `runtime.us-east-1.kiro.dev`
- Current Kiro provider uses `anthropic-messages` as placeholder — inference fails

## Phases

### Phase 1: AWS EventStream Binary Framing
- [ ] Create CRC32 utility (polynomial 0xEDB88320)
- [ ] Create EventStream frame builder (prelude + headers + payload + CRC)
- [ ] Implement Smithy system headers (:message-type, :event-type, :content-type)
- [ ] Implement event types: initial-response, assistantResponseEvent, reasoningContentEvent, toolUseEvent, messageStopEvent, usageEvent

### Phase 2: CodeWhisperer ↔ OpenAI Format Conversion
- [ ] Convert CodeWhisperer `conversationState` → OpenAI `messages[]`
- [ ] Handle userInputMessage (text, images, toolResults)
- [ ] Handle assistantResponseMessage (text, toolUses)
- [ ] Extract tool definitions from request
- [ ] Convert OpenAI SSE chunks → EventStream frames (streaming)

### Phase 3: Protocol Handler Integration
- [ ] Create `aws-eventstream` protocol in `src/services/llm/protocols/`
- [ ] Register in `src/services/llm/protocols/index.ts`
- [ ] Update Kiro provider to use `aws-eventstream` protocol
- [ ] Implement auth header resolution (Bearer access_token + profile_arn + region)

### Phase 4: Testing & Integration
- [ ] Test with imported refresh token
- [ ] Verify model listing works
- [ ] Test inference end-to-end
- [ ] Handle token refresh on 401

## Reference
- 9router: `src/mitm/handlers/kiro.js` (580 lines) — complete conversion pipeline
- Key endpoints: `https://codewhisperer.{region}.amazonaws.com` (models), `https://q.{region}.amazonaws.com` (inference)
- EventStream spec: AWS Smithy protocol, binary framing with CRC32