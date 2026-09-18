/**
 * OpenAI 兼容层 —— src/services/api/openai/
 *
 * - chatgptAuth.ts   ChatGPT 设备码登录
 *
 * 转换管线（消息/工具/流/usage/错误）由共享包 @ant/model-provider 提供。
 */
export {
  isChatGPTAuthEnabled,
  requestChatGPTDeviceCode,
  completeChatGPTDeviceLogin,
  getValidChatGPTAuth,
  type ChatGPTDeviceCode,
  type ChatGPTAuth,
} from './chatgptAuth.js'