/**
 * CLI Auth Provider REST API
 *
 * GET  /api/cli-auth          — read current CLI auth provider config from ~/.claude.json
 * PUT  /api/cli-auth          — update CLI auth provider config in ~/.claude.json
 * POST /api/cli-auth/invalidate — invalidate the cliProviderModelCache
 */

import { homedir } from 'node:os'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

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

function getClaudeJsonPath(): string {
  return join(homedir(), '.claude.json')
}

function readCliAuthConfig(): CliAuthConfig {
  try {
    const raw = readFileSync(getClaudeJsonPath(), 'utf8')
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
  const filePath = getClaudeJsonPath()
  let config: Record<string, unknown> = {}
  try {
    const raw = readFileSync(filePath, 'utf8')
    config = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // file doesn't exist yet, start fresh
  }

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

  writeFileSync(filePath, JSON.stringify(config, null, 2) + '\n')
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
      const { invalidateCliProviderModelCache } = await import('./models.js')
      invalidateCliProviderModelCache()
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
        const { invalidateCliProviderModelCache } = await import('./models.js')
        invalidateCliProviderModelCache()
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
