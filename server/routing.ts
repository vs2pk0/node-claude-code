import { estimateTokens } from './token.js'
import { requestConcurrencyLimiter } from './concurrency.js'
import type { AppConfig, ProviderConfig, RouteDecision, RouterConfig, RouterRuleConfig } from './types.js'

type RouterRouteKey = 'default' | 'background' | 'think' | 'longContext' | 'image'
type RouteTarget = { provider: string; model: string }
type ProviderModelTarget = { provider: ProviderConfig; model: string }

const routeKeys: RouterRouteKey[] = ['default', 'background', 'think', 'longContext', 'image']
const routeCursorByKey = new Map<string, number>()

export function resolveRoute(config: AppConfig, body: Record<string, unknown>): RouteDecision {
  const requestedModel = String(body.model ?? '')
  const directTarget = parseTarget(requestedModel)

  if (directTarget) {
    return resolveTarget(config, directTarget.provider, directTarget.model, 'model')
  }

  const priorityRouteKey = choosePriorityRouteKey(config, body)
  if (priorityRouteKey) {
    return resolveRouterRule(config, priorityRouteKey)
  }

  const routeModelKey = findRouteKeyByModel(config.Router, requestedModel)
  if (routeModelKey) {
    return resolveRouterRule(config, routeModelKey)
  }

  const routeTargetKey = findRouteKeyByTargetModel(config, requestedModel)
  if (routeTargetKey) {
    return resolveRouterRule(config, routeTargetKey)
  }

  const providerByModel = findProviderByModel(config.Providers, requestedModel)
  if (providerByModel) {
    return {
      provider: providerByModel.provider,
      providerName: providerByModel.provider.name,
      targetModel: providerByModel.model,
      routeKey: 'model',
      delayMs: 0,
    }
  }

  const routeKey = chooseFallbackRouteKey(config, body)
  return resolveRouterRule(config, routeKey)
}

export function allModels(config: AppConfig) {
  const routeModels = routeKeys
    .map((routeKey) => config.Router[routeKey])
    .filter((rule) => rule.model)
    .map((rule) => ({
      id: rule.model,
      object: 'model',
      owned_by: 'router',
    }))

  const providerModels = config.Providers.flatMap((provider) =>
    provider.models.map((model) => ({
      id: publicProviderModelId(provider, model),
      object: 'model',
      owned_by: provider.name,
    })),
  )

  const codexModels = config.Codex.enabled
    ? config.Codex.models.flatMap((model) => {
      const ids = model.alias && model.alias !== model.name ? [model.name, model.alias] : [model.name]
      return ids.map((id) => ({
        id,
        object: 'model',
        owned_by: 'codex',
      }))
    })
    : []

  const seen = new Set<string>()
  return [...routeModels, ...providerModels, ...codexModels].filter((model) => {
    if (seen.has(model.id)) {
      return false
    }

    seen.add(model.id)
    return true
  })
}

export function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number }
  error.status = status
  return error
}

function choosePriorityRouteKey(config: AppConfig, body: Record<string, unknown>): RouterRouteKey | undefined {
  const messages = body.messages
  const threshold = config.Router.longContextThreshold

  if (hasRouterTargets(config.Router.image) && hasImage(messages)) {
    return 'image'
  }

  if (
    threshold > 0 &&
    hasRouterTargets(config.Router.longContext) &&
    estimateTokens(messages) >= threshold
  ) {
    return 'longContext'
  }

  return undefined
}

function chooseFallbackRouteKey(config: AppConfig, body: Record<string, unknown>): RouterRouteKey {
  const model = String(body.model ?? '').toLowerCase()
  if ((model.includes('think') || model.includes('reason')) && hasRouterTargets(config.Router.think)) {
    return 'think'
  }

  if ((model.includes('haiku') || model.includes('small') || model.includes('fast')) && hasRouterTargets(config.Router.background)) {
    return 'background'
  }

  return 'default'
}

function findRouteKeyByModel(router: RouterConfig, model: string): RouterRouteKey | undefined {
  if (!model.trim()) {
    return undefined
  }

  return routeKeys.find((routeKey) => {
    const rule = router[routeKey]
    return rule.model === model && hasRouterTargets(rule)
  })
}

function resolveRouterRule(config: AppConfig, routeKey: RouterRouteKey): RouteDecision {
  const rule = config.Router[routeKey]
  const targets = rule.targets.map(parseTarget).filter((target): target is RouteTarget => Boolean(target))
  if (!targets.length) {
    throw httpError(400, `Router.${routeKey}.targets is empty or invalid`)
  }

  const target = selectTarget(routeKey, rule, targets)
  return resolveTarget(config, target.provider, target.model, routeKey, rule.delayMs)
}

function findRouteKeyByTargetModel(config: AppConfig, model: string): RouterRouteKey | undefined {
  if (!model.trim()) {
    return undefined
  }

  return routeKeys.find((routeKey) => {
    const rule = config.Router[routeKey]
    if (!hasRouterTargets(rule)) {
      return false
    }

    return rule.targets.some((targetValue) => {
      const target = parseTarget(targetValue)
      return target ? routeTargetMatchesModel(config, target, model) : false
    })
  })
}

function routeTargetMatchesModel(config: AppConfig, target: RouteTarget, model: string) {
  if (target.model === model) {
    return true
  }

  if (isCodexProvider(target.provider)) {
    return config.Codex.models.some((item) => item.name === target.model && item.alias === model)
  }

  const provider = config.Providers.find((item) => item.name === target.provider)
  return provider?.model_aliases?.[target.model] === model
}

function selectTarget(
  routeKey: RouterRouteKey,
  rule: RouterRuleConfig,
  targets: RouteTarget[],
): RouteTarget {
  if (rule.strategy === 'random') {
    return targets[Math.floor(Math.random() * targets.length)]
  }

  if (rule.strategy === 'loadBalance') {
    return [...targets]
      .map((target, index) => ({
        target,
        index,
        targetActive: requestConcurrencyLimiter.activeTargetCount(target.provider, target.model),
        providerActive: requestConcurrencyLimiter.activeProviderCount(target.provider),
      }))
      .sort((left, right) => {
        return (
          left.targetActive - right.targetActive ||
          left.providerActive - right.providerActive ||
          left.index - right.index
        )
      })[0].target
  }

  const cursorKey = `${routeKey}:${rule.model}:${targets.map((target) => `${target.provider},${target.model}`).join('|')}`
  const cursor = routeCursorByKey.get(cursorKey) ?? 0
  routeCursorByKey.set(cursorKey, cursor + 1)
  return targets[cursor % targets.length]
}

function hasRouterTargets(rule: RouterRuleConfig) {
  return rule.targets.some((target) => Boolean(parseTarget(target)))
}

function resolveTarget(
  config: AppConfig,
  providerName: string,
  model: string,
  routeKey: string,
  delayMs = 0,
): RouteDecision {
  if (isCodexProvider(providerName)) {
    if (!config.Codex.enabled) {
      throw httpError(400, 'Codex proxy is disabled')
    }

    return {
      provider: codexRouteProvider(config),
      providerName: 'codex',
      targetModel: resolveCodexTargetModel(config, model),
      routeKey,
      delayMs,
    }
  }

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
    delayMs,
  }
}

function isCodexProvider(providerName: string) {
  return providerName.toLowerCase() === 'codex'
}

function resolveCodexTargetModel(config: AppConfig, model: string) {
  const codexModel = config.Codex.models.find((item) => item.name === model || item.alias === model)
  return codexModel?.name || model
}

function codexRouteProvider(config: AppConfig): ProviderConfig {
  return {
    name: 'codex',
    api_base_url: config.Codex.baseUrl,
    api_protocol: 'anthropic-messages',
    api_key: config.Codex.apiKey,
    api_keys: [],
    api_key_names: [],
    api_key_disabled: [],
    api_key_strategy: 'sequence',
    models: config.Codex.models.map((model) => model.name),
    model_aliases: Object.fromEntries(
      config.Codex.models
        .filter((model) => model.alias && model.alias !== model.name)
        .map((model) => [model.name, model.alias]),
    ),
    claude_code_forward: false,
    transformer: {},
  }
}

function findProviderByModel(providers: ProviderConfig[], model: string): ProviderModelTarget | undefined {
  if (!model) {
    return undefined
  }

  for (const provider of providers) {
    if (provider.models.includes(model)) {
      return {
        provider,
        model,
      }
    }

    const aliasedModel = provider.models.find((item) => publicProviderModelId(provider, item) === model)
    if (aliasedModel) {
      return {
        provider,
        model: aliasedModel,
      }
    }
  }

  return undefined
}

function publicProviderModelId(provider: ProviderConfig, model: string) {
  const alias = provider.model_aliases?.[model]
  return typeof alias === 'string' && alias.trim() ? alias.trim() : model
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
