export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ProviderConfig {
  name: string
  api_base_url: string
  api_key: string
  models: string[]
  model_aliases?: Record<string, string>
  transformer?: Record<string, unknown>
  [key: string]: unknown
}

export interface RouterConfig {
  default: string
  background: string
  think: string
  longContext: string
  longContextThreshold: number
  webSearch: string
  image: string
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
  CUSTOM_ROUTER_PATH: string
  [key: string]: unknown
}

export interface RequestRecord {
  id: string
  createdAt: string
  endpoint: string
  provider: string
  model: string
  targetModel: string
  routeKey: string
  status: number
  success: boolean
  latencyMs: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  error?: string
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
  recent: RequestRecord[]
}
