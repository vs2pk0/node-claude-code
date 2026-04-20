import { randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { ProxyAgent } from 'undici'
import {
  anthropicSseEvent,
  anthropicToOpenAi,
  extractOpenAiContent,
  openAiToAnthropic,
} from './anthropic.js'
import { allModels, resolveRoute } from './routing.js'
import { storage } from './storage.js'
import { estimateTokens } from './token.js'
import { applyProviderTransformers } from './transformers.js'
import type { AppConfig, RequestRecordInput, RouteDecision } from './types.js'

type JsonRecord = Record<string, unknown>

export function createProxyRouter() {
  const router = Router()

  router.use((req, res, next) => {
    const config = storage.getConfig()
    if (isAuthorized(req, config)) {
      next()
      return
    }

    res.status(401).json({
      error: {
        type: 'authentication_error',
        message: 'Invalid local router API key',
      },
    })
  })

  router.get('/models', (_req, res) => {
    const config = storage.getConfig()
    res.json({
      object: 'list',
      data: allModels(config),
    })
  })

  router.post('/messages/count_tokens', (req, res) => {
    res.json({
      input_tokens: estimateTokens(req.body),
    })
  })

  router.post('/messages', async (req, res) => {
    await handleAnthropicMessages(req, res)
  })

  router.post('/chat/completions', async (req, res) => {
    await handleOpenAiChat(req, res)
  })

  return router
}

async function handleAnthropicMessages(req: Request, res: Response) {
  const startedAt = Date.now()
  const config = storage.getConfig()
  const body = req.body as JsonRecord
  const requestedModel = String(body.model ?? '')
  const inputTokens = estimateTokens(body)
  let decision: RouteDecision | undefined

  try {
    decision = resolveRoute(config, body)
    const payload = anthropicToOpenAi(body, decision.targetModel)
    applyProviderTransformers(payload, decision.provider, decision.targetModel)

    if (payload.stream) {
      await streamAnthropicFromOpenAi(res, config, decision, payload, startedAt, inputTokens, requestedModel)
      return
    }

    const upstream = await postJson(config, decision, payload)
    const data = (await upstream.json()) as JsonRecord
    const responseBody = openAiToAnthropic(data, requestedModel, decision.targetModel)
    const usage = readAnthropicUsage(responseBody)

    recordRequest({
      endpoint: '/v1/messages',
      decision,
      startedAt,
      status: upstream.status,
      success: upstream.ok,
      inputTokens: usage.inputTokens || inputTokens,
      outputTokens: usage.outputTokens || estimateTokens(responseBody),
      requestedModel,
    })

    res.status(upstream.status).json(upstream.ok ? responseBody : data)
  } catch (error) {
    handleProxyError(error, res, {
      endpoint: '/v1/messages',
      decision,
      startedAt,
      inputTokens,
      requestedModel,
    })
  }
}

async function handleOpenAiChat(req: Request, res: Response) {
  const startedAt = Date.now()
  const config = storage.getConfig()
  const body = req.body as JsonRecord
  const requestedModel = String(body.model ?? '')
  const inputTokens = estimateTokens(body.messages ?? body)
  let decision: RouteDecision | undefined

  try {
    decision = resolveRoute(config, body)
    const payload: JsonRecord = {
      ...body,
      model: decision.targetModel,
    }
    applyProviderTransformers(payload, decision.provider, decision.targetModel)

    if (payload.stream) {
      await streamOpenAi(res, config, decision, payload, startedAt, inputTokens, requestedModel)
      return
    }

    const upstream = await postJson(config, decision, payload)
    const data = (await upstream.json()) as JsonRecord
    const usage = readOpenAiUsage(data)

    recordRequest({
      endpoint: '/v1/chat/completions',
      decision,
      startedAt,
      status: upstream.status,
      success: upstream.ok,
      inputTokens: usage.inputTokens || inputTokens,
      outputTokens: usage.outputTokens || estimateTokens(data),
      requestedModel,
    })

    res.status(upstream.status).json(data)
  } catch (error) {
    handleProxyError(error, res, {
      endpoint: '/v1/chat/completions',
      decision,
      startedAt,
      inputTokens,
      requestedModel,
    })
  }
}

async function streamOpenAi(
  res: Response,
  config: AppConfig,
  decision: RouteDecision,
  payload: JsonRecord,
  startedAt: number,
  inputTokens: number,
  requestedModel: string,
) {
  const upstream = await postJson(config, decision, payload)
  prepareSse(res, upstream.status)

  let outputText = ''
  let status = upstream.status
  const decoder = new TextDecoder()
  const parseEvents = createSseParser()

  try {
    for await (const chunk of streamBody(upstream)) {
      const text = decoder.decode(chunk, { stream: true })
      outputText += collectOpenAiStreamText(parseEvents(text))
      res.write(text)
    }
  } catch (error) {
    status = 502
    res.write(`event: error\ndata: ${JSON.stringify({ message: readableError(error) })}\n\n`)
  } finally {
    res.end()
    recordRequest({
      endpoint: '/v1/chat/completions',
      decision,
      startedAt,
      status,
      success: status >= 200 && status < 300,
      inputTokens,
      outputTokens: estimateTokens(outputText),
      requestedModel,
    })
  }
}

async function streamAnthropicFromOpenAi(
  res: Response,
  config: AppConfig,
  decision: RouteDecision,
  payload: JsonRecord,
  startedAt: number,
  inputTokens: number,
  requestedModel: string,
) {
  const upstream = await postJson(config, decision, payload)
  prepareSse(res, upstream.status)

  const messageId = `msg_${randomUUID().replaceAll('-', '')}`
  let textBlockStarted = false
  let textBlockIndex = -1
  let textOutput = ''
  let status = upstream.status
  const toolBlocks = new Map<number, { blockIndex: number; id: string; name: string; partialJson: string; started: boolean }>()
  const blockCounter = { next: 0 }
  const decoder = new TextDecoder()
  const parseEvents = createSseParser()

  res.write(
    anthropicSseEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: requestedModel || decision.targetModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0,
        },
      },
    }),
  )

  try {
    for await (const chunk of streamBody(upstream)) {
      const text = decoder.decode(chunk, { stream: true })
      const events = parseEvents(text)

      for (const event of events) {
        if (event === '[DONE]') {
          continue
        }

        const data = safeJson(event)
        const choice = readFirstChoice(data)
        const delta = asRecord(choice?.delta)
        const content = typeof delta.content === 'string' ? delta.content : ''
        if (content) {
          if (!textBlockStarted) {
            textBlockStarted = true
            textBlockIndex = blockCounter.next
            blockCounter.next += 1
            res.write(
              anthropicSseEvent('content_block_start', {
                type: 'content_block_start',
                index: textBlockIndex,
                content_block: {
                  type: 'text',
                  text: '',
                },
              }),
            )
          }

          textOutput += content
          res.write(
            anthropicSseEvent('content_block_delta', {
              type: 'content_block_delta',
              index: textBlockIndex,
              delta: {
                type: 'text_delta',
                text: content,
              },
            }),
          )
        }

        writeToolDeltas(res, delta.tool_calls, toolBlocks, blockCounter)
      }
    }
  } catch (error) {
    status = 502
    res.write(
      anthropicSseEvent('error', {
        type: 'error',
        error: {
          type: 'api_error',
          message: readableError(error),
        },
      }),
    )
  } finally {
    if (textBlockStarted) {
      res.write(
        anthropicSseEvent('content_block_stop', {
          type: 'content_block_stop',
          index: textBlockIndex,
        }),
      )
    }

    for (const tool of toolBlocks.values()) {
      if (tool.started) {
        res.write(
          anthropicSseEvent('content_block_stop', {
            type: 'content_block_stop',
            index: tool.blockIndex,
          }),
        )
      }
    }

    const outputTokens = estimateTokens(textOutput || [...toolBlocks.values()].map((tool) => tool.partialJson).join('\n'))
    res.write(
      anthropicSseEvent('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: toolBlocks.size ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: {
          output_tokens: outputTokens,
        },
      }),
    )
    res.write(
      anthropicSseEvent('message_stop', {
        type: 'message_stop',
      }),
    )
    res.end()

    recordRequest({
      endpoint: '/v1/messages',
      decision,
      startedAt,
      status,
      success: status >= 200 && status < 300,
      inputTokens,
      outputTokens,
      requestedModel,
    })
  }
}

async function postJson(config: AppConfig, decision: RouteDecision, payload: JsonRecord) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs(config))
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }

  if (decision.provider.api_key) {
    headers.authorization = `Bearer ${decision.provider.api_key}`
  }

  try {
    return await fetch(decision.provider.api_base_url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
      dispatcher: dispatcher(config),
    } as RequestInit & { dispatcher?: ProxyAgent })
  } finally {
    clearTimeout(timeout)
  }
}

function dispatcher(config: AppConfig): ProxyAgent | undefined {
  if (!config.PROXY_URL) {
    return undefined
  }

  return new ProxyAgent(config.PROXY_URL)
}

function isAuthorized(req: Request, config: AppConfig) {
  if (!config.APIKEY) {
    return true
  }

  const authorization = req.header('authorization') ?? ''
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]
  const apiKey = req.header('x-api-key') ?? req.header('anthropic-api-key')
  return bearer === config.APIKEY || apiKey === config.APIKEY
}

function prepareSse(res: Response, status: number) {
  res.status(status)
  res.setHeader('content-type', 'text/event-stream; charset=utf-8')
  res.setHeader('cache-control', 'no-cache, no-transform')
  res.setHeader('connection', 'keep-alive')
  res.flushHeaders()
}

async function* streamBody(response: globalThis.Response): AsyncGenerator<Uint8Array> {
  if (!response.body) {
    return
  }

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    yield chunk
  }
}

function recordRequest(input: {
  endpoint: string
  decision?: RouteDecision
  startedAt: number
  status: number
  success: boolean
  inputTokens: number
  outputTokens: number
  requestedModel: string
  error?: string
}) {
  const decision = input.decision
  const record: RequestRecordInput = {
    endpoint: input.endpoint,
    provider: decision?.providerName ?? 'unknown',
    model: input.requestedModel || decision?.targetModel || 'unknown',
    targetModel: decision?.targetModel ?? 'unknown',
    routeKey: decision?.routeKey ?? 'unknown',
    status: input.status,
    success: input.success,
    latencyMs: Date.now() - input.startedAt,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    error: input.error,
  }

  storage.recordRequest(record)
}

function handleProxyError(
  error: unknown,
  res: Response,
  context: {
    endpoint: string
    decision?: RouteDecision
    startedAt: number
    inputTokens: number
    requestedModel: string
  },
) {
  const status = typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 502
  const message = readableError(error)

  recordRequest({
    endpoint: context.endpoint,
    decision: context.decision,
    startedAt: context.startedAt,
    status,
    success: false,
    inputTokens: context.inputTokens,
    outputTokens: 0,
    requestedModel: context.requestedModel,
    error: message,
  })

  res.status(status).json({
    error: {
      type: status === 400 ? 'invalid_request_error' : 'api_error',
      message,
    },
  })
}

function readOpenAiUsage(data: JsonRecord) {
  const usage = asRecord(data.usage)
  return {
    inputTokens: readNumber(usage.prompt_tokens),
    outputTokens: readNumber(usage.completion_tokens),
  }
}

function readAnthropicUsage(data: JsonRecord) {
  const usage = asRecord(data.usage)
  return {
    inputTokens: readNumber(usage.input_tokens),
    outputTokens: readNumber(usage.output_tokens),
  }
}

function collectOpenAiStreamText(events: string[]): string {
  return events
    .filter((event) => event !== '[DONE]')
    .map((event) => {
      const data = safeJson(event)
      const choice = readFirstChoice(data)
      return extractOpenAiContent(asRecord(choice?.delta))
    })
    .join('')
}

function writeToolDeltas(
  res: Response,
  rawToolCalls: unknown,
  toolBlocks: Map<number, { blockIndex: number; id: string; name: string; partialJson: string; started: boolean }>,
  blockCounter: { next: number },
) {
  if (!Array.isArray(rawToolCalls)) {
    return
  }

  for (const rawToolCall of rawToolCalls) {
    const toolCall = asRecord(rawToolCall)
    const index = readNumber(toolCall.index)
    const fn = asRecord(toolCall.function)
    const existing = toolBlocks.get(index)
    const tool = existing ?? {
      blockIndex: blockCounter.next,
      id: String(toolCall.id ?? `toolu_${randomUUID().replaceAll('-', '')}`),
      name: String(fn.name ?? 'tool'),
      partialJson: '',
      started: false,
    }

    if (!existing) {
      blockCounter.next += 1
    }

    if (toolCall.id) {
      tool.id = String(toolCall.id)
    }
    if (fn.name) {
      tool.name = String(fn.name)
    }

    if (!tool.started) {
      res.write(
        anthropicSseEvent('content_block_start', {
          type: 'content_block_start',
          index: tool.blockIndex,
          content_block: {
            type: 'tool_use',
            id: tool.id,
            name: tool.name,
            input: {},
          },
        }),
      )
      tool.started = true
    }

    if (typeof fn.arguments === 'string' && fn.arguments) {
      tool.partialJson += fn.arguments
      res.write(
        anthropicSseEvent('content_block_delta', {
          type: 'content_block_delta',
          index: tool.blockIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: fn.arguments,
          },
        }),
      )
    }

    toolBlocks.set(index, tool)
  }
}

function parseSseDataLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
}

function createSseParser() {
  let buffer = ''

  return (text: string) => {
    buffer += text
    const chunks = buffer.split(/\n\n/)
    buffer = chunks.pop() ?? ''
    return chunks.flatMap(parseSseDataLines)
  }
}

function safeJson(text: string): JsonRecord {
  try {
    return JSON.parse(text) as JsonRecord
  } catch {
    return {}
  }
}

function timeoutMs(config: AppConfig) {
  const value = Number(config.API_TIMEOUT_MS)
  return Number.isFinite(value) && value > 0 ? value : 600000
}

function readFirstChoice(data: JsonRecord): JsonRecord | undefined {
  const choices = data.choices
  if (!Array.isArray(choices)) {
    return undefined
  }
  return asRecord(choices[0])
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asRecord(value: unknown): JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function readableError(error: unknown) {
  if (error instanceof Error) {
    return error.name === 'AbortError' ? 'Upstream request timed out' : error.message
  }
  return String(error)
}
