/**
 * CLI Auth Provider REST API
 *
 * GET  /api/cli-auth          — read current CLI auth provider config from ~/.local/share/codev/config.json
 * PUT  /api/cli-auth          — update CLI auth provider config in ~/.local/share/codev/config.json
 * POST /api/cli-auth/invalidate — invalidate the cliProviderModelCache
 */

import { ApiError, errorResponse } from '../middleware/errorHandler.js'
import { getSessionStore } from '../../services/db/SessionStore.js'

type AuthProvider = 'anthropic' | 'openai' | 'openrouter' | 'local' | 'opencode' | 'nvidia'

type CliAuthConfig = {
  authProvider: AuthProvider | null
  nvidiaApiKey?: string
  openRouterApiKey?: string
  openAiApiKey?: string
  openAiAccessToken?: string
  openCodeApiKey?: string
  openCodeModelName?: string
  localBaseUrl?: string
  localModelName?: string
}

function readCliAuthConfig(): CliAuthConfig {
  try {
    const raw = getSessionStore().getAppDocument('config', 'global')
    if (!raw) return { authProvider: null }
    const config = JSON.parse(raw) as Record<string, unknown>
    return {
      authProvider: (config.authProvider as AuthProvider) || null,
      nvidiaApiKey: config.nvidiaApiKey as string | undefined,
      openRouterApiKey: config.openRouterApiKey as string | undefined,
      openAiApiKey: config.openAiApiKey as string | undefined,
      openAiAccessToken: config.openAiAccessToken as string | undefined,
      openCodeApiKey: config.openCodeApiKey as string | undefined,
      openCodeModelName: config.openCodeModelName as string | undefined,
      localBaseUrl: config.localBaseUrl as string | undefined,
      localModelName: config.localModelName as string | undefined,
    }
  } catch {
    return { authProvider: null }
  }
}

function writeCliAuthConfig(updates: Partial<CliAuthConfig>): void {
  getSessionStore().updateAppDocument('config', 'global', raw => {
  let config: Record<string, unknown> = raw
    ? JSON.parse(raw) as Record<string, unknown>
    : {}

  if (updates.authProvider !== undefined) {
    config.authProvider = updates.authProvider || undefined
  }

  if (updates.nvidiaApiKey !== undefined) {
    config.nvidiaApiKey = updates.nvidiaApiKey || undefined
  }

  if (updates.openRouterApiKey !== undefined) {
    config.openRouterApiKey = updates.openRouterApiKey || undefined
  }

  if (updates.openAiApiKey !== undefined) {
    config.openAiApiKey = updates.openAiApiKey || undefined
    config.openAiAccessToken = undefined
    config.openAiRefreshToken = undefined
    config.openAiTokenExpiresAt = undefined
    config.openAiWorkspaceId = undefined
  }

  if (updates.openAiAccessToken !== undefined) {
    config.openAiAccessToken = updates.openAiAccessToken || undefined
    config.openAiApiKey = undefined
    config.openAiRefreshToken = undefined
    config.openAiTokenExpiresAt = undefined
    config.openAiWorkspaceId = undefined
  }

  if (updates.openCodeApiKey !== undefined) {
    config.openCodeApiKey = updates.openCodeApiKey || undefined
  }

  if (updates.openCodeModelName !== undefined) {
    config.openCodeModelName = updates.openCodeModelName || undefined
  }

  if (updates.localBaseUrl !== undefined) {
    config.localBaseUrl = updates.localBaseUrl || undefined
  }

  if (updates.localModelName !== undefined) {
    config.localModelName = updates.localModelName || undefined
  }

  return JSON.stringify(config)
  })
}

export async function handleCliAuthApi(
  req: Request,
  _url: URL,
  segments: string[],
): Promise<Response> {
  try {
    const sub = segments[2]

    if (sub === 'invalidate') {
      if (req.method !== 'POST') throw methodNotAllowed(req.method)
      // Model listings come from the 9router gateway and are read live;
      // there is no per-provider model cache to invalidate.
      return Response.json({ ok: true })
    }

    if (!sub) {
      if (req.method === 'GET') {
        const config = readCliAuthConfig()
        return Response.json(config)
      }

      if (req.method === 'PUT') {
        const body = await parseJsonBody(req)
        writeCliAuthConfig(body as Partial<CliAuthConfig>)
        return Response.json({ ok: true })
      }

      throw methodNotAllowed(req.method)
    }

    throw ApiError.notFound(`Unknown cli-auth endpoint: ${sub}`)
  } catch (error) {
    return errorResponse(error)
  }
}

async function parseJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>
  } catch {
    throw ApiError.badRequest('Invalid JSON body')
  }
}

function methodNotAllowed(method: string): ApiError {
  return new ApiError(405, `Method ${method} not allowed`, 'METHOD_NOT_ALLOWED')
}
