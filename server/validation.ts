import { z } from 'zod'
import type { AppConfig } from './types.js'

const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']).catch('info')

const providerSchema = z
  .object({
    name: z.string().trim().min(1, 'Provider name is required'),
    api_base_url: z.string().trim().min(1, 'Provider API base URL is required'),
    api_key: z.string().default(''),
    models: z.array(z.string().trim().min(1)).default([]),
    model_aliases: z.record(z.string(), z.string()).optional(),
    transformer: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

const routeStrategySchema = z.enum(['sequence', 'loadBalance', 'random']).catch('sequence')

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
    CUSTOM_ROUTER_PATH: z.string().default(''),
  })
  .passthrough()

export function parseConfig(input: unknown): AppConfig {
  return configSchema.parse(input) as AppConfig
}

export function parseConfigJson(text: string): AppConfig {
  return parseConfig(JSON.parse(text))
}
