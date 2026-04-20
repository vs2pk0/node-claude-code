import { estimateTokens } from './token.js'
import type { AppConfig, ProviderConfig, RouteDecision } from './types.js'

type RouterRouteKey = 'default' | 'background' | 'think' | 'longContext' | 'image'

export function resolveRoute(config: AppConfig, body: Record<string, unknown>): RouteDecision {
  const requestedModel = String(body.model ?? '')
  const directTarget = parseTarget(requestedModel)

  if (directTarget) {
    return resolveTarget(config, directTarget.provider, directTarget.model, 'model')
  }

  const providerByModel = findProviderByModel(config.Providers, requestedModel)
  if (providerByModel) {
    return {
      provider: providerByModel,
      providerName: providerByModel.name,
      targetModel: requestedModel,
      routeKey: 'model',
    }
  }

  const routeKey = chooseRouteKey(config, body)
  const targetValue = String(config.Router[routeKey] || config.Router.default || '')
  const target = parseTarget(targetValue)
  if (!target) {
    throw httpError(400, `Router.${routeKey} is empty or invalid`)
  }

  return resolveTarget(config, target.provider, target.model, routeKey)
}

export function allModels(config: AppConfig) {
  return config.Providers.flatMap((provider) =>
    provider.models.map((model) => ({
      id: model,
      object: 'model',
      owned_by: provider.name,
    })),
  )
}

export function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number }
  error.status = status
  return error
}

function chooseRouteKey(config: AppConfig, body: Record<string, unknown>): RouterRouteKey {
  const inputTokens = estimateTokens(body.messages)
  const threshold = config.Router.longContextThreshold

  if (hasImage(body.messages) && config.Router.image) {
    return 'image'
  }

  if (threshold > 0 && inputTokens >= threshold && config.Router.longContext) {
    return 'longContext'
  }

  const model = String(body.model ?? '').toLowerCase()
  if ((model.includes('think') || model.includes('reason')) && config.Router.think) {
    return 'think'
  }

  if ((model.includes('haiku') || model.includes('small') || model.includes('fast')) && config.Router.background) {
    return 'background'
  }

  return 'default'
}

function resolveTarget(config: AppConfig, providerName: string, model: string, routeKey: string): RouteDecision {
  const provider = config.Providers.find((item) => item.name === providerName)
  if (!provider) {
    throw httpError(400, `Provider "${providerName}" was not found`)
  }

  if (!provider.api_base_url) {
    throw httpError(400, `Provider "${providerName}" is missing api_base_url`)
  }

  return {
    provider,
    providerName,
    targetModel: model,
    routeKey,
  }
}

function findProviderByModel(providers: ProviderConfig[], model: string): ProviderConfig | undefined {
  if (!model) {
    return undefined
  }
  return providers.find((provider) => provider.models.includes(model))
}

function parseTarget(value: string) {
  const [provider, ...modelParts] = value.split(',')
  const model = modelParts.join(',').trim()

  if (!provider?.trim() || !model) {
    return undefined
  }

  return {
    provider: provider.trim(),
    model,
  }
}

function hasImage(value: unknown): boolean {
  if (!value) {
    return false
  }

  if (Array.isArray(value)) {
    return value.some(hasImage)
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (record.type === 'image' || record.type === 'image_url') {
      return true
    }
    return Object.values(record).some(hasImage)
  }

  return false
}
