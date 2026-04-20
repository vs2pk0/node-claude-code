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
      api_key: '',
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
      api_key: '',
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
    default: 'qclaw,claude-opus-4-20250514',
    background: 'qclaw,modelroute',
    think: 'qclaw,modelroute',
    longContext: 'qclaw,modelroute',
    longContextThreshold: 60000,
    webSearch: '',
    image: 'qclaw,modelroute',
  },
  CUSTOM_ROUTER_PATH: '',
}
