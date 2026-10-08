# Provider Fallback Behavior

This document explains the fallback mechanism when the primary LLM provider/model fails during a request.

## What Happens on Failure

When the primary provider/model encounters an error (timeout, rate limit, 5xx, etc.), the system automatically retries the **same request** with a fallback model.

```text
Provider request failed; retrying with opencode/nemotron-3-ultra-free
```

## Key Properties

| Property | Behavior |
|----------|----------|
| **Scope** | Single request only |
| **Session config** | Unchanged — primary model remains configured |
| **Subsequent requests** | Use the original primary provider/model |
| **Fallback model** | Typically a free/low-cost model (e.g., `nemotron-3-ultra-free`) |

## What This Means for Users

- **No permanent downgrade**: Your selected model (Sonnet, Opus, Haiku, etc.) stays active for the rest of the session
- **Transparency**: The log line explicitly shows which fallback was used
- **Quality variance**: The fallback response may differ in quality/style since it's a different model
- **Cost**: Fallback models are typically free, so no unexpected charges

## When Does Fallback Trigger

- Provider API returns 5xx errors
- Request timeout
- Rate limiting (429)
- Network errors
- Authentication failures (sometimes)

## What Does NOT Happen

- ❌ Session model configuration is not changed
- ❌ No need to re-select model in settings
- ❌ No persistent fallback mode
- ❌ Does not affect other sessions or projects

## Configuration

The fallback chain is managed internally and not user-configurable. The primary model is always attempted first; fallback only activates on failure.

## Related

- [Model Selection](../cli/model-selection.md) (if exists)
- [Provider Configuration](../architecture/provider-config.md) (if exists)