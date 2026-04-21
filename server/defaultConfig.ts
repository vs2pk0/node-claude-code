import type { AppConfig } from './types.js'

export const defaultConfig: AppConfig = {
  LOG: true,
  LOG_LEVEL: 'debug',
  CLAUDE_PATH: '',
  HOST: '127.0.0.1',
  PORT: 4568,
  APIKEY: 'local-router-token',
  API_TIMEOUT_MS: '600000',
  PROXY_URL: '',
  transformers: [],
  Providers: [
    {
      name: 'qclaw',
      api_base_url: 'http://127.0.0.1:19000/proxy/llm/chat/completions',
      api_protocol: 'openai-chat',
      api_key: '',
      api_keys: [],
      api_key_names: [],
      api_key_disabled: [],
      api_key_strategy: 'sequence',
      models: [
        'modelroute',
        'claude-sonnet-4-20250514',
        'claude-opus-4-20250514',
        'claude-haiku-4-20250514',
        'claude-3-7-sonnet-20250219',
        'claude-3-5-sonnet-20241022',
        'claude-3-5-haiku-20241022',
      ],
      transformer: {
        use: [
          [
            'maxtoken',
            {
              max_tokens: 16384,
            },
          ],
        ],
      },
    },
    {
      name: 'baishan',
      api_base_url: 'https://api.edgefn.net/v1/chat/completions',
      api_protocol: 'openai-chat',
      api_key: '',
      api_keys: [],
      api_key_names: [],
      api_key_disabled: [],
      api_key_strategy: 'sequence',
      models: ['MiniMax-M2.5', 'GLM-5'],
      transformer: {
        use: ['maxtoken'],
        'MiniMax-M2.5': {
          use: [
            [
              'maxtoken',
              {
                max_tokens: 65536,
              },
            ],
          ],
        },
      },
    },
  ],
  StatusLine: {
    enabled: false,
    currentStyle: 'default',
    default: {
      modules: [],
    },
    powerline: {
      modules: [],
    },
  },
  Router: {
    default: {
      model: 'claude-sonnet-4-6',
      targets: ['qclaw,claude-opus-4-20250514'],
      strategy: 'sequence',
      delayMs: 0,
    },
    background: {
      model: 'claude-haiku-4-5-20251001',
      targets: ['qclaw,modelroute'],
      strategy: 'sequence',
      delayMs: 0,
    },
    think: {
      model: 'claude-opus-4-7',
      targets: ['qclaw,modelroute'],
      strategy: 'sequence',
      delayMs: 0,
    },
    longContext: {
      model: 'claude-sonnet-4-6',
      targets: ['qclaw,modelroute'],
      strategy: 'sequence',
      delayMs: 0,
    },
    longContextThreshold: 60000,
    webSearch: '',
    image: {
      model: 'claude-sonnet-4-6',
      targets: ['qclaw,modelroute'],
      strategy: 'sequence',
      delayMs: 0,
    },
  },
  Concurrency: {
    enabled: true,
    maxConcurrent: 4,
    maxConcurrentPerProvider: 1,
    maxQueueSize: 64,
    queueTimeoutMs: 300000,
  },
  Stats: {
    excludeFailedTokens: false,
  },
  UI: {
    showModelConflictWarnings: true,
  },
  CUSTOM_ROUTER_PATH: '',
}
