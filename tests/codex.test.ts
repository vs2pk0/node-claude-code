import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const dataDir = mkdtempSync(join(tmpdir(), 'node-claude-code-codex-test-'))
process.env.DATA_DIR = dataDir

interface UpstreamRequest {
  url: string
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
}

let upstreamServer: Server
let proxyServer: Server
let upstreamUrl = ''
let proxyUrl = ''
let storage: typeof import('../server/storage.ts').storage
let defaultConfig: typeof import('../server/defaultConfig.ts').defaultConfig
let resolveCodexUpstreamUrl: typeof import('../server/codex.ts').resolveCodexUpstreamUrl
let saveCodexAuthFile: typeof import('../server/codexAuth.ts').saveCodexAuthFile
let listCodexAuthFiles: typeof import('../server/codexAuth.ts').listCodexAuthFiles
let listCodexAuthFilesWithUsage: typeof import('../server/codexAuth.ts').listCodexAuthFilesWithUsage
let refreshCodexAuthUsage: typeof import('../server/codexAuth.ts').refreshCodexAuthUsage
const upstreamRequests: UpstreamRequest[] = []

before(async () => {
  upstreamServer = createServer(handleUpstreamRequest)
  upstreamUrl = await listen(upstreamServer)

  const express = (await import('express')).default
  const codex = await import('../server/codex.ts')
  const codexAuth = await import('../server/codexAuth.ts')
  const proxy = await import('../server/proxy.ts')
  storage = (await import('../server/storage.ts')).storage
  defaultConfig = (await import('../server/defaultConfig.ts')).defaultConfig
  resolveCodexUpstreamUrl = codex.resolveCodexUpstreamUrl
  saveCodexAuthFile = codexAuth.saveCodexAuthFile
  listCodexAuthFiles = codexAuth.listCodexAuthFiles
  listCodexAuthFilesWithUsage = codexAuth.listCodexAuthFilesWithUsage
  refreshCodexAuthUsage = codexAuth.refreshCodexAuthUsage

  const app = express()
  app.use(express.json({ limit: '25mb' }))
  app.use('/v1', proxy.createProxyRouter())
  app.use('/backend-api/codex', codex.createCodexBackendRouter())

  proxyServer = createServer(app)
  proxyUrl = await listen(proxyServer)
})

after(async () => {
  await Promise.all([closeServer(proxyServer), closeServer(upstreamServer)])
  storage.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('codex upstream URL resolver appends response endpoints', () => {
  assert.equal(resolveCodexUpstreamUrl('https://chatgpt.com/backend-api/codex/', 'responses'), 'https://chatgpt.com/backend-api/codex/responses')
  assert.equal(resolveCodexUpstreamUrl('https://chatgpt.com/backend-api/codex', 'responses/compact'), 'https://chatgpt.com/backend-api/codex/responses/compact')
})

test('codex auth file manager persists token metadata without exposing tokens', () => {
  const config = {
    ...defaultConfig.Codex,
    authDirectory: 'managed-codex-auths',
  }

  const auth = saveCodexAuthFile(config, {
    fileName: 'codex-user-plus.json',
    content: JSON.stringify({
      email: 'codex-user@example.com',
      token_data: {
        access_token: 'file-token',
        account_id: 'acct-file',
      },
    }),
  })
  const auths = listCodexAuthFiles(config)

  assert.equal(auth?.fileName, 'codex-user-plus.json')
  assert.equal(auths.length, 1)
  assert.equal(auths[0].email, 'codex-user@example.com')
  assert.equal(auths[0].accountId, 'acct-file')
  assert.equal(auths[0].hasToken, true)
})

test('codex auth file manager supports OAuth flat token files', () => {
  const config = {
    ...defaultConfig.Codex,
    authDirectory: 'flat-codex-auths',
  }

  saveCodexAuthFile(config, {
    fileName: 'codex-user@example.com-plus.json',
    content: JSON.stringify({
      access_token: 'flat-access-token',
      account_id: 'acct-flat',
      disabled: false,
      email: 'user@example.com',
      expired: '2026-05-04T15:09:58+08:00',
      id_token: 'header.payload.signature',
      last_refresh: '2026-04-24T15:09:58+08:00',
      refresh_token: 'flat-refresh-token',
      type: 'codex',
    }),
  })
  const auths = listCodexAuthFiles(config)

  assert.equal(auths.length, 1)
  assert.equal(auths[0].email, 'user@example.com')
  assert.equal(auths[0].accountId, 'acct-flat')
  assert.equal(auths[0].planType, 'plus')
  assert.equal(auths[0].expired, '2026-05-04T15:09:58+08:00')
  assert.equal(auths[0].hasToken, true)
})

test('codex auth file manager enriches auths with usage limits', async () => {
  const config = {
    ...defaultConfig.Codex,
    authDirectory: 'usage-codex-auths',
  }
  saveCodexAuthFile(config, {
    fileName: 'codex-usage-user-plus.json',
    content: JSON.stringify({
      access_token: 'usage-access-token',
      account_id: 'acct-usage',
      email: 'usage@example.com',
      type: 'codex',
    }),
  })

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.headers && (init.headers as Record<string, string>).authorization, 'Bearer usage-access-token')
    return new Response(JSON.stringify({
      plan_type: 'plus',
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 15,
          limit_window_seconds: 18000,
          reset_after_seconds: 100,
          reset_at: 1777313949,
        },
        secondary_window: {
          used_percent: 25,
          limit_window_seconds: 604800,
          reset_after_seconds: 200,
          reset_at: 1777619802,
        },
      },
      credits: {
        has_credits: false,
        unlimited: false,
        overage_limit_reached: false,
        balance: '0',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  try {
    const auths = await listCodexAuthFilesWithUsage(config)
    assert.equal(auths.length, 1)
    assert.equal(auths[0].usage?.planType, 'plus')
    assert.equal(auths[0].usage?.fiveHour?.remainingPercent, 85)
    assert.equal(auths[0].usage?.weekly?.remainingPercent, 75)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('codex auth file manager refreshes one auth usage by id', async () => {
  const config = {
    ...defaultConfig.Codex,
    authDirectory: 'single-usage-codex-auths',
  }
  saveCodexAuthFile(config, {
    fileName: 'codex-single-user-plus.json',
    content: JSON.stringify({
      access_token: 'single-usage-token',
      account_id: 'acct-single',
      email: 'single@example.com',
      type: 'codex',
    }),
  })

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(JSON.stringify({
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: {
        used_percent: 4,
        limit_window_seconds: 18000,
        reset_after_seconds: 100,
        reset_at: 1777313949,
      },
      secondary_window: {
        used_percent: 12,
        limit_window_seconds: 604800,
        reset_after_seconds: 200,
        reset_at: 1777619802,
      },
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

  try {
    const auth = await refreshCodexAuthUsage(config, 'codex-single-user-plus.json')
    assert.equal(auth.usage?.fiveHour?.remainingPercent, 96)
    assert.equal(auth.usage?.weekly?.remainingPercent, 88)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('codex responses proxy rotates enabled auth files when direct key is empty', async () => {
  upstreamRequests.length = 0
  const config = {
    ...defaultConfig,
    APIKEY: 'router-token',
    Codex: {
      ...defaultConfig.Codex,
      enabled: true,
      apiKey: '',
      baseUrl: upstreamUrl,
      authDirectory: 'rotating-codex-auths',
    },
  }
  saveCodexAuthFile(config.Codex, {
    fileName: 'a.json',
    content: JSON.stringify({
      email: 'a@example.com',
      access_token: 'token-a',
      account_id: 'acct-a',
    }),
  })
  saveCodexAuthFile(config.Codex, {
    fileName: 'b.json',
    content: JSON.stringify({
      email: 'b@example.com',
      access_token: 'token-b',
      account_id: 'acct-b',
    }),
  })
  storage.saveConfig(config)

  await postCodexResponse('router-token', 'hello')
  await postCodexResponse('router-token', 'world')

  assert.equal(upstreamRequests.length, 2)
  assert.equal(upstreamRequests[0].headers.authorization, 'Bearer token-a')
  assert.equal(upstreamRequests[0].headers['chatgpt-account-id'], 'acct-a')
  assert.equal(upstreamRequests[1].headers.authorization, 'Bearer token-b')
  assert.equal(upstreamRequests[1].headers['chatgpt-account-id'], 'acct-b')
})

test('codex responses proxy forwards raw payloads with codex headers and model alias mapping', async () => {
  upstreamRequests.length = 0
  storage.saveConfig({
    ...defaultConfig,
    APIKEY: 'router-token',
    Codex: {
      ...defaultConfig.Codex,
      enabled: true,
      apiKey: 'codex-token',
      baseUrl: upstreamUrl,
      accountId: 'acct-1',
      models: [
        {
          name: 'real-codex-model',
          alias: 'public-codex-model',
        },
      ],
    },
  })

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer router-token',
      'content-type': 'application/json',
      'x-client-request-id': 'client-request-1',
    },
    body: JSON.stringify({
      model: 'public-codex-model',
      input: 'hello',
    }),
  })
  const data = await response.json() as Record<string, unknown>

  assert.equal(response.status, 200)
  assert.equal(data.id, 'resp_1')
  assert.equal(upstreamRequests.length, 1)
  assert.equal(upstreamRequests[0].url, '/responses')
  assert.equal(upstreamRequests[0].headers.authorization, 'Bearer codex-token')
  assert.equal(upstreamRequests[0].headers['chatgpt-account-id'], 'acct-1')
  assert.equal(upstreamRequests[0].headers['x-client-request-id'], 'client-request-1')
  assert.equal(upstreamRequests[0].body.model, 'real-codex-model')
})

test('codex route target on /v1/messages proxies through codex and records codex stats', async () => {
  upstreamRequests.length = 0
  storage.deleteAllRequests()
  storage.saveConfig({
    ...defaultConfig,
    APIKEY: 'router-token',
    Codex: {
      ...defaultConfig.Codex,
      enabled: true,
      apiKey: 'codex-token',
      baseUrl: upstreamUrl,
      models: [
        {
          name: 'gpt-5.5',
          alias: 'gpt-5.5',
        },
      ],
    },
    Router: {
      ...defaultConfig.Router,
      default: {
        model: 'gpt-5.5',
        targets: ['codex,gpt-5.5'],
        strategy: 'sequence',
        delayMs: 0,
      },
    },
  })

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer router-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.5',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })
  const data = await response.json() as Record<string, unknown>
  const recent = storage.getRecentRequests(1)

  assert.equal(response.status, 200)
  assert.equal(data.type, 'message')
  assert.equal(upstreamRequests.length, 1)
  assert.equal(upstreamRequests[0].url, '/responses')
  assert.equal(upstreamRequests[0].headers.authorization, 'Bearer codex-token')
  assert.equal(upstreamRequests[0].body.model, 'gpt-5.5')
  assert.equal(upstreamRequests[0].body.stream, true)
  assert.equal(upstreamRequests[0].body.store, false)
  assert.equal(upstreamRequests[0].body.parallel_tool_calls, true)
  assert.deepEqual(upstreamRequests[0].body.include, ['reasoning.encrypted_content'])
  assert.equal(upstreamRequests[0].body.max_output_tokens, undefined)
  assert.ok(Array.isArray(upstreamRequests[0].body.input))
  assert.deepEqual((upstreamRequests[0].body.input as Record<string, unknown>[])[0], {
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: 'hello',
      },
    ],
  })
  assert.equal(recent[0].provider, 'codex')
  assert.equal(recent[0].endpoint, '/v1/messages')
  assert.equal(recent[0].model, 'gpt-5.5')
  assert.equal(recent[0].targetModel, 'gpt-5.5')
})

test('codex route target returns non-retryable local status for upstream failures', async () => {
  upstreamRequests.length = 0
  storage.deleteAllRequests()
  storage.saveConfig({
    ...defaultConfig,
    APIKEY: 'router-token',
    Codex: {
      ...defaultConfig.Codex,
      enabled: true,
      apiKey: 'codex-token',
      baseUrl: upstreamUrl,
      models: [
        {
          name: 'gpt-5.5',
          alias: 'gpt-5.5',
        },
      ],
    },
    Router: {
      ...defaultConfig.Router,
      default: {
        model: 'gpt-5.5',
        targets: ['codex,gpt-5.5'],
        strategy: 'sequence',
        delayMs: 0,
      },
    },
  })

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer router-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.5',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'force-codex-upstream-failure' }],
    }),
  })
  const data = await response.json() as Record<string, Record<string, unknown>>
  const recent = storage.getRecentRequests(1)

  assert.equal(response.status, 400)
  assert.equal(data.error.message, 'upstream exploded')
  assert.equal(data.error.upstream_status, 502)
  assert.equal(recent[0].provider, 'codex')
  assert.equal(recent[0].status, 400)
  assert.equal(recent[0].success, false)
  assert.equal(recent[0].error, 'upstream exploded')
})

test('codex route target accepts completed SSE even when upstream status is 400', async () => {
  upstreamRequests.length = 0
  storage.deleteAllRequests()
  storage.saveConfig({
    ...defaultConfig,
    APIKEY: 'router-token',
    Codex: {
      ...defaultConfig.Codex,
      enabled: true,
      apiKey: 'codex-token',
      baseUrl: upstreamUrl,
      models: [
        {
          name: 'gpt-5.5',
          alias: 'gpt-5.5',
        },
      ],
    },
    Router: {
      ...defaultConfig.Router,
      default: {
        model: 'gpt-5.5',
        targets: ['codex,gpt-5.5'],
        strategy: 'sequence',
        delayMs: 0,
      },
    },
  })

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer router-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.5',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'force-codex-completed-with-400' }],
    }),
  })
  const data = await response.json() as Record<string, unknown>
  const content = data.content as Array<Record<string, unknown>>
  const recent = storage.getRecentRequests(1)

  assert.equal(response.status, 200)
  assert.equal(content[0].text, 'completed despite status code')
  assert.equal(recent[0].provider, 'codex')
  assert.equal(recent[0].status, 200)
  assert.equal(recent[0].success, true)
  assert.equal(recent[0].outputTokens, 2)
})

test('codex route target converts streaming codex SSE to anthropic SSE', async () => {
  upstreamRequests.length = 0
  storage.deleteAllRequests()
  storage.saveConfig({
    ...defaultConfig,
    APIKEY: 'router-token',
    Codex: {
      ...defaultConfig.Codex,
      enabled: true,
      apiKey: 'codex-token',
      baseUrl: upstreamUrl,
      models: [
        {
          name: 'gpt-5.5',
          alias: 'gpt-5.5',
        },
      ],
    },
    Router: {
      ...defaultConfig.Router,
      default: {
        model: 'gpt-5.5',
        targets: ['codex,gpt-5.5'],
        strategy: 'sequence',
        delayMs: 0,
      },
    },
  })

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer router-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.5',
      max_tokens: 128,
      stream: true,
      messages: [{ role: 'user', content: 'force-codex-stream-delta' }],
    }),
  })
  const text = await response.text()
  const recent = storage.getRecentRequests(1)

  assert.equal(response.status, 200)
  assert.match(text, /event: message_start/)
  assert.match(text, /event: content_block_delta/)
  assert.match(text, /streamed ok/)
  assert.match(text, /event: message_stop/)
  assert.equal(recent[0].provider, 'codex')
  assert.equal(recent[0].success, true)
  assert.equal(recent[0].outputTokens, 3)
})

async function postCodexResponse(apiKey: string, input: string) {
  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5-codex',
      input,
    }),
  })
  assert.equal(response.status, 200)
  return response
}

function handleUpstreamRequest(req: IncomingMessage, res: ServerResponse) {
  let rawBody = ''
  req.setEncoding('utf8')
  req.on('data', (chunk) => {
    rawBody += chunk
  })
  req.on('end', () => {
    const body = rawBody ? JSON.parse(rawBody) as Record<string, unknown> : {}
    upstreamRequests.push({
      url: req.url || '',
      headers: req.headers,
      body,
    })
    if (JSON.stringify(body).includes('force-codex-upstream-failure')) {
      if (body.stream === true) {
        writeSse(res, {
          type: 'error',
          error: {
            message: 'upstream exploded',
          },
        }, 502)
      } else {
        writeJson(res, {
          error: {
            message: 'upstream exploded',
          },
        }, 502)
      }
      return
    }
    if (JSON.stringify(body).includes('force-codex-completed-with-400')) {
      writeSse(res, {
        type: 'response.output_item.done',
        item: {
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'output_text',
              text: 'completed despite status code',
            },
          ],
        },
      }, 400, false)
      res.write(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_400_completed',
          object: 'response',
          status: 'completed',
          model: body.model,
          output: [],
          error: null,
          usage: {
            input_tokens: 1,
            output_tokens: 2,
          },
        },
      })}\n\n`)
      res.end()
      return
    }
    if (JSON.stringify(body).includes('force-codex-stream-delta')) {
      writeSse(res, {
        type: 'response.created',
        response: {
          id: 'resp_stream_1',
          model: body.model,
        },
      }, 200, false)
      res.write(`data: ${JSON.stringify({
        type: 'response.output_text.delta',
        delta: 'streamed ok',
      })}\n\n`)
      res.write(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_stream_1',
          object: 'response',
          status: 'completed',
          model: body.model,
          output: [],
          error: null,
          usage: {
            input_tokens: 1,
            output_tokens: 3,
          },
        },
      })}\n\n`)
      res.end()
      return
    }
    if (body.stream === true) {
      writeSse(res, {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: body.model,
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_text',
                  text: 'ok',
                },
              ],
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 2,
          },
        },
      })
      return
    }
    writeJson(res, {
      id: 'resp_1',
      usage: {
        input_tokens: 1,
        output_tokens: 2,
      },
    })
  })
}

function listen(server: Server) {
  return new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Unexpected test server address')
      }
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

function writeJson(res: ServerResponse, body: Record<string, unknown>, status = 200) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

function writeSse(res: ServerResponse, body: Record<string, unknown>, status = 200, end = true) {
  res.statusCode = status
  res.setHeader('content-type', 'text/event-stream')
  res.write(`data: ${JSON.stringify(body)}\n\n`)
  if (end) {
    res.end()
  }
}
