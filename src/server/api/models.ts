/**
 * Models REST API
 *
 * GET  /api/models          — 获取可用模型列表
 * GET  /api/models/current  — 获取当前选中的模型
 * PUT  /api/models/current  — 切换模型
 * GET  /api/effort          — 获取 Effort 等级
 * PUT  /api/effort          — 设置 Effort 等级
 */

import { SettingsService } from '../services/settingsService.js'
import { ApiError, errorResponse } from '../middleware/errorHandler.js'

const EFFORT_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const DEFAULT_EFFORT = 'medium'

const settingsService = new SettingsService()

type ApiModelInfo = {
  id: string
  name: string
  description: string
  context: string
}

async function handleModelsList(): Promise<Response> {
  const { fetchNineRouterModels } = await import(
    '../../utils/model/nineRouterModels.js'
  )
  const models = await fetchNineRouterModels()
  return Response.json({
    models: models.map(model => ({
      id: model.value,
      name: model.label,
      description: model.description,
      context: '',
    })),
    provider: { id: '9router', name: '9router' },
  })
}

async function handleCurrentModel(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    const settings = await settingsService.getUserSettings()
    const explicitModel = (settings.model as string) || ''
    const contextTier = (settings.modelContext as string) || undefined
    const envModel = process.env.ANTHROPIC_MODEL?.trim() || ''

    const currentModelId = explicitModel || envModel
    const currentModelName = currentModelId || 'No model configured'

    const lookupId = contextTier ? `${currentModelId}:${contextTier}` : currentModelId

    const { fetchNineRouterModels } = await import(
      '../../utils/model/nineRouterModels.js'
    )
    const availableModels = (await fetchNineRouterModels()).map(model => ({
      id: model.value,
      name: model.label,
      description: model.description,
      context: '',
    }))

    const modelEntry = availableModels.find((m) => m.id === lookupId)
      || availableModels.find((m) => m.id === currentModelId)
      || {
        id: currentModelId,
        name: currentModelName,
        description: 'Custom model',
        context: contextTier || 'unknown',
      }

    return Response.json({ model: { ...modelEntry, context: contextTier || modelEntry.context } })
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    const modelId = body.modelId
    if (typeof modelId !== 'string' || !modelId) {
      throw ApiError.badRequest('Missing or invalid "modelId" in request body')
    }

    // Parse composite IDs like 'claude-opus-4-7-20250610:1m'
    // Persist the base model ID for CLI compatibility and context tier separately
    const colonIdx = modelId.indexOf(':')
    const baseId = colonIdx !== -1 ? modelId.slice(0, colonIdx) : modelId
    const contextTier = colonIdx !== -1 ? modelId.slice(colonIdx + 1) : undefined

    const updates: Record<string, unknown> = { model: baseId }
    if (contextTier) {
      updates.modelContext = contextTier
    } else {
      // Clear context tier when switching to a non-composite model
      updates.modelContext = undefined
    }
    await settingsService.updateUserSettings(updates)
    return Response.json({ ok: true, model: modelId })
  }

  throw methodNotAllowed(req.method)
}

async function handleEffort(req: Request): Promise<Response> {
  if (req.method === 'GET') {
    const settings = await settingsService.getUserSettings()
    const level = normalizeEffortLevel(settings.effort)
    return Response.json({ level, available: EFFORT_LEVELS })
  }

  if (req.method === 'PUT') {
    const body = await parseJsonBody(req)
    const level = body.level
    if (typeof level !== 'string') {
      throw ApiError.badRequest('Missing or invalid "level" in request body')
    }
    if (!EFFORT_LEVELS.includes(level as (typeof EFFORT_LEVELS)[number])) {
      throw ApiError.badRequest(
        `Invalid effort level: "${level}". Valid levels: ${EFFORT_LEVELS.join(', ')}`,
      )
    }
    await settingsService.updateUserSettings({ effort: level })
    return Response.json({ ok: true, level })
  }

  throw methodNotAllowed(req.method)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
