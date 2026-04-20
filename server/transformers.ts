import type { ProviderConfig } from './types.js'

type TransformerUse = Array<string | [string, Record<string, unknown>]>

export function applyProviderTransformers(
  payload: Record<string, unknown>,
  provider: ProviderConfig,
  model: string,
) {
  const maxTokens = resolveMaxTokens(provider, model)
  if (maxTokens) {
    payload.max_tokens = maxTokens
  }
}

function resolveMaxTokens(provider: ProviderConfig, model: string): number | undefined {
  const transformer = provider.transformer
  if (!transformer) {
    return undefined
  }

  const modelRule = transformer[model]
  const modelMaxTokens = readMaxTokens(modelRule)
  if (modelMaxTokens) {
    return modelMaxTokens
  }

  return readMaxTokens(transformer)
}

function readMaxTokens(rule: unknown): number | undefined {
  if (!isRecord(rule)) {
    return undefined
  }

  const direct = rule.max_tokens
  if (typeof direct === 'number' && Number.isFinite(direct)) {
    return direct
  }

  const use = rule.use
  if (!Array.isArray(use)) {
    return undefined
  }

  for (const entry of use as TransformerUse) {
    if (Array.isArray(entry) && entry[0] === 'maxtoken') {
      const config = entry[1]
      const maxTokens = config.max_tokens
      if (typeof maxTokens === 'number' && Number.isFinite(maxTokens)) {
        return maxTokens
      }
    }
  }

  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
