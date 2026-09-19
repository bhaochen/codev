/**
 * OpenAI 兼容层 —— src/services/api/openai/
 *
 * - chatgptAuth.ts   ChatGPT 设备码登录
 *
 * OpenAI 协议转换（消息/工具/流/usage/错误）已迁移至原生实现：
 * `src/services/llm/protocols/openaiChatWire.ts`（wire 装配与 SSE 适配），
 * 请求体工具见 `src/services/llm/utils/requestBody.ts`。
 */
export {
  isChatGPTAuthEnabled,
  requestChatGPTDeviceCode,
  completeChatGPTDeviceLogin,
  getValidChatGPTAuth,
  type ChatGPTDeviceCode,
  type ChatGPTAuth,
} from './chatgptAuth.js'