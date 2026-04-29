import { randomUUID } from 'node:crypto'
import { Router, type Request, type Response } from 'express'
import { Agent, ProxyAgent, fetch as undiciFetch } from 'undici'
import { anthropicSseEvent } from './anthropic.js'
import { clientClosedError } from './concurrency.js'
import { selectCodexCredential } from './codexAuth.js'
import { storage } from './storage.js'
import { estimateTokens } from './token.js'
import type { AppConfig, CodexConfig, RequestRecordInput } from './types.js'

type CodexEndpoint = 'responses' | 'responses/compact'
type JsonRecord = Record<string, unknown>

interface CodexAnthropicMessageOptions {
  body: JsonRecord
  requestedModel: string
  targetModel: string
  startedAt: number
  inputTokens: number
  delayMs?: number
  signal?: AbortSignal
}

interface CodexAnthropicStreamResult {
  status: number
  success: boolean
  outputTokens: number
  firstByteMs: number
  errorMessage: string
}

const defaultCodexBaseUrl = 'https://chatgpt.com/backend-api/codex'
const defaultCodexUserAgent = 'codex-tui/0.118.0 (Mac OS 26.3.1; arm64) iTerm.app/3.6.9 (codex-tui; 0.118.0)'
const hopByHopHeaders = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const protectedRequestHeaders = new Set(['authorization', 'content-length', 'host'])

let cachedProxyUrl = ''
let cachedProxyAgent: ProxyAgent | undefined
let cachedDirectAgent: Agent | undefined

export function createCodexBackendRouter() {
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

  router.post('/responses', async (req, res) => {
    await handleCodexResponses(req, res, 'responses', '/backend-api/codex/responses')
  })

  router.post('/responses/compact', async (req, res) => {
    await handleCodexResponses(req, res, 'responses/compact', '/backend-api/codex/responses/compact')
  })

  return router
}

export async function handleCodexResponses(
  req: Request,
  res: Response,
  endpoint: CodexEndpoint,
  publicEndpoint = `/v1/${endpoint}`,
) {
  const startedAt = Date.now()
  const config = storage.getConfig()
  const codex = config.Codex
  const body = readJsonBody(req.body)
  const requestedModel = String(body.model ?? '')
  const targetModel = resolveCodexModel(codex, requestedModel)
  const payload: JsonRecord = targetModel && targetModel !== requestedModel ? { ...body, model: targetModel } : body
  const inputTokens = estimateTokens(payload.input ?? payload.messages ?? payload)
  const clientDisconnect = createClientDisconnectSignal(req, res)
  let status = 502
  let success = false
  let outputText = ''
  let outputTokens = 0
  let estimatedStreamOutputTokens = 0
  let firstByteMs = 0
  let upstreamMs = 0
  let apiKeyLabel = ''
  let completedAt: number | undefined

  try {
    if (!codex.enabled) {
      throw httpError(404, 'Codex proxy is disabled')
    }

    const credential = selectCodexCredential(codex)
    apiKeyLabel = credential.label
    const upstreamStartedAt = Date.now()
    const upstreamAbort = createUpstreamAbort(config, clientDisconnect.signal)

    try {
      const upstream = await undiciFetch(resolveCodexUpstreamUrl(codex.baseUrl, endpoint), {
        method: 'POST',
        headers: buildCodexRequestHeaders(req, codex, credential, payload.stream === true),
        body: JSON.stringify(payload),
        signal: upstreamAbort.signal,
        dispatcher: dispatcher(config),
      })
      upstreamMs = Date.now() - upstreamStartedAt
      status = upstream.status
      success = upstream.ok
      res.status(upstream.status)
      copyCodexResponseHeaders(res, upstream, payload.stream === true)
      res.flushHeaders()

      const decoder = new TextDecoder()
      const sseParser = payload.stream === true ? createSseDataRecordParser() : undefined
      let sawFirstByte = false
      for await (const chunk of streamBody(upstream)) {
        if (!sawFirstByte) {
          sawFirstByte = true
          firstByteMs = Date.now() - upstreamStartedAt
        }
        await writeResponseChunk(res, chunk, clientDisconnect.signal)
        const text = decoder.decode(chunk, { stream: true })
        if (sseParser) {
          const stats = readCodexStatsFromStreamEvents(sseParser.feed(text))
          outputTokens ||= stats.outputTokens
          estimatedStreamOutputTokens += stats.estimatedOutputTokens
        } else {
          outputText += text
        }
      }
      const tail = decoder.decode()
      if (sseParser) {
        const stats = readCodexStatsFromStreamEvents([
          ...sseParser.feed(tail),
          ...sseParser.finish(),
        ])
        outputTokens ||= stats.outputTokens
        estimatedStreamOutputTokens += stats.estimatedOutputTokens
      } else {
        outputText += tail
      }
      if (!sawFirstByte) {
        firstByteMs = upstreamMs
      }
    } finally {
      upstreamAbort.cleanup()
    }
  } catch (error) {
    status = errorStatus(error, clientDisconnect.signal)
    success = false
    if (!isClientClosed(error, clientDisconnect.signal) && canWriteResponse(res) && !res.headersSent) {
      res.status(status).json({
        error: {
          type: status === 400 || status === 404 ? 'invalid_request_error' : 'api_error',
          message: readableError(error),
        },
      })
    }
  } finally {
    completedAt = Date.now()
    clientDisconnect.cleanup()
    if (canWriteResponse(res) && res.headersSent) {
      res.end()
    }
    recordCodexRequest({
      endpoint: publicEndpoint,
      startedAt,
      completedAt,
      status,
      success,
      model: requestedModel || targetModel || 'codex',
      targetModel: targetModel || requestedModel || 'codex',
      inputTokens,
      outputTokens: outputTokens || estimatedStreamOutputTokens || estimateTokens(readCodexOutputForStats(outputText)),
      upstreamMs,
      firstByteMs,
      apiKey: apiKeyLabel,
    })
  }
}

export async function handleCodexAnthropicMessages(
  req: Request,
  res: Response,
  options: CodexAnthropicMessageOptions,
) {
  const config = storage.getConfig()
  const codex = config.Codex
  const isAnthropicStream = options.body.stream === true
  const payload = anthropicToCodexResponsesPayload(options.body, options.targetModel)
  const clientDisconnect = createClientDisconnectSignal(req, res)
  const linkedSignal = linkAbortSignals(options.signal, clientDisconnect.signal)
  let status = 502
  let success = false
  let apiKeyLabel = ''
  let outputTokens = 0
  let upstreamMs = 0
  let firstByteMs = 0
  let completedAt: number | undefined
  let errorMessage = ''

  try {
    if (!codex.enabled) {
      throw httpError(404, 'Codex proxy is disabled')
    }

    const credential = selectCodexCredential(codex)
    apiKeyLabel = credential.label
    await waitForRequestDelay(options.delayMs ?? 0, linkedSignal.signal)

    const upstreamAbort = createUpstreamAbort(config, linkedSignal.signal)
    try {
      const upstreamStartedAt = Date.now()
      const upstream = await undiciFetch(resolveCodexUpstreamUrl(codex.baseUrl, 'responses'), {
        method: 'POST',
        headers: buildCodexRequestHeaders(req, codex, credential, true),
        body: JSON.stringify(payload),
        signal: upstreamAbort.signal,
        dispatcher: dispatcher(config),
      })
      upstreamMs = Date.now() - upstreamStartedAt
      status = upstream.status

      if (isAnthropicStream) {
        const streamResult = await streamCodexAnthropicResponse(res, upstream, {
          upstreamStartedAt,
          fallbackFirstByteMs: upstreamMs,
          requestedModel: options.requestedModel,
          targetModel: options.targetModel,
          inputTokens: options.inputTokens,
          signal: linkedSignal.signal,
        })
        status = streamResult.status
        success = streamResult.success
        outputTokens = streamResult.outputTokens
        firstByteMs = streamResult.firstByteMs
        errorMessage = streamResult.errorMessage
        return
      }

      const { text, firstByteMs: readFirstByteMs } = await readResponseText(upstream, upstreamStartedAt, upstreamMs, linkedSignal.signal)
      firstByteMs = readFirstByteMs
      const data = parseCodexResponsePayload(text)
      const hasCompletedResponse = isCompletedCodexResponse(data)
      success = upstream.ok || hasCompletedResponse
      status = success ? 200 : nonRetryCodexStatus(upstream.status)

      if (!success || hasCodexError(data)) {
        success = false
        status = upstream.ok ? 400 : status
        errorMessage = readCodexErrorMessage(data, text)
        const errorPayload = codexErrorPayload(errorMessage, upstream.status)
        if (isAnthropicStream) {
          await writeCodexAnthropicStream(res, status, false, {}, errorPayload, linkedSignal.signal)
        } else {
          res.status(status).json(errorPayload)
        }
        return
      }

      const responseBody = codexResponseToAnthropic(data, options.requestedModel, options.targetModel, options.inputTokens)
      const usage = readCodexUsage(data)
      outputTokens = usage.outputTokens || estimateTokens(responseBody)

      if (isAnthropicStream) {
        await writeCodexAnthropicStream(res, status, true, responseBody, data, linkedSignal.signal)
      } else {
        res.status(status).json(responseBody)
      }
    } finally {
      upstreamAbort.cleanup()
    }
  } catch (error) {
    status = isClientClosed(error, linkedSignal.signal)
      ? errorStatus(error, linkedSignal.signal)
      : nonRetryCodexStatus(errorStatus(error, linkedSignal.signal))
    success = false
    errorMessage = readableError(error)
    if (!isClientClosed(error, linkedSignal.signal) && canWriteResponse(res) && !res.headersSent) {
      if (isAnthropicStream) {
        prepareAnthropicSse(res, status)
        await writeResponseChunk(
          res,
          anthropicSseEvent('error', {
            type: 'error',
            error: {
              type: status === 400 || status === 404 ? 'invalid_request_error' : 'api_error',
              message: readableError(error),
            },
          }),
          linkedSignal.signal,
        )
      } else {
        res.status(status).json({
          error: {
            type: status === 400 || status === 404 ? 'invalid_request_error' : 'api_error',
            message: readableError(error),
          },
        })
      }
    }
  } finally {
    completedAt = Date.now()
    linkedSignal.cleanup()
    clientDisconnect.cleanup()
    if (canWriteResponse(res) && res.headersSent) {
      res.end()
    }
    recordCodexRequest({
      endpoint: '/v1/messages',
      startedAt: options.startedAt,
      completedAt,
      status,
      success,
      model: options.requestedModel || options.targetModel || 'codex',
      targetModel: options.targetModel || options.requestedModel || 'codex',
      inputTokens: options.inputTokens,
      outputTokens,
      upstreamMs,
      firstByteMs,
      apiKey: apiKeyLabel,
      error: errorMessage,
    })
  }
}

export function resolveCodexUpstreamUrl(baseUrl: string, endpoint: CodexEndpoint) {
  const trimmedBaseUrl = (baseUrl || defaultCodexBaseUrl).trim().replace(/\/+$/, '')
  return `${trimmedBaseUrl}/${endpoint}`
}

function buildCodexRequestHeaders(
  req: Request,
  codex: CodexConfig,
  credential: { token: string; accountId: string },
  isStream: boolean,
) {
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential.token}`,
    accept: isStream ? 'text/event-stream' : 'application/json',
    'content-type': 'application/json',
    connection: 'Keep-Alive',
    'user-agent': normalizeCodexUserAgent(codex.userAgent) || req.header('user-agent') || defaultCodexUserAgent,
    originator: req.header('originator') || 'codex-tui',
  }

  copyRequestHeader(req, headers, 'version')
  copyRequestHeader(req, headers, 'x-codex-turn-metadata')
  copyRequestHeader(req, headers, 'x-client-request-id')
  copyRequestHeader(req, headers, 'session_id')
  copyRequestHeader(req, headers, 'openai-beta')

  if (headers['user-agent'].includes('Mac OS') && !headers.session_id) {
    headers.session_id = randomUUID()
  }

  const betaFeatures = req.header('x-codex-beta-features') || codex.betaFeatures.trim()
  if (betaFeatures) {
    headers['x-codex-beta-features'] = betaFeatures
  }
  if (credential.accountId) {
    headers['chatgpt-account-id'] = credential.accountId
  }

  for (const [name, value] of Object.entries(codex.headers)) {
    const normalized = name.toLowerCase()
    if (!value || hopByHopHeaders.has(normalized) || protectedRequestHeaders.has(normalized)) {
      continue
    }
    headers[normalized] = value
  }

  return headers
}

function normalizeCodexUserAgent(userAgent: string) {
  const trimmed = userAgent.trim()
  return trimmed === 'codex-tui/0.118.0' ? '' : trimmed
}

function copyRequestHeader(req: Request, target: Record<string, string>, name: string) {
  const value = req.header(name)
  if (value) {
    target[name.toLowerCase()] = value
  }
}

function copyCodexResponseHeaders(res: Response, upstream: globalThis.Response, isStream: boolean) {
  const fallbackContentType = isStream ? 'text/event-stream; charset=utf-8' : 'application/json; charset=utf-8'
  res.setHeader('content-type', upstream.headers.get('content-type') || fallbackContentType)

  for (const [name, value] of upstream.headers) {
    const normalized = name.toLowerCase()
    if (
      hopByHopHeaders.has(normalized) ||
      normalized === 'content-type' ||
      normalized === 'content-length'
    ) {
      continue
    }
    if (normalized.startsWith('x-') || normalized.startsWith('openai-') || normalized === 'retry-after') {
      res.setHeader(name, value)
    }
  }
}

export function resolveCodexModel(codex: CodexConfig, requestedModel: string) {
  if (!requestedModel) {
    return ''
  }

  const model = codex.models.find((item) => item.alias === requestedModel || item.name === requestedModel)
  return model?.name || requestedModel
}

function anthropicToCodexResponsesPayload(body: JsonRecord, model: string): JsonRecord {
  const payload: JsonRecord = {
    model,
    instructions: '',
    input: anthropicMessagesToCodexInput(body),
    stream: true,
    store: false,
    parallel_tool_calls: true,
    include: ['reasoning.encrypted_content'],
    reasoning: {
      effort: codexReasoningEffort(body),
      summary: 'auto',
    },
  }

  const tools = anthropicToolsToCodex(body.tools)
  if (tools.length) {
    payload.tools = tools
    payload.tool_choice = 'auto'
  }

  const toolChoice = asRecord(body.tool_choice)
  if (toolChoice.disable_parallel_tool_use === true) {
    payload.parallel_tool_calls = false
  }

  return payload
}

function anthropicMessagesToCodexInput(body: JsonRecord) {
  const input: JsonRecord[] = []
  const systemParts = systemToTextParts(body.system)
  if (systemParts.length) {
    input.push({
      type: 'message',
      role: 'developer',
      content: systemParts.map((text) => ({ type: 'input_text', text })),
    })
  }

  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const messageValue of messages) {
    const message = asRecord(messageValue)
    const role = message.role === 'assistant' ? 'assistant' : 'user'

    if (typeof message.content === 'string') {
      input.push({
        type: 'message',
        role,
        content: [
          {
            type: role === 'assistant' ? 'output_text' : 'input_text',
            text: message.content,
          },
        ],
      })
      continue
    }

    if (!Array.isArray(message.content)) {
      continue
    }

    let content: JsonRecord[] = []
    const flushMessage = () => {
      if (!content.length) {
        return
      }
      input.push({
        type: 'message',
        role,
        content,
      })
      content = []
    }

    for (const blockValue of message.content) {
      const block = asRecord(blockValue)
      if (block.type === 'text' && typeof block.text === 'string') {
        content.push({
          type: role === 'assistant' ? 'output_text' : 'input_text',
          text: block.text,
        })
        continue
      }

      if (block.type === 'image') {
        const source = asRecord(block.source)
        const imageUrl = imageSourceToDataUrl(source)
        if (imageUrl) {
          content.push({
            type: 'input_image',
            image_url: imageUrl,
          })
        }
        continue
      }

      if (role === 'assistant' && block.type === 'tool_use') {
        flushMessage()
        input.push({
          type: 'function_call',
          call_id: String(block.id ?? `toolu_${randomUUID().replaceAll('-', '')}`),
          name: shortenCodexToolName(String(block.name ?? 'tool')),
          arguments: JSON.stringify(block.input ?? {}),
        })
        continue
      }

      if (block.type === 'tool_result') {
        flushMessage()
        input.push({
          type: 'function_call_output',
          call_id: String(block.tool_use_id ?? ''),
          output: codexToolResultOutput(block.content),
        })
      }
    }

    flushMessage()
  }

  return input
}

function systemToTextParts(system: unknown) {
  const parts: string[] = []
  const append = (text: string) => {
    const trimmed = text.trim()
    if (trimmed && !trimmed.startsWith('x-anthropic-billing-header: ')) {
      parts.push(text)
    }
  }

  if (typeof system === 'string') {
    append(system)
    return parts
  }

  if (!Array.isArray(system)) {
    return parts
  }

  for (const item of system) {
    const record = asRecord(item)
    if (record.type === 'text' && typeof record.text === 'string') {
      append(record.text)
    }
  }

  return parts
}

function anthropicToolsToCodex(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  const names = value
    .map((tool) => asRecord(tool).name)
    .filter((name): name is string => typeof name === 'string' && Boolean(name))
  const nameMap = buildShortNameMap(names)

  const tools: JsonRecord[] = []
  for (const toolValue of value) {
    const tool = asRecord(toolValue)
    if (tool.type === 'web_search_20250305') {
      tools.push({ type: 'web_search' })
      continue
    }
    if (typeof tool.name !== 'string') {
      continue
    }
    tools.push({
      type: 'function',
      name: nameMap.get(tool.name) ?? shortenCodexToolName(tool.name),
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: normalizeCodexToolParameters(tool.input_schema),
      strict: false,
    })
  }

  return tools
}

function normalizeCodexToolParameters(value: unknown) {
  const schema = asRecord(value)
  if (!Object.keys(schema).length) {
    return {
      type: 'object',
      properties: {},
    }
  }
  const { $schema: _schema, ...rest } = schema
  return rest
}

function codexToolResultOutput(content: unknown): unknown {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return JSON.stringify(content ?? '')
  }

  const parts: JsonRecord[] = []
  for (const item of content) {
    const part = asRecord(item)
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push({ type: 'input_text', text: part.text })
      continue
    }
    if (part.type === 'image') {
      const imageUrl = imageSourceToDataUrl(asRecord(part.source))
      if (imageUrl) {
        parts.push({ type: 'input_image', image_url: imageUrl })
      }
    }
  }

  return parts.length ? parts : content.map((item) => JSON.stringify(item)).join('\n')
}

function codexReasoningEffort(body: JsonRecord) {
  const thinking = asRecord(body.thinking)
  if (thinking.type === 'disabled') {
    return 'none'
  }

  const outputConfig = asRecord(body.output_config)
  if (typeof outputConfig.effort === 'string' && outputConfig.effort.trim()) {
    return outputConfig.effort.trim()
  }

  const budgetTokens = readNumber(thinking.budget_tokens)
  if (budgetTokens <= 0) {
    return 'medium'
  }
  if (budgetTokens < 4_000) {
    return 'low'
  }
  if (budgetTokens < 12_000) {
    return 'medium'
  }
  if (budgetTokens < 32_000) {
    return 'high'
  }
  return 'xhigh'
}

function buildShortNameMap(names: string[]) {
  const used = new Set<string>()
  const mapping = new Map<string, string>()
  for (const name of names) {
    let candidate = shortenCodexToolName(name)
    if (used.has(candidate)) {
      const base = candidate.slice(0, 58)
      let index = 1
      while (used.has(`${base}_${index}`)) {
        index += 1
      }
      candidate = `${base}_${index}`
    }
    used.add(candidate)
    mapping.set(name, candidate)
  }
  return mapping
}

function shortenCodexToolName(name: string) {
  if (name.length <= 64) {
    return name
  }
  if (name.startsWith('mcp__')) {
    const index = name.lastIndexOf('__')
    if (index > 0) {
      return `mcp__${name.slice(index + 2)}`.slice(0, 64)
    }
  }
  return name.slice(0, 64)
}

function imageSourceToDataUrl(source: JsonRecord) {
  if (typeof source.url === 'string') {
    return source.url
  }

  const data = typeof source.data === 'string' ? source.data : typeof source.base64 === 'string' ? source.base64 : ''
  if (!data) {
    return ''
  }
  const mediaType =
    typeof source.media_type === 'string'
      ? source.media_type
      : typeof source.mime_type === 'string'
        ? source.mime_type
        : 'application/octet-stream'
  return `data:${mediaType};base64,${data}`
}

function codexResponseToAnthropic(data: JsonRecord, requestModel: string, fallbackModel: string, inputTokens: number): JsonRecord {
  const usage = readCodexUsage(data)
  const text = readCodexResponseText(data)

  return {
    id: String(data.id ?? `msg_${randomUUID().replaceAll('-', '')}`),
    type: 'message',
    role: 'assistant',
    model: requestModel || fallbackModel,
    content: [
      {
        type: 'text',
        text,
      },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens || inputTokens,
      output_tokens: usage.outputTokens || estimateTokens(text),
    },
  }
}

function readCodexResponseText(data: JsonRecord) {
  if (typeof data.output_text === 'string') {
    return data.output_text
  }

  const chunks: string[] = []
  const output = Array.isArray(data.output) ? data.output : []
  for (const itemValue of output) {
    const item = asRecord(itemValue)
    const content = Array.isArray(item.content) ? item.content : []
    for (const partValue of content) {
      const part = asRecord(partValue)
      if (typeof part.text === 'string') {
        chunks.push(part.text)
      }
    }
  }

  return chunks.join('')
}

function parseCodexResponsePayload(text: string) {
  const json = safeJson(text)
  if (Object.keys(json).length) {
    return json
  }

  let deltaText = ''
  const outputItems: JsonRecord[] = []
  let error: JsonRecord = {}
  let completedResponse: JsonRecord = {}

  for (const event of parseSseDataRecords(text)) {
    const type = typeof event.type === 'string' ? event.type : ''
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      deltaText += event.delta
      continue
    }
    if (type === 'response.output_item.done') {
      const item = asRecord(event.item)
      if (Object.keys(item).length) {
        outputItems.push(item)
      }
      continue
    }
    if (type === 'response.completed') {
      const response = asRecord(event.response)
      if (Object.keys(response).length) {
        completedResponse = response
      }
      continue
    }
    if (type === 'response.failed' || type === 'error') {
      error = asRecord(event.error)
    }
  }

  if (deltaText) {
    outputItems.push({
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: deltaText,
        },
      ],
    })
  }

  if (Object.keys(completedResponse).length) {
    const responseOutput = Array.isArray(completedResponse.output) ? completedResponse.output : []
    return {
      ...completedResponse,
      output: responseOutput.length ? responseOutput : outputItems,
    }
  }

  const state: JsonRecord = {
    output: outputItems,
    usage: {},
  }
  if (Object.keys(error).length) {
    state.error = error
  }
  return state
}

function isCompletedCodexResponse(data: JsonRecord) {
  return data.status === 'completed' || (data.object === 'response' && data.status !== 'failed' && Array.isArray(data.output))
}

function hasCodexError(data: JsonRecord) {
  if (data.status === 'failed') {
    return true
  }
  const error = asRecord(data.error)
  return typeof error.message === 'string' && Boolean(error.message.trim())
}

function parseSseDataRecords(text: string) {
  const records: JsonRecord[] = []
  let dataLines: string[] = []

  const flush = () => {
    if (!dataLines.length) {
      return
    }
    const raw = dataLines.join('\n').trim()
    dataLines = []
    if (!raw || raw === '[DONE]') {
      return
    }
    const json = safeJson(raw)
    if (Object.keys(json).length) {
      records.push(json)
    }
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      flush()
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  flush()

  return records
}

function readCodexUsage(data: JsonRecord) {
  const usage = asRecord(data.usage)
  return {
    inputTokens: readNumber(usage.input_tokens) || readNumber(usage.prompt_tokens),
    outputTokens: readNumber(usage.output_tokens) || readNumber(usage.completion_tokens),
  }
}

function readCodexStatsFromStreamEvents(events: JsonRecord[]) {
  const stats = {
    outputTokens: 0,
    estimatedOutputTokens: 0,
  }

  for (const event of events) {
    const type = typeof event.type === 'string' ? event.type : ''
    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      stats.estimatedOutputTokens += estimateTokens(event.delta)
      continue
    }

    if (type === 'response.output_text.done' && typeof event.text === 'string') {
      stats.estimatedOutputTokens ||= estimateTokens(event.text)
      continue
    }

    if (type === 'response.output_item.done') {
      stats.estimatedOutputTokens ||= estimateTokens(readCodexResponseText({ output: [asRecord(event.item)] }))
      continue
    }

    if (type === 'response.completed') {
      const response = asRecord(event.response)
      const usage = readCodexUsage(response)
      stats.outputTokens = usage.outputTokens
      if (!stats.outputTokens && !stats.estimatedOutputTokens) {
        stats.estimatedOutputTokens = estimateTokens(readCodexResponseText(response))
      }
    }
  }
  return stats
}

async function writeCodexAnthropicStream(
  res: Response,
  status: number,
  ok: boolean,
  responseBody: JsonRecord,
  errorData: JsonRecord,
  signal?: AbortSignal,
) {
  prepareAnthropicSse(res, status)
  if (!ok) {
    await writeResponseChunk(
      res,
      anthropicSseEvent('error', {
        type: 'error',
        error: {
          type: 'api_error',
          message: readCodexErrorMessage(errorData),
        },
      }),
      signal,
    )
    return
  }

  const content = Array.isArray(responseBody.content) ? responseBody.content : []
  const text = content
    .map((item) => {
      const part = asRecord(item)
      return typeof part.text === 'string' ? part.text : ''
    })
    .join('')
  const usage = asRecord(responseBody.usage)
  const outputTokens = readNumber(usage.output_tokens) || estimateTokens(text)

  await writeResponseChunk(
    res,
    anthropicSseEvent('message_start', {
      type: 'message_start',
      message: responseBody,
    }),
    signal,
  )
  await writeResponseChunk(
    res,
    anthropicSseEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'text',
        text: '',
      },
    }),
    signal,
  )
  if (text) {
    await writeResponseChunk(
      res,
      anthropicSseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text,
        },
      }),
      signal,
    )
  }
  await writeResponseChunk(
    res,
    anthropicSseEvent('content_block_stop', {
      type: 'content_block_stop',
      index: 0,
    }),
    signal,
  )
  await writeResponseChunk(
    res,
    anthropicSseEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: 'end_turn',
        stop_sequence: null,
      },
      usage: {
        output_tokens: outputTokens,
      },
    }),
    signal,
  )
  await writeResponseChunk(
    res,
    anthropicSseEvent('message_stop', {
      type: 'message_stop',
    }),
    signal,
  )
}

async function streamCodexAnthropicResponse(
  res: Response,
  upstream: globalThis.Response,
  options: {
    upstreamStartedAt: number
    fallbackFirstByteMs: number
    requestedModel: string
    targetModel: string
    inputTokens: number
    signal?: AbortSignal
  },
): Promise<CodexAnthropicStreamResult> {
  prepareAnthropicSse(res, 200)

  const decoder = new TextDecoder()
  const parser = createSseDataRecordParser()
  let status = upstream.status
  let success = false
  let outputText = ''
  let outputTokens = 0
  let firstByteMs = options.fallbackFirstByteMs
  let sawFirstByte = false
  let messageStarted = false
  let blockStarted = false
  let blockStopped = false
  let errorMessage = ''
  const messageId = `msg_${randomUUID().replaceAll('-', '')}`

  const ensureMessageStarted = async (id = messageId) => {
    if (messageStarted) {
      return
    }
    messageStarted = true
    await writeResponseChunk(
      res,
      anthropicSseEvent('message_start', {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: options.requestedModel || options.targetModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: options.inputTokens,
            output_tokens: 0,
          },
        },
      }),
      options.signal,
    )
  }

  const ensureBlockStarted = async () => {
    await ensureMessageStarted()
    if (blockStarted) {
      return
    }
    blockStarted = true
    await writeResponseChunk(
      res,
      anthropicSseEvent('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'text',
          text: '',
        },
      }),
      options.signal,
    )
  }

  const writeTextDelta = async (text: string) => {
    if (!text) {
      return
    }
    await ensureBlockStarted()
    outputText += text
    await writeResponseChunk(
      res,
      anthropicSseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'text_delta',
          text,
        },
      }),
      options.signal,
    )
  }

  const stopBlock = async () => {
    if (!blockStarted || blockStopped) {
      return
    }
    blockStopped = true
    await writeResponseChunk(
      res,
      anthropicSseEvent('content_block_stop', {
        type: 'content_block_stop',
        index: 0,
      }),
      options.signal,
    )
  }

  const stopMessage = async () => {
    await ensureMessageStarted()
    await stopBlock()
    await writeResponseChunk(
      res,
      anthropicSseEvent('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
        usage: {
          output_tokens: outputTokens || estimateTokens(outputText),
        },
      }),
      options.signal,
    )
    await writeResponseChunk(
      res,
      anthropicSseEvent('message_stop', {
        type: 'message_stop',
      }),
      options.signal,
    )
  }

  const writeError = async (message: string) => {
    errorMessage = message || 'Codex upstream request failed'
    await writeResponseChunk(
      res,
      anthropicSseEvent('error', {
        type: 'error',
        error: {
          type: 'api_error',
          message: errorMessage,
        },
      }),
      options.signal,
    )
  }

  const handleEvent = async (event: JsonRecord) => {
    const type = typeof event.type === 'string' ? event.type : ''
    if (type === 'response.created') {
      const response = asRecord(event.response)
      await ensureMessageStarted(typeof response.id === 'string' ? response.id : messageId)
      return
    }

    if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
      await writeTextDelta(event.delta)
      return
    }

    if (type === 'response.output_text.done' && !outputText && typeof event.text === 'string') {
      await writeTextDelta(event.text)
      return
    }

    if (type === 'response.output_item.done' && !outputText) {
      const text = readCodexResponseText({ output: [asRecord(event.item)] })
      await writeTextDelta(text)
      return
    }

    if (type === 'response.content_part.done') {
      await stopBlock()
      return
    }

    if (type === 'response.completed') {
      const response = asRecord(event.response)
      const responseText = readCodexResponseText(response)
      if (!outputText && responseText) {
        await writeTextDelta(responseText)
      }
      const usage = readCodexUsage(response)
      outputTokens = usage.outputTokens || estimateTokens(outputText)
      status = 200
      success = true
      await stopMessage()
      return
    }

    if (type === 'response.failed' || type === 'error') {
      status = upstream.ok ? 400 : nonRetryCodexStatus(upstream.status)
      success = false
      await writeError(readCodexErrorMessage(event))
    }
  }

  for await (const chunk of streamBody(upstream)) {
    if (!sawFirstByte) {
      sawFirstByte = true
      firstByteMs = Date.now() - options.upstreamStartedAt
    }
    if (options.signal?.aborted) {
      throw options.signal.reason ?? clientClosedError()
    }
    const events = parser.feed(decoder.decode(chunk, { stream: true }))
    for (const event of events) {
      await handleEvent(event)
    }
  }

  for (const event of parser.feed(decoder.decode())) {
    await handleEvent(event)
  }
  for (const event of parser.finish()) {
    await handleEvent(event)
  }

  if (!sawFirstByte) {
    firstByteMs = options.fallbackFirstByteMs
  }
  if (!success && !errorMessage) {
    status = upstream.ok && outputText ? 200 : nonRetryCodexStatus(upstream.status)
    success = upstream.ok && Boolean(outputText)
    if (success) {
      outputTokens = outputTokens || estimateTokens(outputText)
      await stopMessage()
    } else {
      await writeError('Codex upstream stream ended before completion')
    }
  }

  return {
    status,
    success,
    outputTokens: outputTokens || estimateTokens(outputText),
    firstByteMs,
    errorMessage,
  }
}

function createSseDataRecordParser() {
  let buffer = ''
  let dataLines: string[] = []

  const flush = () => {
    if (!dataLines.length) {
      return []
    }
    const raw = dataLines.join('\n').trim()
    dataLines = []
    if (!raw || raw === '[DONE]') {
      return []
    }
    const json = safeJson(raw)
    return Object.keys(json).length ? [json] : []
  }

  const processLine = (line: string) => {
    if (!line.trim()) {
      return flush()
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
    return []
  }

  return {
    feed(text: string) {
      const records: JsonRecord[] = []
      buffer += text
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        records.push(...processLine(line))
      }
      return records
    },
    finish() {
      const records = buffer ? processLine(buffer) : []
      buffer = ''
      return [...records, ...flush()]
    },
  }
}

function readCodexErrorMessage(data: JsonRecord, rawText = '') {
  const error = asRecord(data.error)
  if (typeof error.message === 'string') {
    return error.message
  }

  for (const event of parseSseDataRecords(rawText)) {
    const eventError = asRecord(event.error)
    if (typeof eventError.message === 'string') {
      return eventError.message
    }
    const responseError = asRecord(asRecord(event.response).error)
    if (typeof responseError.message === 'string') {
      return responseError.message
    }
  }

  return rawText.trim() || 'Codex upstream request failed'
}

function codexErrorPayload(message: string, upstreamStatus: number): JsonRecord {
  return {
    error: {
      type: 'api_error',
      message,
      upstream_status: upstreamStatus,
    },
  }
}

function nonRetryCodexStatus(status: number) {
  if (status === 499 || status === 401 || status === 403) {
    return status
  }
  return 400
}

function prepareAnthropicSse(res: Response, status: number) {
  res.status(status)
  res.setHeader('content-type', 'text/event-stream; charset=utf-8')
  res.setHeader('cache-control', 'no-cache')
  res.setHeader('connection', 'keep-alive')
  res.flushHeaders()
}

async function readResponseText(response: globalThis.Response, startedAt: number, fallbackFirstByteMs: number, signal?: AbortSignal) {
  const decoder = new TextDecoder()
  let text = ''
  let firstByteMs = fallbackFirstByteMs
  let sawFirstByte = false

  for await (const chunk of streamBody(response)) {
    if (!sawFirstByte) {
      sawFirstByte = true
      firstByteMs = Date.now() - startedAt
    }
    if (signal?.aborted) {
      throw signal.reason ?? clientClosedError()
    }
    text += decoder.decode(chunk, { stream: true })
  }
  text += decoder.decode()

  return {
    text,
    firstByteMs,
  }
}

function linkAbortSignals(...signals: Array<AbortSignal | undefined>) {
  const controller = new AbortController()
  const abort = (signal: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(signal.reason ?? clientClosedError())
    }
  }
  const listeners = signals
    .filter((signal): signal is AbortSignal => Boolean(signal))
    .map((signal) => {
      const listener = () => abort(signal)
      if (signal.aborted) {
        abort(signal)
      } else {
        signal.addEventListener('abort', listener, { once: true })
      }
      return { signal, listener }
    })

  return {
    signal: controller.signal,
    cleanup: () => {
      for (const item of listeners) {
        item.signal.removeEventListener('abort', item.listener)
      }
    },
  }
}

function waitForRequestDelay(delayMs: number, signal?: AbortSignal) {
  if (!delayMs) {
    return Promise.resolve()
  }
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? clientClosedError())
  }

  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
    const timeout = setTimeout(() => {
      cleanup()
      resolve()
    }, delayMs)
    const onAbort = () => {
      cleanup()
      reject(signal?.reason ?? clientClosedError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function readCodexOutputForStats(outputText: string) {
  const data = safeJson(outputText)
  if (!Object.keys(data).length) {
    return outputText
  }

  const usage = asRecord(data.usage)
  const outputTokens = readNumber(usage.output_tokens) || readNumber(usage.completion_tokens)
  if (outputTokens > 0) {
    return ''.padStart(outputTokens * 4, 'x')
  }

  return data
}

function recordCodexRequest(input: {
  endpoint: string
  startedAt: number
  completedAt: number
  status: number
  success: boolean
  model: string
  targetModel: string
  inputTokens: number
  outputTokens: number
  upstreamMs: number
  firstByteMs: number
  apiKey: string
  error?: string
}) {
  const record: RequestRecordInput = {
    endpoint: input.endpoint,
    provider: 'codex',
    apiKey: input.apiKey,
    model: input.model,
    targetModel: input.targetModel,
    routeKey: 'codex',
    status: input.status,
    success: input.success,
    latencyMs: Math.max(0, input.completedAt - input.startedAt),
    queueMs: 0,
    upstreamMs: input.upstreamMs,
    firstByteMs: input.firstByteMs,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    error: input.error,
  }

  storage.enqueueRequest(record)
}

function readJsonBody(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
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

async function* streamBody(response: globalThis.Response): AsyncGenerator<Uint8Array> {
  if (!response.body) {
    return
  }

  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    yield chunk
  }
}

async function writeResponseChunk(res: Response, chunk: Uint8Array | string, signal?: AbortSignal) {
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

function canWriteResponse(res: Response) {
  return !res.destroyed && !res.writableEnded
}

function timeoutMs(config: AppConfig) {
  const timeout = Number(config.API_TIMEOUT_MS)
  return Number.isFinite(timeout) && timeout > 0 ? timeout : 600_000
}

function upstreamTimeoutError() {
  const error = new Error('Upstream request timed out') as Error & { status?: number }
  error.status = 504
  return error
}

function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number }
  error.status = status
  return error
}

function errorStatus(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) {
    return 499
  }
  const status = (error as { status?: unknown })?.status
  return typeof status === 'number' ? status : 502
}

function isClientClosed(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) {
    return true
  }
  return error instanceof Error && error.message === 'Client closed request'
}

function readableError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function safeJson(value: string): JsonRecord {
  try {
    return JSON.parse(value) as JsonRecord
  } catch {
    return {}
  }
}

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
