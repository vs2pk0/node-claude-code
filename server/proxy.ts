import { randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici'
import {
  anthropicSseEvent,
  anthropicToOpenAi,
  extractOpenAiContent,
  openAiToAnthropic,
} from './anthropic.js'
import { handleCodexAnthropicMessages, handleCodexResponses } from './codex.js'
import { clientClosedError, requestConcurrencyLimiter } from './concurrency.js'
import { allModels, resolveRoute } from './routing.js'
import { storage } from './storage.js'
import { estimateTokens } from './token.js'
import { applyProviderTransformers } from './transformers.js'
import type { AppConfig, RequestRecordInput, RouteDecision, RouterStrategy } from './types.js'

type JsonRecord = Record<string, unknown>
type UpstreamPayloadFormat = 'openai' | 'claude-code'

interface PostJsonOptions {
  format?: UpstreamPayloadFormat
  headers?: Record<string, string>
}

interface PostJsonResult {
  upstream: globalThis.Response
  apiKey: string
  upstreamStartedAt: number
  upstreamMs: number
  cleanup: () => void
}

interface SelectedApiKey {
  value: string
  label: string
  release: () => void
}

interface ProviderApiKeyEntry {
  key: string
  name: string
  disabled: boolean
}

const apiKeySequenceByProvider = new Map<string, number>()
const activeApiKeys = new Map<string, number>()
let cachedProxyUrl = ''
let cachedProxyAgent: ProxyAgent | undefined
let cachedDirectAgent: Agent | undefined

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

  router.post('/responses', async (req, res) => {
    await handleCodexResponses(req, res, 'responses')
  })

  router.post('/responses/compact', async (req, res) => {
    await handleCodexResponses(req, res, 'responses/compact')
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
  let inputTokens = 0
  const clientDisconnect = createClientDisconnectSignal(req, res)
  let decision: RouteDecision | undefined

  try {
    decision = resolveRoute(config, body)
    if (decision.providerName === 'codex') {
      inputTokens = estimateTokens(body)
      await handleCodexAnthropicMessages(req, res, {
        body,
        requestedModel,
        targetModel: decision.targetModel,
        startedAt,
        inputTokens,
        delayMs: decision.delayMs,
        signal: clientDisconnect.signal,
      })
      return
    }

    if (shouldForwardClaudeCode(decision)) {
      await forwardClaudeCodeMessages(
        req,
        res,
        config,
        decision,
        body,
        startedAt,
        inputTokens,
        requestedModel,
        clientDisconnect.signal,
      )
      return
    }

    inputTokens = estimateTokens(body)
    const payload = anthropicToOpenAi(body, decision.targetModel)
    applyProviderTransformers(payload, decision.provider, decision.targetModel)

    if (payload.stream) {
      await streamAnthropicFromOpenAi(
        res,
        config,
        decision,
        payload,
        startedAt,
        inputTokens,
        requestedModel,
        clientDisconnect.signal,
      )
      return
    }

    const { upstream, data, apiKey, queueMs, upstreamMs, firstByteMs } = await postJsonWithConcurrency(
      config,
      decision,
      payload,
      clientDisconnect.signal,
    )
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
      queueMs,
      upstreamMs,
      firstByteMs,
      requestedModel,
      apiKey,
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
  } finally {
    clientDisconnect.cleanup()
  }
}

async function handleOpenAiChat(req: Request, res: Response) {
  const startedAt = Date.now()
  const config = storage.getConfig()
  const body = req.body as JsonRecord
  const requestedModel = String(body.model ?? '')
  const inputTokens = estimateTokens(body.messages ?? body)
  const clientDisconnect = createClientDisconnectSignal(req, res)
  let decision: RouteDecision | undefined

  try {
    decision = resolveRoute(config, body)
    const payload: JsonRecord = {
      ...body,
      model: decision.targetModel,
    }
    applyProviderTransformers(payload, decision.provider, decision.targetModel)

    if (payload.stream) {
      await streamOpenAi(res, config, decision, payload, startedAt, inputTokens, requestedModel, clientDisconnect.signal)
      return
    }

    const { upstream, data, apiKey, queueMs, upstreamMs, firstByteMs } = await postJsonWithConcurrency(
      config,
      decision,
      payload,
      clientDisconnect.signal,
    )
    const usage = readOpenAiUsage(data)

    recordRequest({
      endpoint: '/v1/chat/completions',
      decision,
      startedAt,
      status: upstream.status,
      success: upstream.ok,
      inputTokens: usage.inputTokens || inputTokens,
      outputTokens: usage.outputTokens || estimateTokens(data),
      queueMs,
      upstreamMs,
      firstByteMs,
      requestedModel,
      apiKey,
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
  } finally {
    clientDisconnect.cleanup()
  }
}

async function forwardClaudeCodeMessages(
  req: Request,
  res: Response,
  config: AppConfig,
  decision: RouteDecision,
  body: JsonRecord,
  startedAt: number,
  inputTokens: number,
  requestedModel: string,
  signal?: AbortSignal,
) {
  const payload: JsonRecord = {
    ...body,
    model: decision.targetModel,
  }
  applyProviderTransformers(payload, decision.provider, decision.targetModel)

  const options: PostJsonOptions = {
    format: 'claude-code',
    headers: readClaudeCodeForwardHeaders(req),
  }

  await forwardClaudeCodeRaw(res, config, decision, payload, startedAt, inputTokens, requestedModel, signal, options)
}

async function streamOpenAi(
  res: Response,
  config: AppConfig,
  decision: RouteDecision,
  payload: JsonRecord,
  startedAt: number,
  inputTokens: number,
  requestedModel: string,
  signal?: AbortSignal,
) {
  let outputText = ''
  let status = 502
  let apiKey = ''
  const decoder = new TextDecoder()
  const parseEvents = createSseParser()
  let release = noopRelease
  let upstreamCleanup = noopRelease
  let queueMs = 0
  let upstreamMs = 0
  let firstByteMs = 0
  let sawFirstByte = false

  try {
    const queueStartedAt = Date.now()
    release = await requestConcurrencyLimiter.acquire(config, decision, { signal })
    queueMs = Date.now() - queueStartedAt
    await waitForRequestDelay(decision.delayMs, signal)
    const upstreamRequest = await postJson(config, decision, payload, signal)
    const upstream = upstreamRequest.upstream
    upstreamCleanup = upstreamRequest.cleanup
    apiKey = upstreamRequest.apiKey
    upstreamMs = upstreamRequest.upstreamMs
    firstByteMs = upstreamRequest.upstreamMs
    status = upstream.status
    prepareSse(res, upstream.status)

    for await (const chunk of streamBody(upstream)) {
      if (!sawFirstByte) {
        sawFirstByte = true
        firstByteMs = Date.now() - upstreamRequest.upstreamStartedAt
      }
      const text = decoder.decode(chunk, { stream: true })
      await writeResponseChunk(res, text, signal)
      outputText += collectOpenAiStreamText(parseEvents(text))
    }
  } catch (error) {
    status = errorStatus(error, signal)
    apiKey ||= readErrorApiKey(error)
    if (!isClientClosed(error, signal) && canWriteResponse(res) && !res.headersSent) {
      prepareSse(res, status)
    }
    if (!isClientClosed(error, signal) && canWriteResponse(res)) {
      try {
        await writeResponseChunk(res, `event: error\ndata: ${JSON.stringify({ message: readableError(error) })}\n\n`, signal)
      } catch {
        // Client went away while sending the error frame.
      }
    }
  } finally {
    upstreamCleanup()
    release()
    if (canWriteResponse(res)) {
      res.end()
    }
    recordRequest({
      endpoint: '/v1/chat/completions',
      decision,
      startedAt,
      status,
      success: status >= 200 && status < 300,
      inputTokens,
      outputTokens: estimateTokens(outputText),
      queueMs,
      upstreamMs,
      firstByteMs,
      requestedModel,
      apiKey,
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
  signal?: AbortSignal,
) {
  const messageId = `msg_${randomUUID().replaceAll('-', '')}`
  let textBlockStarted = false
  let textBlockIndex = -1
  let textOutput = ''
  let status = 502
  let hadError = false
  let apiKey = ''
  const toolBlocks = new Map<number, { blockIndex: number; id: string; name: string; partialJson: string; started: boolean }>()
  const blockCounter = { next: 0 }
  const decoder = new TextDecoder()
  const parseEvents = createSseParser()
  let release = noopRelease
  let upstreamCleanup = noopRelease
  let queueMs = 0
  let upstreamMs = 0
  let firstByteMs = 0
  let sawFirstByte = false

  try {
    const queueStartedAt = Date.now()
    release = await requestConcurrencyLimiter.acquire(config, decision, { signal })
    queueMs = Date.now() - queueStartedAt
    await waitForRequestDelay(decision.delayMs, signal)
    const upstreamRequest = await postJson(config, decision, payload, signal)
    const upstream = upstreamRequest.upstream
    upstreamCleanup = upstreamRequest.cleanup
    apiKey = upstreamRequest.apiKey
    upstreamMs = upstreamRequest.upstreamMs
    firstByteMs = upstreamRequest.upstreamMs
    status = upstream.status
    prepareSse(res, upstream.status)

    await writeResponseChunk(
      res,
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
      signal,
    )

    for await (const chunk of streamBody(upstream)) {
      if (!sawFirstByte) {
        sawFirstByte = true
        firstByteMs = Date.now() - upstreamRequest.upstreamStartedAt
      }
      const text = decoder.decode(chunk, { stream: true })
      const events = parseEvents(text)
      const frames: string[] = []

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
            frames.push(
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
          frames.push(
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

        collectToolDeltaEvents(delta.tool_calls, toolBlocks, blockCounter, frames)
      }

      if (frames.length) {
        await writeResponseChunk(res, frames.join(''), signal)
      }
    }
  } catch (error) {
    status = errorStatus(error, signal)
    hadError = true
    apiKey ||= readErrorApiKey(error)
    if (!isClientClosed(error, signal) && canWriteResponse(res) && !res.headersSent) {
      prepareSse(res, status)
    }
    if (!isClientClosed(error, signal) && canWriteResponse(res)) {
      try {
        await writeResponseChunk(
          res,
          anthropicSseEvent('error', {
            type: 'error',
            error: {
              type: 'api_error',
              message: readableError(error),
            },
          }),
          signal,
        )
      } catch {
        // Client went away while sending the error frame.
      }
    }
  } finally {
    upstreamCleanup()
    release()
    const outputTokens = estimateTokens(textOutput || [...toolBlocks.values()].map((tool) => tool.partialJson).join('\n'))
    const finalFrames: string[] = []

    if (textBlockStarted && canWriteResponse(res)) {
      finalFrames.push(
        anthropicSseEvent('content_block_stop', {
          type: 'content_block_stop',
          index: textBlockIndex,
        }),
      )
    }

    for (const tool of toolBlocks.values()) {
      if (tool.started && canWriteResponse(res)) {
        finalFrames.push(
          anthropicSseEvent('content_block_stop', {
            type: 'content_block_stop',
            index: tool.blockIndex,
          }),
        )
      }
    }

    if (!hadError && canWriteResponse(res)) {
      finalFrames.push(
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
      finalFrames.push(
        anthropicSseEvent('message_stop', {
          type: 'message_stop',
        }),
      )
    }
    if (finalFrames.length && canWriteResponse(res)) {
      try {
        await writeResponseChunk(res, finalFrames.join(''), signal)
      } catch (error) {
        status = errorStatus(error, signal)
        hadError = true
      }
    }
    if (canWriteResponse(res)) {
      res.end()
    }

    recordRequest({
      endpoint: '/v1/messages',
      decision,
      startedAt,
      status,
      success: !hadError && status >= 200 && status < 300,
      inputTokens,
      outputTokens,
      queueMs,
      upstreamMs,
      firstByteMs,
      requestedModel,
      apiKey,
    })
  }
}

async function forwardClaudeCodeRaw(
  res: Response,
  config: AppConfig,
  decision: RouteDecision,
  payload: JsonRecord,
  startedAt: number,
  inputTokens: number,
  requestedModel: string,
  signal?: AbortSignal,
  options: PostJsonOptions = {},
) {
  const isStream = payload.stream === true
  let status = 502
  let hadError = false
  let apiKey = ''
  let release = noopRelease
  let upstreamCleanup = noopRelease
  let completedAt: number | undefined
  let queueMs = 0
  let upstreamMs = 0
  let firstByteMs = 0
  let sawFirstByte = false
  const decoder = new TextDecoder()
  const parseEvents = createSseParser()
  let rawText = ''
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
  }

  try {
    const queueStartedAt = Date.now()
    release = await requestConcurrencyLimiter.acquire(config, decision, { signal, skipProviderLimit: true })
    queueMs = Date.now() - queueStartedAt
    await waitForRequestDelay(decision.delayMs, signal)
    const upstreamRequest = await postJson(config, decision, payload, signal, options)
    const upstream = upstreamRequest.upstream
    upstreamCleanup = upstreamRequest.cleanup
    apiKey = upstreamRequest.apiKey
    upstreamMs = upstreamRequest.upstreamMs
    firstByteMs = upstreamRequest.upstreamMs
    status = upstream.status
    res.status(upstream.status)
    copyUpstreamResponseHeaders(
      res,
      upstream,
      isStream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8',
    )
    res.flushHeaders()

    for await (const chunk of streamBody(upstream)) {
      if (!sawFirstByte) {
        sawFirstByte = true
        firstByteMs = Date.now() - upstreamRequest.upstreamStartedAt
      }
      await writeResponseChunk(res, chunk, signal)
      const text = decoder.decode(chunk, { stream: true })
      if (isStream) {
        collectAnthropicStreamUsage(parseEvents(text), usage)
      } else {
        rawText += text
      }
    }

    const tail = decoder.decode()
    if (tail) {
      if (isStream) {
        collectAnthropicStreamUsage(parseEvents(tail), usage)
      } else {
        rawText += tail
      }
    }

    if (!isStream) {
      const data = safeJson(rawText)
      const responseUsage = readAnthropicUsage(data)
      usage.inputTokens = responseUsage.inputTokens
      usage.outputTokens = responseUsage.outputTokens || estimateTokens(Object.keys(data).length ? data : rawText)
    }
    completedAt = Date.now()
  } catch (error) {
    status = errorStatus(error, signal)
    hadError = true
    apiKey ||= readErrorApiKey(error)
    if (!isClientClosed(error, signal) && canWriteResponse(res) && !res.headersSent) {
      if (isStream) {
        prepareSse(res, status)
      } else {
        res.status(status).json({
          error: {
            type: status === 400 ? 'invalid_request_error' : 'api_error',
            message: readableError(error),
          },
        })
      }
    }
    if (isStream && !isClientClosed(error, signal) && canWriteResponse(res)) {
      try {
        await writeResponseChunk(
          res,
          anthropicSseEvent('error', {
            type: 'error',
            error: {
              type: 'api_error',
              message: readableError(error),
            },
          }),
          signal,
        )
      } catch {
        // Client went away while sending the error frame.
      }
    }
    completedAt = Date.now()
  } finally {
    upstreamCleanup()
    release()
    if (canWriteResponse(res)) {
      res.end()
    }
    const success = !hadError && status >= 200 && status < 300
    const recordedInputTokens = usage.inputTokens || inputTokens || (success ? estimateTokens(payload) : 0)
    recordRequest({
      endpoint: '/v1/messages',
      decision,
      startedAt,
      completedAt,
      status,
      success,
      inputTokens: recordedInputTokens,
      outputTokens: usage.outputTokens,
      queueMs,
      upstreamMs,
      firstByteMs,
      requestedModel,
      apiKey,
    })
  }
}

async function postJsonWithConcurrency(
  config: AppConfig,
  decision: RouteDecision,
  payload: JsonRecord,
  signal?: AbortSignal,
  options: PostJsonOptions = {},
) {
  const queueStartedAt = Date.now()
  const release = await requestConcurrencyLimiter.acquire(config, decision, { signal })
  const queueMs = Date.now() - queueStartedAt
  try {
    await waitForRequestDelay(decision.delayMs, signal)
    const upstreamRequest = await postJson(config, decision, payload, signal, options)
    try {
      const { data, firstByteMs } = await readJsonWithTiming(
        upstreamRequest.upstream,
        upstreamRequest.upstreamStartedAt,
        upstreamRequest.upstreamMs,
      )
      return {
        upstream: upstreamRequest.upstream,
        data,
        apiKey: upstreamRequest.apiKey,
        queueMs,
        upstreamMs: upstreamRequest.upstreamMs,
        firstByteMs,
      }
    } catch (error) {
      throw withApiKey(error, upstreamRequest.apiKey)
    } finally {
      upstreamRequest.cleanup()
    }
  } finally {
    release()
  }
}

async function postJson(
  config: AppConfig,
  decision: RouteDecision,
  payload: JsonRecord,
  signal?: AbortSignal,
  options: PostJsonOptions = {},
): Promise<PostJsonResult> {
  const upstreamAbort = createUpstreamAbort(config, signal)
  const selectedApiKey = selectProviderApiKey(decision)
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }

  if (selectedApiKey.value) {
    if (options.format === 'claude-code') {
      headers['x-api-key'] = selectedApiKey.value
      headers.authorization = `Bearer ${selectedApiKey.value}`
    } else {
      headers.authorization = `Bearer ${selectedApiKey.value}`
    }
  }

  if (options.format === 'claude-code') {
    headers['anthropic-version'] = options.headers?.['anthropic-version'] || '2023-06-01'
    headers.accept = payload.stream ? 'text/event-stream' : 'application/json'
    headers['accept-encoding'] = 'identity'
  }
  Object.assign(headers, options.headers)

  try {
    const upstreamStartedAt = Date.now()
    const upstream = await undiciFetch(resolveUpstreamUrl(decision.provider.api_base_url, options.format), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: upstreamAbort.signal,
      dispatcher: dispatcher(config),
    })
    const upstreamMs = Date.now() - upstreamStartedAt
    return {
      upstream,
      apiKey: selectedApiKey.label,
      upstreamStartedAt,
      upstreamMs,
      cleanup: () => {
        upstreamAbort.cleanup()
        selectedApiKey.release()
      },
    }
  } catch (error) {
    const reason = upstreamAbort.signal.reason
    upstreamAbort.cleanup()
    selectedApiKey.release()
    if (upstreamAbort.signal.aborted && reason instanceof Error) {
      throw withApiKey(reason, selectedApiKey.label)
    }
    throw withApiKey(error, selectedApiKey.label)
  }
}

function selectProviderApiKey(decision: RouteDecision): SelectedApiKey {
  const entries = readProviderApiKeyEntries(decision.provider).filter((entry) => !entry.disabled)
  if (!entries.length) {
    return {
      value: '',
      label: '',
      release: noopRelease,
    }
  }

  const strategy = normalizeApiKeyStrategy(decision.provider.api_key_strategy)
  const index = selectApiKeyIndex(decision.providerName, entries, strategy)
  const entry = entries[index] ?? entries[0]
  const value = entry.key
  const activeKey = providerApiKeyActiveKey(decision.providerName, index, value)
  activeApiKeys.set(activeKey, (activeApiKeys.get(activeKey) ?? 0) + 1)

  let released = false
  return {
    value,
    label: formatApiKeyLabel(entry),
    release: () => {
      if (released) {
        return
      }

      released = true
      const nextActive = Math.max(0, (activeApiKeys.get(activeKey) ?? 0) - 1)
      if (nextActive) {
        activeApiKeys.set(activeKey, nextActive)
      } else {
        activeApiKeys.delete(activeKey)
      }
    },
  }
}

function readProviderApiKeyEntries(provider: RouteDecision['provider']) {
  const rawKeys = Array.isArray(provider.api_keys) ? provider.api_keys : []
  const rawNames = Array.isArray(provider.api_key_names) ? provider.api_key_names : []
  const rawDisabled = Array.isArray(provider.api_key_disabled) ? provider.api_key_disabled : []
  return uniqueApiKeyEntries(rawKeys, rawNames, rawDisabled, provider.api_key)
}

function selectApiKeyIndex(providerName: string, entries: ProviderApiKeyEntry[], strategy: RouterStrategy) {
  if (entries.length <= 1) {
    return 0
  }

  if (strategy === 'random') {
    return Math.floor(Math.random() * entries.length)
  }

  if (strategy === 'loadBalance') {
    let bestIndex = 0
    let bestActive = Number.POSITIVE_INFINITY
    entries.forEach((entry, index) => {
      const active = activeApiKeys.get(providerApiKeyActiveKey(providerName, index, entry.key)) ?? 0
      if (active < bestActive) {
        bestActive = active
        bestIndex = index
      }
    })
    return bestIndex
  }

  const cursor = apiKeySequenceByProvider.get(providerName) ?? 0
  const index = cursor % entries.length
  apiKeySequenceByProvider.set(providerName, (index + 1) % entries.length)
  return index
}

function normalizeApiKeyStrategy(strategy: unknown): RouterStrategy {
  return strategy === 'loadBalance' || strategy === 'random' ? strategy : 'sequence'
}

function providerApiKeyActiveKey(providerName: string, index: number, key: string) {
  return `${providerName}:${index}:${key}`
}

function formatApiKeyLabel(entry: ProviderApiKeyEntry) {
  return entry.name || entry.key
}

function uniqueApiKeyEntries(
  keys: Array<unknown>,
  names: Array<unknown>,
  disabledValues: Array<unknown>,
  legacyApiKey: unknown,
) {
  const seen = new Set<string>()
  const result: ProviderApiKeyEntry[] = []

  keys.forEach((value, index) => {
    if (typeof value !== 'string') {
      return
    }

    const key = value.trim()
    if (!key || seen.has(key)) {
      return
    }

    const name = typeof names[index] === 'string' ? names[index].trim() : ''
    const disabled = disabledValues[index] === true
    seen.add(key)
    result.push({ key, name, disabled })
  })

  if (typeof legacyApiKey === 'string') {
    const key = legacyApiKey.trim()
    if (key && !seen.has(key)) {
      result.push({ key, name: '', disabled: false })
    }
  }

  return result
}

function withApiKey(error: unknown, apiKey: string) {
  if (apiKey && error && typeof error === 'object') {
    const apiKeyError = error as { apiKey?: string }
    apiKeyError.apiKey = apiKey
  }
  return error
}

function readErrorApiKey(error: unknown) {
  if (!error || typeof error !== 'object') {
    return ''
  }

  const apiKey = (error as { apiKey?: unknown }).apiKey
  return typeof apiKey === 'string' ? apiKey : ''
}

export function resolveUpstreamUrl(apiBaseUrl: string, format: UpstreamPayloadFormat = 'openai') {
  if (format !== 'claude-code') {
    return apiBaseUrl
  }

  try {
    const url = new URL(apiBaseUrl)
    const pathname = url.pathname.replace(/\/+$/, '')
    if (isDashScopeOpenAiBase(url, pathname)) {
      url.pathname = '/apps/anthropic/v1/messages'
      return url.toString()
    }

    if (pathname === '' || pathname === '/') {
      url.pathname = '/v1/messages'
      return url.toString()
    }

    if (pathname.endsWith('/v1/messages')) {
      url.pathname = pathname
      return url.toString()
    }

    if (pathname.endsWith('/v1')) {
      url.pathname = `${pathname}/messages`
      return url.toString()
    }

    url.pathname = `${pathname}/v1/messages`
    return url.toString()
  } catch {
    return apiBaseUrl
  }
}

function isDashScopeOpenAiBase(url: URL, pathname: string) {
  const hostname = url.hostname.toLowerCase()
  const isDashScope = hostname === 'dashscope.aliyuncs.com' || hostname.endsWith('.dashscope.aliyuncs.com')
  return isDashScope && (pathname === '/v1' || pathname === '/compatible-mode/v1')
}

function waitForRequestDelay(delayMs: number, signal?: AbortSignal) {
  if (delayMs <= 0) {
    return Promise.resolve()
  }

  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? clientClosedError())
  }

  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, delayMs)
    const abort = () => {
      cleanup()
      reject(signal?.reason ?? clientClosedError())
    }
    const cleanup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
    }

    signal?.addEventListener('abort', abort, { once: true })
  })
}

function createUpstreamAbort(config: AppConfig, signal?: AbortSignal) {
  const controller = new AbortController()
  const abortWithClientSignal = () => {
    if (!controller.signal.aborted) {
      controller.abort(signal?.reason ?? clientClosedError())
    }
  }
  if (signal?.aborted) {
    abortWithClientSignal()
  } else {
    signal?.addEventListener('abort', abortWithClientSignal, { once: true })
  }

  const timeout = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(upstreamTimeoutError())
    }
  }, timeoutMs(config))
  let cleaned = false

  return {
    signal: controller.signal,
    cleanup: () => {
      if (cleaned) {
        return
      }

      cleaned = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortWithClientSignal)
    },
  }
}

function dispatcher(config: AppConfig): Agent | ProxyAgent {
  const proxyUrl = config.PROXY_URL.trim()
  if (proxyUrl) {
    if (cachedProxyUrl !== proxyUrl || !cachedProxyAgent) {
      cachedProxyUrl = proxyUrl
      cachedProxyAgent = new ProxyAgent(proxyUrl)
    }

    return cachedProxyAgent
  }

  if (!cachedDirectAgent) {
    cachedProxyUrl = proxyUrl
    cachedDirectAgent = new Agent({
      connections: 64,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 120_000,
      pipelining: 1,
    })
  }

  return cachedDirectAgent
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

function shouldForwardClaudeCode(decision: RouteDecision) {
  if (decision.provider.api_protocol === 'openai-chat') {
    return false
  }

  return decision.provider.api_protocol === 'anthropic-messages' || decision.provider.claude_code_forward === true
}

function readClaudeCodeForwardHeaders(req: Request) {
  const headers: Record<string, string> = {}
  const anthropicVersion = req.header('anthropic-version')
  const anthropicBeta = req.header('anthropic-beta')

  if (anthropicVersion) {
    headers['anthropic-version'] = anthropicVersion
  }
  if (anthropicBeta) {
    headers['anthropic-beta'] = anthropicBeta
  }

  return headers
}

function createClientDisconnectSignal(req: Request, res: Response) {
  const controller = new AbortController()
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(clientClosedError())
    }
  }
  const abortIfResponseClosedEarly = () => {
    if (!res.writableEnded) {
      abort()
    }
  }

  req.once('aborted', abort)
  res.once('close', abortIfResponseClosedEarly)

  return {
    signal: controller.signal,
    cleanup: () => {
      req.off('aborted', abort)
      res.off('close', abortIfResponseClosedEarly)
    },
  }
}

function prepareSse(res: Response, status: number) {
  res.status(status)
  res.setHeader('content-type', 'text/event-stream; charset=utf-8')
  res.setHeader('cache-control', 'no-cache, no-transform')
  res.setHeader('connection', 'keep-alive')
  res.flushHeaders()
}

function copyUpstreamResponseHeaders(res: Response, upstream: globalThis.Response, fallbackContentType: string) {
  const contentType = upstream.headers.get('content-type') || fallbackContentType
  res.setHeader('content-type', contentType)

  for (const [name, value] of upstream.headers) {
    const normalized = name.toLowerCase()
    if (
      normalized.startsWith('anthropic-') ||
      normalized.startsWith('x-ratelimit-') ||
      normalized === 'retry-after'
    ) {
      res.setHeader(name, value)
    }
  }
}

function canWriteResponse(res: Response) {
  return !res.destroyed && !res.writableEnded
}

async function writeResponseChunk(res: Response, chunk: string | Uint8Array, signal?: AbortSignal) {
  if (!canWriteResponse(res) || signal?.aborted) {
    throw signal?.reason ?? clientClosedError()
  }

  if (res.write(chunk)) {
    return
  }

  await waitForResponseDrain(res, signal)
}

function waitForResponseDrain(res: Response, signal?: AbortSignal) {
  if (!canWriteResponse(res) || signal?.aborted) {
    return Promise.reject(signal?.reason ?? clientClosedError())
  }

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      res.off('drain', onDrain)
      res.off('close', onClose)
      res.off('finish', onClose)
      res.off('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onClose = () => {
      cleanup()
      reject(signal?.reason ?? clientClosedError())
    }
    const onError = (error: unknown) => {
      cleanup()
      reject(error instanceof Error ? error : clientClosedError())
    }
    const onAbort = () => {
      cleanup()
      reject(signal?.reason ?? clientClosedError())
    }

    res.once('drain', onDrain)
    res.once('close', onClose)
    res.once('finish', onClose)
    res.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function* streamBody(response: globalThis.Response): AsyncGenerator<Uint8Array> {
  if (!response.body) {
    return
  }

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    yield chunk
  }
}

async function readJsonWithTiming(
  response: globalThis.Response,
  upstreamStartedAt: number,
  fallbackFirstByteMs: number,
): Promise<{ data: JsonRecord; firstByteMs: number }> {
  if (!response.body) {
    return {
      data: (await response.json()) as JsonRecord,
      firstByteMs: fallbackFirstByteMs,
    }
  }

  const decoder = new TextDecoder()
  let rawText = ''
  let firstByteMs = 0
  let sawFirstByte = false

  for await (const chunk of streamBody(response)) {
    if (!sawFirstByte) {
      sawFirstByte = true
      firstByteMs = Date.now() - upstreamStartedAt
    }
    rawText += decoder.decode(chunk, { stream: true })
  }
  rawText += decoder.decode()

  return {
    data: JSON.parse(rawText) as JsonRecord,
    firstByteMs: sawFirstByte ? firstByteMs : fallbackFirstByteMs,
  }
}

function recordRequest(input: {
  endpoint: string
  decision?: RouteDecision
  startedAt: number
  completedAt?: number
  status: number
  success: boolean
  inputTokens: number
  outputTokens: number
  queueMs?: number
  upstreamMs?: number
  firstByteMs?: number
  requestedModel: string
  apiKey?: string
  error?: string
}) {
  const decision = input.decision
  const record: RequestRecordInput = {
    endpoint: input.endpoint,
    provider: decision?.providerName ?? 'unknown',
    apiKey: input.apiKey ?? '',
    model: input.requestedModel || decision?.targetModel || 'unknown',
    targetModel: decision?.targetModel ?? 'unknown',
    routeKey: decision?.routeKey ?? 'unknown',
    status: input.status,
    success: input.success,
    latencyMs: Math.max(0, (input.completedAt ?? Date.now()) - input.startedAt),
    queueMs: input.queueMs ?? 0,
    upstreamMs: input.upstreamMs ?? 0,
    firstByteMs: input.firstByteMs ?? 0,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    error: input.error,
  }

  storage.enqueueRequest(record)
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
    apiKey: readErrorApiKey(error),
    error: message,
  })

  if (res.headersSent || !canWriteResponse(res)) {
    return
  }

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

function collectAnthropicStreamUsage(
  events: string[],
  usage: { inputTokens: number; outputTokens: number },
) {
  for (const event of events) {
    if (event === '[DONE]' || !event.includes('"usage"')) {
      continue
    }

    const data = safeJson(event)
    const message = asRecord(data.message)
    const messageUsage = asRecord(message.usage)
    const deltaUsage = asRecord(data.usage)

    usage.inputTokens ||= readNumber(messageUsage.input_tokens)
    usage.outputTokens = readNumber(deltaUsage.output_tokens) || usage.outputTokens
  }
}

function collectToolDeltaEvents(
  rawToolCalls: unknown,
  toolBlocks: Map<number, { blockIndex: number; id: string; name: string; partialJson: string; started: boolean }>,
  blockCounter: { next: number },
  frames: string[],
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
      frames.push(
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
      frames.push(
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

function errorStatus(error: unknown, signal?: AbortSignal) {
  if (isClientClosed(error, signal)) {
    return 499
  }

  return typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : 502
}

function isClientClosed(error: unknown, signal?: AbortSignal) {
  return isClientClosedError(error) || isClientClosedError(signal?.reason)
}

function isClientClosedError(error: unknown) {
  return (error as { code?: unknown }).code === 'CLIENT_CLOSED_REQUEST'
}

function upstreamTimeoutError() {
  const error = new Error('Upstream request timed out') as Error & { status?: number }
  error.status = 504
  return error
}

function readableError(error: unknown) {
  if (error instanceof Error) {
    return error.name === 'AbortError' ? 'Upstream request timed out' : error.message
  }
  return String(error)
}

function noopRelease() {}
