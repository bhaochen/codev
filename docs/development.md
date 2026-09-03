# 开发指南

> 面向新贡献者与面试者的最小可运行知识集，聚焦 `src/services/llm/` 单轨 Native Runtime (Phase 1-12)。

## 快速开始

```bash
bun install
bun test src/services/llm          # 89 pass 预期
bun x tsc --noEmit | grep -v QueryEngine  # 已知无关错误
bun run dev                        # Ink REPL
```

## 新增 Provider (6 步, 无需改 Transport)

1. `src/services/llm/providers/<id>.ts` — `{id, defaultProtocol, defaultEndpoint}` (`utils/model/providers.ts:6` 同步 `APIProvider`)
2. `utils/model/providers.ts` — `isXxxConfigured()` + `getAPIProvider()` 分支
3. 若新 wire format: `src/services/llm/protocols/<proto>.ts` + `protocols/index.ts:23` 注册 `handler`
4. Auth 复用: `auth/strategies.ts:10` `bearer/api-key/none` 或新增, `auth/resolveAuth.ts:22` 映射
5. Model 特殊映射: `models/modelResolver.ts:42` (多数 passthrough)
6. 验证: `resolveRoute({model,protocol,endpoint})` 3 组合 + `bun test src/services/llm`

> 已废弃: `src/services/api/client.ts:createXxxFetchOverride` / `getAnthropicClient` 注入 (Phase 5 后走 `ProtocolRegistry → Transport`)

## 测试矩阵

| 层 | 文件 | 覆盖 |
|---|---|---|
| Route | `router/resolveRoute.test.ts` + `providers/providerDecoupling.test.ts` | 8+5 provider×protocol×endpoint |
| ProtocolRegistry | `protocols/protocolRegistry.test.ts` | 7 (4 handler + 2 unsupported + metadata) |
| Transport | `transport/transport.test.ts` | 7 (跨 chunk, `[DONE]`, event) |
| Responses | `protocols/openaiResponses.test.ts` | 6 (delta/completed/unknown) |
| Auth | `auth/auth.test.ts` | 9 (bearer 复用, api-key, none) |
| ModelResolver | `models/modelResolver.test.ts` | 6 (passthrough/openai/opencode) |
| ModelRegistry | `models/registry.test.ts` + `registry.merge.test.ts` | 8 + 9 (local>dev>default, canonical `provider/model`) |
| Cache | `models/modelsDevCache.test.ts` | 6 (hit/miss/expired/corrupt/offline) |

## 架构速览 (Phase 1-12)

```
Provider {defaultProtocol,defaultEndpoint} + ModelResolver → canonical → ModelRegistry local>models.dev → Route {provider,protocol,model,endpoint}
  ↓
ProtocolRegistry.getHandler(protocol) → handler
  ↓ headers←AuthStrategy(bearer/api-key/none) → Transport.httpRequest → Framing.parseSSERaw → Adapter → StreamEvent
```

* `Phase 1-4`: Registry 声明 → Responses 拆分 `/responses` → Compatible 任意 baseURL → Route 4字段 (`7d0bc7c`)
* `Phase 5-6`: Transport/Framing (`a939f5a`) + Responses adapter (`6dfdd51`)
* `Phase 7-9`: Auth Strategy (`d59db90`) → Registry 唯一源 (`91b8fc9`) → Provider≠Protocol (`d752e69`)
* `Phase 10-12`: ModelResolver (`4225283`) → ModelRegistry (`c5901ae`) → Adapter 纯函数 (`df13a0f`) → Merge (`b9503eb`) → Cache XDG 24h (`e1fa95a`) → Audit (`5518b94`)

详见 `architecture/provider-auth.md` §11-12 与 `architecture/overview.md` §3 表。

## 调试

* `bun test src/services/llm -t "resolveRoute"` 单测
* `CODEV_MODELS_CACHE_PATH=/tmp/cache.json bun test` 覆盖缓存路径
* `src/services/llm/runtime/invariant.test.ts` 锁死 `claude.ts` 已删 / `ModelRuntime` 无 provider 分支

## 面试话术 (30s)

> “Codev 从双路由收敛为单轨 Native: `Route{4字段}` 最小事实, `Provider≠Protocol≠Model` 经 `Route` 组合, `ProtocolRegistry` 唯一源, `Transport/Framing` 最小, `Auth` 策略复用, `ModelRegistry local>models.dev` 带 24h 缓存, 89 单测覆盖组合与边界, 新增 Provider 仅加 `providers/<id>.ts` 元数据。”

