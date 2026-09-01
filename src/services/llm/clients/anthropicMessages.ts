/**
 * Anthropic Messages 协议共享客户端 — anthropic / bedrock / vertex / foundry / nvidia / local 共用。
 * 各 Provider 差异仅在 Transport (SDK vs fetch-override vs native HTTP)，协议层面统一。
 * 当前 nvidia 仍 fetch-override（标注 legacy，计划迁 native-http）。
 */
export async function* queryAnthropicMessages(): AsyncGenerator<never, void, unknown> {
  throw new Error('anthropicMessages client: 直接由 claude.ts 原生 SDK 路径执行，见 queryModel 中 anthropic 分支')
}
