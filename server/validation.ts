import { z } from 'zod'
import type { AppConfig } from './types.js'

const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']).catch('info')
const modelFormatModeSchema = z.enum(['default', 'claude-code']).catch('default')
const apiProtocolSchema = z.enum(['openai-chat', 'anthropic-messages']).catch('openai-chat')
const routeStrategySchema = z.enum(['sequence', 'loadBalance', 'random']).catch('sequence')

const providerSchema = z
  .object({
    name: z.string().trim().min(1, 'Provider name is required'),
    api_base_url: z.string().trim().min(1, 'Provider API base URL is required'),
    api_protocol: apiProtocolSchema.optional(),
    api_key: z.string().default(''),
    api_keys: z.array(z.string()).default([]),
    api_key_names: z.array(z.string()).default([]),
    api_key_disabled: z.array(z.coerce.boolean()).default([]),
    api_key_strategy: routeStrategySchema.default('sequence'),
    models: z.array(z.string().trim().min(1)).default([]),
    model_aliases: z.record(z.string(), z.string()).optional(),
    model_formats: z.record(z.string(), modelFormatModeSchema).optional(),
    claude_code_forward: z.coerce.boolean().default(false),
    transformer: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()
  .transform((provider) => {
    const apiKeyEntries = normalizeApiKeyEntries(
      provider.api_keys,
      provider.api_key_names,
      provider.api_key_disabled,
      provider.api_key,
    )
    const apiProtocol = provider.api_protocol ?? (provider.claude_code_forward ? 'anthropic-messages' : 'openai-chat')
    return {
      ...provider,
      api_protocol: apiProtocol,
      api_key: apiKeyEntries.keys.find((_, index) => !apiKeyEntries.disabled[index]) ?? '',
      api_keys: apiKeyEntries.keys,
      api_key_names: apiKeyEntries.names,
      api_key_disabled: apiKeyEntries.disabled,
      claude_code_forward: apiProtocol === 'anthropic-messages',
    }
  })

function routerRuleSchema(defaultModel: string) {
  return z
    .preprocess((input) => {
      if (typeof input === 'string') {
        return {
          model: defaultModel,
          targets: input.trim() ? [input] : [],
          strategy: 'sequence',
        }
      }

      if (input && typeof input === 'object' && !Array.isArray(input)) {
        const record = input as Record<string, unknown>
        const targets = Array.isArray(record.targets)
          ? record.targets
          : typeof record.target === 'string'
            ? [record.target]
            : []
        return {
          ...record,
          targets,
        }
      }

      return {
        model: defaultModel,
        targets: [],
        strategy: 'sequence',
      }
    }, z
      .object({
        model: z.string().trim().default(defaultModel),
        targets: z.array(z.string().trim().min(1)).default([]),
        strategy: routeStrategySchema.default('sequence'),
        delayMs: z.coerce.number().int().nonnegative().default(0),
      })
      .passthrough())
    .transform((rule) => ({
      ...rule,
      model: rule.model || defaultModel,
      delayMs: Math.max(0, rule.delayMs),
    }))
}

const routerSchema = z
  .object({
    default: routerRuleSchema('claude-sonnet-4-6'),
    background: routerRuleSchema('claude-haiku-4-5-20251001'),
    think: routerRuleSchema('claude-opus-4-7'),
    longContext: routerRuleSchema('claude-sonnet-4-6'),
    longContextThreshold: z.coerce.number().int().nonnegative().default(60000),
    webSearch: z.string().default(''),
    image: routerRuleSchema('claude-sonnet-4-6'),
  })
  .passthrough()

const concurrencySchema = z
  .object({
    enabled: z.coerce.boolean().default(true),
    maxConcurrent: z.coerce.number().int().positive().default(4),
    maxConcurrentPerProvider: z.coerce.number().int().positive().default(1),
    maxQueueSize: z.coerce.number().int().positive().default(64),
    queueTimeoutMs: z.coerce.number().int().positive().default(300000),
  })
  .passthrough()

const statsSchema = z
  .object({
    excludeFailedTokens: z.coerce.boolean().default(false),
  })
  .passthrough()

const codexModelSchema = z
  .object({
    name: z.string().default(''),
    alias: z.string().default(''),
  })
  .passthrough()

const defaultCodexModels = [
  { name: 'gpt-5.2', alias: 'gpt-5.2' },
  { name: 'gpt-5.3-codex', alias: 'gpt-5.3-codex' },
  { name: 'gpt-5.3-codex-spark', alias: 'gpt-5.3-codex-spark' },
  { name: 'gpt-5.4', alias: 'gpt-5.4' },
  { name: 'gpt-5.4-mini', alias: 'gpt-5.4-mini' },
  { name: 'gpt-5.5', alias: 'gpt-5.5' },
  { name: 'gpt-5-codex', alias: 'gpt-5-codex' },
  { name: 'gpt-5', alias: 'gpt-5' },
  { name: 'codex-auto-review', alias: 'codex-auto-review' },
  { name: 'gpt-image-2', alias: 'gpt-image-2' },
]

const codexSchema = z
  .object({
    enabled: z.coerce.boolean().default(false),
    apiKey: z.string().default(''),
    authFilePath: z.string().default(''),
    authDirectory: z.string().default('codex-auths'),
    baseUrl: z.string().default('https://chatgpt.com/backend-api/codex'),
    accountId: z.string().default(''),
    userAgent: z.string().default('codex-tui/0.118.0'),
    betaFeatures: z.string().default(''),
    headers: z.record(z.string(), z.string()).default({}),
    models: z.array(codexModelSchema).default(defaultCodexModels),
  })
  .passthrough()
  .transform((codex) => ({
    ...codex,
    models: mergeDefaultCodexModels(codex.models),
  }))

const uiSchema = z
  .object({
    showModelConflictWarnings: z.coerce.boolean().default(true),
    enableBrowserUiAccess: z.coerce.boolean().default(true),
  })
  .passthrough()

export const configSchema = z
  .object({
    LOG: z.coerce.boolean().default(true),
    LOG_LEVEL: logLevelSchema,
    CLAUDE_PATH: z.string().default(''),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4568),
    APIKEY: z.string().default(''),
    API_TIMEOUT_MS: z.union([z.string(), z.number()]).transform(String).default('600000'),
    PROXY_URL: z.string().default(''),
    transformers: z.array(z.unknown()).default([]),
    Providers: z.array(providerSchema).default([]),
    StatusLine: z.record(z.string(), z.unknown()).default({}),
    Router: routerSchema,
    Concurrency: concurrencySchema.default({
      enabled: true,
      maxConcurrent: 4,
      maxConcurrentPerProvider: 1,
      maxQueueSize: 64,
      queueTimeoutMs: 300000,
    }),
    Stats: statsSchema.default({
      excludeFailedTokens: false,
    }),
    Codex: codexSchema.default({
      enabled: false,
      apiKey: '',
      authFilePath: '',
      authDirectory: 'codex-auths',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      accountId: '',
      userAgent: 'codex-tui/0.118.0',
      betaFeatures: '',
      headers: {},
      models: defaultCodexModels,
    }),
    UI: uiSchema.default({
      showModelConflictWarnings: true,
      enableBrowserUiAccess: true,
    }),
    CUSTOM_ROUTER_PATH: z.string().default(''),
  })
  .passthrough()

export function parseConfig(input: unknown): AppConfig {
  return configSchema.parse(input) as AppConfig
}

export function parseConfigJson(text: string): AppConfig {
  return parseConfig(JSON.parse(text))
}

function mergeDefaultCodexModels(models: Array<{ name: string; alias: string }>) {
  const existingKeys = new Set(models.flatMap((model) => [model.name, model.alias].filter(Boolean)))
  return [
    ...models,
    ...defaultCodexModels.filter((model) => !existingKeys.has(model.name) && !existingKeys.has(model.alias)),
  ]
}

function normalizeApiKeyEntries(
  apiKeys: string[],
  apiKeyNames: string[],
  apiKeyDisabled: boolean[],
  legacyApiKey: string,
) {
  const seen = new Set<string>()
  const keys: string[] = []
  const names: string[] = []
  const disabled: boolean[] = []

  for (let index = 0; index < apiKeys.length; index += 1) {
    const key = apiKeys[index].trim()
    if (!key || seen.has(key)) {
      continue
    }

    seen.add(key)
    keys.push(key)
    names.push(apiKeyNames[index]?.trim() ?? '')
    disabled.push(apiKeyDisabled[index] === true)
  }

  const legacyKey = legacyApiKey.trim()
  if (legacyKey && !seen.has(legacyKey)) {
    keys.push(legacyKey)
    names.push('')
    disabled.push(false)
  }

  return { keys, names, disabled }
}
