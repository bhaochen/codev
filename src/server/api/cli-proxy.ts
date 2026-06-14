/**
 * CLI Proxy API — proxies chat requests for desktop WebView.
 *
 * Desktop WebView cannot call provider APIs directly due to CORS restrictions.
 * This endpoint reads auth config from ~/.claude.json and proxies the request
 * server-side (no CORS).
 *
 * POST /api/cli-proxy/messages — Anthropic Messages API (streaming/non-streaming)
 * POST /api/cli-proxy/chat/completions — OpenAI Chat Completions (streaming/non-streaming)
 */

import { readCliAuthProvider } from './models.js'

type ProviderClientConfig = {
  baseUrl: string
  apiKey: string
  model: string
  protocol: 'anthropic' | 'openai'
}

// Map authProvider to API config
async function getCliProviderConfig(): Promise<ProviderClientConfig | null> {
  const config = await readCliAuthProvider()
  const authProvider = config?.authProvider

  switch (authProvider) {
    case 'openrouter': {
      const apiKey = config?.openRouterApiKey as string | undefined
      if (!apiKey) return null
      const model = (config?.openRouterModel as string) || 'anthropic/claude-sonnet-4-6'
      return {
        baseUrl: (config?.openRouterBaseUrl as string) || 'https://openrouter.ai/api/v1',
        apiKey,
        model,
        protocol: 'anthropic',
      }
    }

    case 'nvidia': {
      const apiKey = config?.nvidiaApiKey as string | undefined
      if (!apiKey) return null
      const model = (config?.nvidiaModel as string) || 'nvidia/llama-3.1-nemotron-70b-instruct'
      return {
        baseUrl: (config?.nvidiaBaseUrl as string) || 'https://integrate.api.nvidia.com/v1',
        apiKey,
        model,
        protocol: 'openai',
      }
    }

    case 'opencode': {
      const apiKey = (config?.openCodeApiKey as string) || 'public'
      const model = (config?.openCodeModelName as string) || 'big-pickle'
      return {
        baseUrl: 'https://opencode.ai/zen/v1',
        apiKey,
        model,
        protocol: 'openai',
      }
    }

    case 'openai': {
      const apiKey = (config?.openAiApiKey as string) || (config?.openAiAccessToken as string)
      if (!apiKey) return null
      const model = (config?.openAiModel as string) || 'gpt-5.4-codex'
      return {
        baseUrl: (config?.openAiBaseUrl as string) || 'https://api.openai.com/v1',
        apiKey,
        model,
        protocol: 'openai',
      }
    }

    case 'local': {
      const baseUrl = config?.localBaseUrl as string
      if (!baseUrl) return null
      const model = (config?.localModelName as string) || 'local-model'
      return {
        baseUrl,
        apiKey: 'local-model',
        model,
        protocol: 'openai',
      }
    }

    case 'anthropic': {
      const apiKey = config?.anthropicApiKey as string | undefined
      if (!apiKey) return null
      const model = (config?.anthropicModel as string) || 'claude-sonnet-4-6'
      return {
        baseUrl: (config?.anthropicBaseUrl as string) || 'https://api.anthropic.com/v1',
        apiKey,
        model,
        protocol: 'anthropic',
      }
    }

    default:
      return null
  }
}

export async function handleCliProxyApi(
  req: Request,
  url: URL,
  segments: string[],
): Promise<Response> {
  const resource = segments[2] // 'messages' | 'chat' | ...

  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  const providerConfig = await getCliProviderConfig()
  if (!providerConfig) {
    return Response.json(
      { type: 'error', error: { type: 'authentication_error', message: 'No CLI auth configured. Run /login first.' } },
      { status: 401 },
    )
  }

  if (resource === 'messages') {
    // Anthropic Messages API
    return handleAnthropicMessages(req, providerConfig)
  }

  if (resource === 'chat' && segments[3] === 'completions') {
    // OpenAI Chat Completions API
    return handleOpenAiChat(req, providerConfig)
  }

  return Response.json({ error: 'Not found' }, { status: 404 })
}

async function handleAnthropicMessages(incomingReq: Request, cfg: ProviderClientConfig): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = (await incomingReq.json()) as Record<string, unknown>
  } catch {
    return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON' } }, { status: 400 })
  }

  // Override model from config (desktop may send a different one)
  const model = (body.model as string) || cfg.model

  const url = `${cfg.baseUrl.replace(/\/$/, '')}/messages`
  const isStream = body.stream === true

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...body, model }),
      signal: AbortSignal.timeout(120_000),
    })

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '')
      return Response.json(
        { type: 'error', error: { type: 'api_error', message: `Upstream ${upstream.status}: ${errText.slice(0, 500)}` } },
        { status: upstream.status },
      )
    }

    if (isStream && upstream.body) {
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      })
    }

    const data = await upstream.json()
    return Response.json(data)
  } catch (err) {
    return Response.json(
      { type: 'error', error: { type: 'api_error', message: err instanceof Error ? err.message : String(err) } },
      { status: 502 },
    )
  }
}

async function handleOpenAiChat(incomingReq: Request, cfg: ProviderClientConfig): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = (await incomingReq.json()) as Record<string, unknown>
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const model = (body.model as string) || cfg.model
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`
  const isStream = body.stream === true

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ ...body, model }),
      signal: AbortSignal.timeout(120_000),
    })

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '')
      return Response.json(
        { error: `Upstream ${upstream.status}: ${errText.slice(0, 500)}` },
        { status: upstream.status },
      )
    }

    if (isStream && upstream.body) {
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      })
    }

    const data = await upstream.json()
    return Response.json(data)
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    )
  }
}