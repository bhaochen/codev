/**
 * 把 OpenAI 错误响应（{error:{message,type}}）转换为 Anthropic SDK 能解析的
 * 错误格式（{"type":"error","error":{...}}），否则 SDK 解析失败导致错误信息错乱。
 */
export async function createAnthropicErrorResponse(
  openaiResponse: Response,
): Promise<Response> {
  let message = openaiResponse.statusText || 'Request failed'
  let type = 'api_error'
  try {
    const text = await openaiResponse.text()
    if (text) {
      const parsed = JSON.parse(text) as {
        error?: { message?: unknown; type?: unknown }
      }
      const err = parsed.error
      if (err) {
        if (typeof err.message === 'string' && err.message) {
          message = err.message
        }
        if (typeof err.type === 'string' && err.type) {
          type = err.type
        }
      }
    }
  } catch {
    // body 不是 JSON —— 保留默认 message
  }
  return new Response(
    JSON.stringify({ type: 'error', error: { type, message } }),
    {
      status: openaiResponse.status,
      headers: { 'Content-Type': 'application/json' },
    },
  )
}