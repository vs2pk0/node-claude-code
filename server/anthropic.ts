import { randomUUID } from 'node:crypto'

type JsonRecord = Record<string, unknown>

export function anthropicToOpenAi(body: JsonRecord, model: string): JsonRecord {
  const messages = normalizeAnthropicMessages(body)
  const payload: JsonRecord = {
    model,
    messages,
    stream: Boolean(body.stream),
  }

  if (typeof body.max_tokens === 'number') {
    payload.max_tokens = body.max_tokens
  }

  if (typeof body.temperature === 'number') {
    payload.temperature = body.temperature
  }

  if (typeof body.top_p === 'number') {
    payload.top_p = body.top_p
  }

  if (Array.isArray(body.stop_sequences)) {
    payload.stop = body.stop_sequences
  }

  if (Array.isArray(body.tools)) {
    payload.tools = body.tools.map((tool) => anthropicToolToOpenAi(tool)).filter(Boolean)
  }

  const toolChoice = anthropicToolChoiceToOpenAi(body.tool_choice)
  if (toolChoice) {
    payload.tool_choice = toolChoice
  }

  return payload
}

export function openAiToAnthropic(data: JsonRecord, requestModel: string, fallbackModel: string): JsonRecord {
  const choice = readFirstChoice(data)
  const message = asRecord(choice?.message)
  const content = openAiMessageToAnthropicContent(message)
  const usage = asRecord(data.usage)
  const inputTokens = readNumber(usage.prompt_tokens)
  const outputTokens = readNumber(usage.completion_tokens)

  return {
    id: String(data.id ?? `msg_${randomUUID().replaceAll('-', '')}`),
    type: 'message',
    role: 'assistant',
    model: requestModel || fallbackModel,
    content: content.length ? content : [{ type: 'text', text: '' }],
    stop_reason: mapFinishReason(choice?.finish_reason, content),
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  }
}

export function anthropicSseEvent(event: string, data: JsonRecord): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export function openAiToolCallsToAnthropic(toolCalls: unknown): JsonRecord[] {
  if (!Array.isArray(toolCalls)) {
    return []
  }

  return toolCalls.map((toolCall) => {
    const record = asRecord(toolCall)
    const fn = asRecord(record.function)
    return {
      type: 'tool_use',
      id: String(record.id ?? `toolu_${randomUUID().replaceAll('-', '')}`),
      name: String(fn.name ?? 'tool'),
      input: parseToolArguments(fn.arguments),
    }
  })
}

export function extractOpenAiContent(message: unknown): string {
  const record = asRecord(message)
  const content = record.content
  if (typeof content === 'string') {
    return content
  }
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        const part = asRecord(item)
        return typeof part.text === 'string' ? part.text : ''
      })
      .join('')
  }
  return ''
}

function normalizeAnthropicMessages(body: JsonRecord): JsonRecord[] {
  const messages: JsonRecord[] = []

  const system = normalizeSystem(body.system)
  if (system) {
    messages.push({
      role: 'system',
      content: system,
    })
  }

  const inputMessages = Array.isArray(body.messages) ? body.messages : []
  for (const rawMessage of inputMessages) {
    const message = asRecord(rawMessage)
    const role = message.role === 'assistant' ? 'assistant' : 'user'

    if (typeof message.content === 'string') {
      messages.push({
        role,
        content: message.content,
      })
      continue
    }

    if (!Array.isArray(message.content)) {
      messages.push({
        role,
        content: '',
      })
      continue
    }

    if (role === 'assistant') {
      messages.push(buildAssistantMessage(message.content))
      continue
    }

    messages.push(...buildUserAndToolMessages(message.content))
  }

  return messages
}

function buildAssistantMessage(blocks: unknown[]): JsonRecord {
  const text: string[] = []
  const toolCalls: JsonRecord[] = []

  for (const blockValue of blocks) {
    const block = asRecord(blockValue)
    if (block.type === 'text' && typeof block.text === 'string') {
      text.push(block.text)
    }

    if (block.type === 'tool_use') {
      toolCalls.push({
        id: String(block.id ?? `toolu_${randomUUID().replaceAll('-', '')}`),
        type: 'function',
        function: {
          name: String(block.name ?? 'tool'),
          arguments: JSON.stringify(block.input ?? {}),
        },
      })
    }
  }

  const message: JsonRecord = {
    role: 'assistant',
    content: text.join('') || null,
  }

  if (toolCalls.length) {
    message.tool_calls = toolCalls
  }

  return message
}

function buildUserAndToolMessages(blocks: unknown[]): JsonRecord[] {
  const messages: JsonRecord[] = []
  const userParts: JsonRecord[] = []

  const flushUser = () => {
    if (!userParts.length) {
      return
    }

    const textOnly = userParts.every((part) => part.type === 'text')
    messages.push({
      role: 'user',
      content: textOnly ? userParts.map((part) => part.text).join('') : [...userParts],
    })
    userParts.length = 0
  }

  for (const blockValue of blocks) {
    const block = asRecord(blockValue)

    if (block.type === 'tool_result') {
      flushUser()
      messages.push({
        role: 'tool',
        tool_call_id: String(block.tool_use_id ?? ''),
        content: normalizeToolResultContent(block.content),
      })
      continue
    }

    if (block.type === 'image') {
      const source = asRecord(block.source)
      userParts.push({
        type: 'image_url',
        image_url: {
          url: imageSourceToDataUrl(source),
        },
      })
      continue
    }

    if (block.type === 'text' && typeof block.text === 'string') {
      userParts.push({
        type: 'text',
        text: block.text,
      })
    }
  }

  flushUser()
  return messages
}

function openAiMessageToAnthropicContent(message: JsonRecord): JsonRecord[] {
  const content: JsonRecord[] = []
  const text = extractOpenAiContent(message)
  if (text) {
    content.push({
      type: 'text',
      text,
    })
  }

  content.push(...openAiToolCallsToAnthropic(message.tool_calls))
  return content
}

function anthropicToolToOpenAi(value: unknown): JsonRecord | undefined {
  const tool = asRecord(value)
  const name = tool.name
  if (typeof name !== 'string') {
    return undefined
  }

  return {
    type: 'function',
    function: {
      name,
      description: typeof tool.description === 'string' ? tool.description : '',
      parameters: tool.input_schema ?? {
        type: 'object',
        properties: {},
      },
    },
  }
}

function anthropicToolChoiceToOpenAi(value: unknown): unknown {
  const choice = asRecord(value)
  if (!choice.type) {
    return undefined
  }

  if (choice.type === 'auto') {
    return 'auto'
  }

  if (choice.type === 'none') {
    return 'none'
  }

  if (choice.type === 'any') {
    return 'required'
  }

  if (choice.type === 'tool' && typeof choice.name === 'string') {
    return {
      type: 'function',
      function: {
        name: choice.name,
      },
    }
  }

  return undefined
}

function normalizeSystem(system: unknown): string {
  if (typeof system === 'string') {
    return system
  }

  if (!Array.isArray(system)) {
    return ''
  }

  return system
    .map((part) => {
      const record = asRecord(part)
      return typeof record.text === 'string' ? record.text : ''
    })
    .filter(Boolean)
    .join('\n')
}

function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return JSON.stringify(content ?? '')
  }

  return content
    .map((part) => {
      const record = asRecord(part)
      if (typeof record.text === 'string') {
        return record.text
      }
      return JSON.stringify(record)
    })
    .join('\n')
}

function imageSourceToDataUrl(source: JsonRecord): string {
  if (typeof source.url === 'string') {
    return source.url
  }

  const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/png'
  const data = typeof source.data === 'string' ? source.data : ''
  return `data:${mediaType};base64,${data}`
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== 'string') {
    return {}
  }

  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function mapFinishReason(reason: unknown, content: JsonRecord[]) {
  if (content.some((part) => part.type === 'tool_use')) {
    return 'tool_use'
  }

  if (reason === 'length') {
    return 'max_tokens'
  }

  return 'end_turn'
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
