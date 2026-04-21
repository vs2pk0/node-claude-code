import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, test } from 'node:test'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'node-claude-code-test-'))

interface UpstreamState {
  requests: Array<{
    url: string
    headers: IncomingHttpHeaders
    body: Record<string, unknown>
  }>
  pendingResponses: ServerResponse[]
  streamResponses: ServerResponse[]
  streamClosedCount: number
}

let proxyUrl = ''
let upstreamUrl = ''
let proxyServer: Server
let upstreamServer: Server
let storage: any

const upstreamState: UpstreamState = {
  requests: [],
  pendingResponses: [],
  streamResponses: [],
  streamClosedCount: 0,
}

before(async () => {
  upstreamServer = createServer(handleUpstreamRequest)
  upstreamUrl = await listen(upstreamServer)

  const express = (await import('express')).default
  const { createProxyRouter } = await import('../server/proxy.ts')
  storage = (await import('../server/storage.ts')).storage

  const app = express()
  app.use(express.json({ limit: '25mb' }))
  app.use('/v1', createProxyRouter())

  proxyServer = createServer(app)
  proxyUrl = await listen(proxyServer)
})

afterEach(() => {
  while (upstreamState.pendingResponses.length) {
    writeJson(upstreamState.pendingResponses.shift()!, {
      id: 'cleanup',
      choices: [{ message: { role: 'assistant', content: 'cleanup' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
  }

  while (upstreamState.streamResponses.length) {
    upstreamState.streamResponses.shift()!.destroy()
  }
})

after(async () => {
  await Promise.all([closeServer(proxyServer), closeServer(upstreamServer)])
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true })
})

test('queued HTTP request is not sent upstream after the client disconnects', async () => {
  resetUpstreamState()
  configureProxy('queued-provider', 'queued-model', {
    maxQueueSize: 1,
    queueTimeoutMs: 5000,
  })

  const firstResponsePromise = postChat({
    model: 'queued-model',
    messages: [{ role: 'user', content: 'hold the slot' }],
  })
  await waitFor(() => upstreamState.pendingResponses.length === 1, 'first request should reach upstream')

  const queuedController = new AbortController()
  const queuedResponsePromise = postChat(
    {
      model: 'queued-model',
      messages: [{ role: 'user', content: 'queued then disconnected' }],
    },
    queuedController.signal,
  )
  await sleep(100)

  const probeResponse = await postChat(
    {
      model: 'queued-model',
      messages: [{ role: 'user', content: 'queue probe' }],
    },
    AbortSignal.timeout(1000),
  )
  assert.equal(probeResponse.status, 503)
  await probeResponse.text()

  queuedController.abort()
  await assert.rejects(queuedResponsePromise)

  writeJson(upstreamState.pendingResponses.shift()!, {
    id: 'chatcmpl-first',
    choices: [{ message: { role: 'assistant', content: 'ok' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  })

  const firstResponse = await firstResponsePromise
  assert.equal(firstResponse.status, 200)
  await firstResponse.json()
  await sleep(150)

  assert.equal(upstreamState.requests.length, 1)
})

test('streaming upstream request is aborted when the client disconnects mid-stream', async () => {
  resetUpstreamState()
  configureProxy('stream-provider', 'stream-model', {
    maxQueueSize: 4,
    queueTimeoutMs: 5000,
  })

  const controller = new AbortController()
  const response = await postChat(
    {
      model: 'stream-model',
      stream: true,
      messages: [{ role: 'user', content: 'stream please' }],
    },
    controller.signal,
  )

  assert.equal(response.status, 200)
  assert.ok(response.body)
  const reader = response.body.getReader()
  const firstChunk = await reader.read()
  assert.equal(firstChunk.done, false)

  controller.abort()
  await waitFor(() => upstreamState.streamClosedCount === 1, 'upstream stream should close')
  await waitFor(() => {
    return storage.getSummary().recent.some((record: { provider: string; status: number }) => {
      return record.provider === 'stream-provider' && record.status === 499
    })
  }, 'client disconnect should be recorded as 499')
})

test('route request delay waits before sending to upstream', async () => {
  resetUpstreamState()
  configureProxy(
    'delayed-provider',
    'delayed-model',
    {
      maxQueueSize: 4,
      queueTimeoutMs: 5000,
    },
    180,
  )

  const startedAt = Date.now()
  const responsePromise = postChat({
    model: 'delayed-model',
    messages: [{ role: 'user', content: 'delay before upstream' }],
  })

  await sleep(80)
  assert.equal(upstreamState.requests.length, 0)
  await waitFor(() => upstreamState.pendingResponses.length === 1, 'delayed request should reach upstream')
  assert.ok(Date.now() - startedAt >= 150)

  writeJson(upstreamState.pendingResponses.shift()!, {
    id: 'chatcmpl-delayed',
    choices: [{ message: { role: 'assistant', content: 'delayed ok' } }],
    usage: { prompt_tokens: 2, completion_tokens: 1 },
  })

  const response = await responsePromise
  assert.equal(response.status, 200)
  await response.json()
})

test('failed request tokens can be excluded from summary aggregates', () => {
  const current = storage.getConfig()
  storage.deleteAllRequests()
  storage.saveConfig({
    ...current,
    Stats: {
      ...current.Stats,
      excludeFailedTokens: false,
    },
  })

  storage.recordRequest(requestRecord({ success: true, inputTokens: 10, outputTokens: 2, status: 200 }))
  storage.recordRequest(requestRecord({ success: false, inputTokens: 100, outputTokens: 20, status: 500 }))

  const inclusive = storage.getSummary()
  assert.equal(inclusive.totals.inputTokens, 110)
  assert.equal(inclusive.totals.outputTokens, 22)
  assert.equal(inclusive.totals.totalTokens, 132)

  storage.saveConfig({
    ...storage.getConfig(),
    Stats: {
      ...storage.getConfig().Stats,
      excludeFailedTokens: true,
    },
  })

  const filtered = storage.getSummary()
  assert.equal(filtered.totals.inputTokens, 10)
  assert.equal(filtered.totals.outputTokens, 2)
  assert.equal(filtered.totals.totalTokens, 12)
  assert.equal(filtered.byProvider[0].inputTokens, 10)
  assert.equal(filtered.byModel[0].inputTokens, 10)
  assert.ok(filtered.recent.some((record: { success: boolean; inputTokens: number }) => !record.success && record.inputTokens === 100))
})

test('claude code forward sends Anthropic payload and returns upstream response unchanged', async () => {
  resetUpstreamState()
  const current = storage.getConfig()
  storage.deleteAllRequests()
  storage.saveConfig({
    ...current,
    APIKEY: '',
    Providers: [
      {
        name: 'llmapi',
        api_base_url: `${upstreamUrl}/v1/messages/`,
        api_key: 'provider-key',
        models: ['claude-opus-4-7'],
        model_formats: {
          'claude-opus-4-7': 'claude-code',
        },
      },
    ],
    Router: {
      ...current.Router,
      default: {
        model: 'claude-sonnet-4-6',
        targets: ['llmapi,claude-opus-4-7'],
        strategy: 'sequence',
        delayMs: 0,
      },
      background: {
        ...current.Router.background,
        targets: [],
      },
      think: {
        ...current.Router.think,
        targets: [],
      },
      longContext: {
        ...current.Router.longContext,
        targets: [],
      },
      image: {
        ...current.Router.image,
        targets: [],
      },
    },
    Concurrency: {
      enabled: true,
      maxConcurrent: 1,
      maxConcurrentPerProvider: 1,
      maxQueueSize: 4,
      queueTimeoutMs: 5000,
    },
  })

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  })

  assert.equal(response.status, 200)
  const data = await response.json() as Record<string, unknown>
  assert.equal(data.type, 'message')
  assert.equal(data.model, 'claude-opus-4-7')

  assert.equal(upstreamState.requests.length, 1)
  const upstreamRequest = upstreamState.requests[0]
  assert.equal(upstreamRequest.url, '/v1/messages')
  assert.equal(upstreamRequest.headers['x-api-key'], 'provider-key')
  assert.equal(upstreamRequest.headers.authorization, 'Bearer provider-key')
  assert.equal(upstreamRequest.headers['anthropic-version'], '2023-06-01')
  assert.equal(upstreamRequest.headers.accept, 'application/json')
  assert.equal(upstreamRequest.headers['accept-encoding'], 'identity')
  assert.equal(upstreamRequest.body.model, 'claude-opus-4-7')
  assert.deepEqual(upstreamRequest.body.messages, [{ role: 'user', content: 'hello' }])
})

test('claude code forward starts raw response before upstream body ends', async () => {
  resetUpstreamState()
  const current = storage.getConfig()
  storage.deleteAllRequests()
  storage.saveConfig({
    ...current,
    APIKEY: '',
    Providers: [
      {
        name: 'llmapi-slow',
        api_base_url: `${upstreamUrl}/v1/messages`,
        api_key: 'provider-key',
        models: ['claude-opus-4-7'],
        claude_code_forward: true,
      },
    ],
    Router: {
      ...current.Router,
      default: {
        model: 'claude-sonnet-4-6',
        targets: ['llmapi-slow,claude-opus-4-7'],
        strategy: 'sequence',
        delayMs: 0,
      },
      background: {
        ...current.Router.background,
        targets: [],
      },
      think: {
        ...current.Router.think,
        targets: [],
      },
      longContext: {
        ...current.Router.longContext,
        targets: [],
      },
      image: {
        ...current.Router.image,
        targets: [],
      },
    },
  })

  const startedAt = Date.now()
  const response = await Promise.race([
    fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'slow raw body' }],
      }),
    }),
    sleep(120).then(() => undefined),
  ])

  assert.ok(response, 'proxy should forward upstream headers before the delayed upstream body finishes')
  assert.equal(response.status, 200)
  assert.ok(response.body)

  const reader = response.body.getReader()
  const firstChunk = await Promise.race([reader.read(), sleep(120).then(() => undefined)])
  assert.ok(firstChunk && !firstChunk.done, 'proxy should forward the first upstream chunk immediately')
  assert.ok(Date.now() - startedAt < 240)

  const decoder = new TextDecoder()
  let rawText = decoder.decode(firstChunk.value)
  for (;;) {
    const nextChunk = await reader.read()
    if (nextChunk.done) {
      break
    }
    rawText += decoder.decode(nextChunk.value, { stream: true })
  }
  rawText += decoder.decode()

  const data = JSON.parse(rawText) as Record<string, unknown>
  assert.equal(data.model, 'claude-opus-4-7')
})

test('claude code forward appends messages path when provider uses base URL', async () => {
  resetUpstreamState()
  const current = storage.getConfig()
  storage.deleteAllRequests()
  storage.saveConfig({
    ...current,
    APIKEY: '',
    Providers: [
      {
        name: 'llmapi-base',
        api_base_url: upstreamUrl,
        api_key: 'provider-key',
        models: ['claude-opus-4-7'],
        claude_code_forward: true,
      },
    ],
    Router: {
      ...current.Router,
      default: {
        model: 'claude-sonnet-4-6',
        targets: ['llmapi-base,claude-opus-4-7'],
        strategy: 'sequence',
        delayMs: 0,
      },
      background: {
        ...current.Router.background,
        targets: [],
      },
      think: {
        ...current.Router.think,
        targets: [],
      },
      longContext: {
        ...current.Router.longContext,
        targets: [],
      },
      image: {
        ...current.Router.image,
        targets: [],
      },
    },
    Concurrency: {
      enabled: true,
      maxConcurrent: 1,
      maxConcurrentPerProvider: 1,
      maxQueueSize: 4,
      queueTimeoutMs: 5000,
    },
  })

  const response = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hello from base url' }],
    }),
  })

  assert.equal(response.status, 200)
  await response.json()
  assert.equal(upstreamState.requests.length, 1)
  assert.equal(upstreamState.requests[0].url, '/v1/messages')
  assert.equal(upstreamState.requests[0].body.model, 'claude-opus-4-7')
})

function configureProxy(
  providerName: string,
  model: string,
  concurrency: Partial<{ maxQueueSize: number; queueTimeoutMs: number }> = {},
  delayMs = 0,
) {
  const current = storage.getConfig()
  storage.deleteAllRequests()
  storage.saveConfig({
    ...current,
    APIKEY: '',
    Providers: [
      {
        name: providerName,
        api_base_url: `${upstreamUrl}/v1/chat/completions`,
        api_key: '',
        models: [model],
      },
    ],
    Router: {
      ...current.Router,
      default: {
        model: 'claude-sonnet-4-6',
        targets: [`${providerName},${model}`],
        strategy: 'sequence',
        delayMs,
      },
      background: {
        ...current.Router.background,
        targets: [],
      },
      think: {
        ...current.Router.think,
        targets: [],
      },
      longContext: {
        ...current.Router.longContext,
        targets: [],
      },
      image: {
        ...current.Router.image,
        targets: [],
      },
    },
    Concurrency: {
      enabled: true,
      maxConcurrent: 1,
      maxConcurrentPerProvider: 1,
      maxQueueSize: concurrency.maxQueueSize ?? 4,
      queueTimeoutMs: concurrency.queueTimeoutMs ?? 5000,
    },
  })
}

function requestRecord(input: { success: boolean; inputTokens: number; outputTokens: number; status: number }) {
  return {
    endpoint: '/v1/messages',
    provider: 'stats-provider',
    model: 'stats-model',
    targetModel: 'stats-target-model',
    routeKey: 'default',
    status: input.status,
    success: input.success,
    latencyMs: 100,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  }
}

async function handleUpstreamRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST' || (req.url !== '/v1/chat/completions' && req.url !== '/v1/messages')) {
    res.statusCode = 404
    res.end()
    return
  }

  const body = await readJsonBody(req)
  upstreamState.requests.push({
    url: req.url,
    headers: req.headers,
    body,
  })

  if (req.url === '/v1/messages') {
    if (hasMessageContent(body, 'slow raw body')) {
      writeDelayedClaudeMessage(res, String(body.model ?? 'model'))
      return
    }

    writeJson(res, {
      id: 'msg_forwarded',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text: 'raw anthropic ok' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: {
        input_tokens: 3,
        output_tokens: 2,
      },
    })
    return
  }

  if (body.stream === true) {
    upstreamState.streamResponses.push(res)
    res.on('close', () => {
      upstreamState.streamClosedCount += 1
    })
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
    })
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n')
    return
  }

  upstreamState.pendingResponses.push(res)
}

function hasMessageContent(body: Record<string, unknown>, content: string) {
  const messages = body.messages
  return Array.isArray(messages) && messages.some((message) => {
    const record = message as Record<string, unknown>
    return record.content === content
  })
}

function writeDelayedClaudeMessage(res: ServerResponse, model: string) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
  })
  res.write(`{"id":"msg_delayed","type":"message","role":"assistant","model":${JSON.stringify(model)},`)
  setTimeout(() => {
    res.write('"content":[{"type":"text","text":"delayed ok"}],"stop_reason":"end_turn","usage":{"input_tokens":3,"output_tokens":2}}')
    res.end()
  }, 260)
}

async function readJsonBody(req: IncomingMessage) {
  let raw = ''
  for await (const chunk of req) {
    raw += String(chunk)
  }
  return JSON.parse(raw || '{}') as Record<string, unknown>
}

function postChat(body: Record<string, unknown>, signal?: AbortSignal) {
  return fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  })
}

function writeJson(res: ServerResponse, payload: Record<string, unknown>) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(payload))
}

function resetUpstreamState() {
  upstreamState.requests = []
  upstreamState.pendingResponses = []
  upstreamState.streamResponses = []
  upstreamState.streamClosedCount = 0
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 1500) {
  const startedAt = Date.now()
  return new Promise<void>((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve()
        return
      }

      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error(`Timed out waiting for ${label}`))
        return
      }

      setTimeout(tick, 20)
    }

    tick()
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function listen(server: Server) {
  return new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      assert.ok(address && typeof address === 'object')
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

function closeServer(server?: Server) {
  return new Promise<void>((resolve, reject) => {
    if (!server?.listening) {
      resolve()
      return
    }

    server.close((error) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}
