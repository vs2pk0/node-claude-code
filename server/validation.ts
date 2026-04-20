import { z } from 'zod'
import type { AppConfig } from './types.js'

const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']).catch('info')

const providerSchema = z
  .object({
    name: z.string().trim().min(1, 'Provider name is required'),
    api_base_url: z.string().trim().min(1, 'Provider API base URL is required'),
    api_key: z.string().default(''),
    models: z.array(z.string().trim().min(1)).default([]),
    transformer: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough()

const routerSchema = z
  .object({
    default: z.string().default(''),
    background: z.string().default(''),
    think: z.string().default(''),
    longContext: z.string().default(''),
    longContextThreshold: z.coerce.number().int().nonnegative().default(60000),
    webSearch: z.string().default(''),
    image: z.string().default(''),
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
    CUSTOM_ROUTER_PATH: z.string().default(''),
  })
  .passthrough()

export function parseConfig(input: unknown): AppConfig {
  return configSchema.parse(input) as AppConfig
}

export function parseConfigJson(text: string): AppConfig {
  return parseConfig(JSON.parse(text))
}
