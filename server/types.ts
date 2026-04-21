export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type RouterStrategy = 'sequence' | 'loadBalance' | 'random'
export type ModelFormatMode = 'default' | 'claude-code'

export interface ProviderConfig {
  name: string
  api_base_url: string
  api_key: string
  api_keys: string[]
  api_key_names: string[]
  api_key_disabled: boolean[]
  api_key_strategy: RouterStrategy
  models: string[]
  model_aliases?: Record<string, string>
  model_formats?: Record<string, ModelFormatMode>
  claude_code_forward?: boolean
  transformer?: Record<string, unknown>
  [key: string]: unknown
}

export interface RouterRuleConfig {
  model: string
  targets: string[]
  strategy: RouterStrategy
  delayMs: number
  [key: string]: unknown
}

export interface RouterConfig {
  default: RouterRuleConfig
  background: RouterRuleConfig
  think: RouterRuleConfig
  longContext: RouterRuleConfig
  longContextThreshold: number
  webSearch: string
  image: RouterRuleConfig
  [key: string]: unknown
}

export interface ConcurrencyConfig {
  enabled: boolean
  maxConcurrent: number
  maxConcurrentPerProvider: number
  maxQueueSize: number
  queueTimeoutMs: number
  [key: string]: unknown
}

export interface StatsConfig {
  excludeFailedTokens: boolean
  [key: string]: unknown
}

export interface UIConfig {
  showModelConflictWarnings: boolean
  [key: string]: unknown
}

export interface AppConfig {
  LOG: boolean
  LOG_LEVEL: LogLevel
  CLAUDE_PATH: string
  HOST: string
  PORT: number
  APIKEY: string
  API_TIMEOUT_MS: string
  PROXY_URL: string
  transformers: unknown[]
  Providers: ProviderConfig[]
  StatusLine: Record<string, unknown>
  Router: RouterConfig
  Concurrency: ConcurrencyConfig
  Stats: StatsConfig
  UI: UIConfig
  CUSTOM_ROUTER_PATH: string
  [key: string]: unknown
}

export interface RouteDecision {
  provider: ProviderConfig
  providerName: string
  targetModel: string
  routeKey: string
  delayMs: number
}

export interface RequestRecordInput {
  endpoint: string
  provider: string
  apiKey?: string
  model: string
  targetModel: string
  routeKey: string
  status: number
  success: boolean
  latencyMs: number
  inputTokens: number
  outputTokens: number
  error?: string
}

export interface RequestRecord extends Omit<RequestRecordInput, 'apiKey'> {
  apiKey: string
  id: string
  createdAt: string
  totalTokens: number
}

export interface StatsSummary {
  totals: {
    requests: number
    success: number
    failed: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
    avgLatencyMs: number
  }
  byProvider: Array<{
    provider: string
    requests: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }>
  byModel: Array<{
    model: string
    targetModel: string
    provider: string
    requests: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }>
  byProviderModelKey: Array<{
    provider: string
    apiKey: string
    model: string
    targetModel: string
    requests: number
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }>
  recent: RequestRecord[]
}
