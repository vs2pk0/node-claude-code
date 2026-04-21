import { performance } from 'node:perf_hooks'

type Protocol = 'anthropic-messages' | 'openai-chat'

interface CaseSpec {
  name: string
  url: string
  protocol: Protocol
  model: string
  apiKey?: string
}

interface RunResult {
  name: string
  status: number
  ok: boolean
  headersMs: number
  firstByteMs: number
  totalMs: number
  bytes: number
}

const env = process.env

async function main() {
  const cases = readCases()
  if (!cases.length) {
    printUsage()
    process.exitCode = 1
    return
  }

  const iterations = readPositiveInt(env.BENCH_ITERATIONS, 3)
  const concurrency = readPositiveInt(env.BENCH_CONCURRENCY, 1)
  const plan = buildRunPlan(cases, iterations)
  const results: RunResult[] = []

  console.log(`Running ${cases.length} case(s), ${iterations} iteration(s), concurrency ${concurrency}, order interleaved`)
  for (let batchStart = 0; batchStart < plan.length; batchStart += concurrency) {
    const batch = plan.slice(batchStart, batchStart + concurrency)
    results.push(...await Promise.all(batch.map((item) => runOnce(item.spec, item.iteration))))
  }

  console.table(results.map((result) => ({
    case: result.name,
    status: result.status,
    ok: result.ok,
    headers_ms: Math.round(result.headersMs),
    first_byte_ms: Math.round(result.firstByteMs),
    total_ms: Math.round(result.totalMs),
    bytes: result.bytes,
  })))

  console.table(summarize(results))
}

function buildRunPlan(cases: CaseSpec[], iterations: number) {
  const plan: Array<{ spec: CaseSpec; iteration: number }> = []
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    for (const spec of cases) {
      plan.push({ spec, iteration })
    }
  }
  return plan
}

function readCases() {
  const customCases = readCustomCases()
  if (customCases.length) {
    return customCases
  }

  const routerBase = trimSlash(env.BENCH_ROUTER_URL || 'http://127.0.0.1:4568')
  const routerApiKey = env.BENCH_ROUTER_API_KEY || env.ANTHROPIC_AUTH_TOKEN || ''
  const cases: CaseSpec[] = []

  if (env.BENCH_DIRECT_URL && env.BENCH_DIRECT_MODEL) {
    const directProtocol = normalizeProtocol(env.BENCH_DIRECT_PROTOCOL, env.BENCH_DIRECT_URL)
    cases.push({
      name: env.BENCH_DIRECT_NAME || 'direct-upstream',
      url: resolveBenchmarkUrl(env.BENCH_DIRECT_URL, directProtocol),
      protocol: directProtocol,
      model: env.BENCH_DIRECT_MODEL,
      apiKey: env.BENCH_DIRECT_API_KEY,
    })
  }

  if (env.BENCH_ROUTER_FORWARD_MODEL) {
    cases.push({
      name: env.BENCH_ROUTER_FORWARD_NAME || 'router-direct-forward',
      url: `${routerBase}/v1/messages`,
      protocol: 'anthropic-messages',
      model: env.BENCH_ROUTER_FORWARD_MODEL,
      apiKey: routerApiKey,
    })
  }

  if (env.BENCH_ROUTER_CONVERT_MODEL) {
    cases.push({
      name: env.BENCH_ROUTER_CONVERT_NAME || 'router-openai-to-anthropic',
      url: `${routerBase}/v1/messages`,
      protocol: 'anthropic-messages',
      model: env.BENCH_ROUTER_CONVERT_MODEL,
      apiKey: routerApiKey,
    })
  }

  return cases
}

function readCustomCases() {
  if (!env.BENCH_CASES) {
    return []
  }

  const rawCases = JSON.parse(env.BENCH_CASES) as Array<Partial<CaseSpec>>
  return rawCases.map((item, index) => {
    if (!item.url || !item.model) {
      throw new Error(`BENCH_CASES[${index}] requires url and model`)
    }

    return {
      name: item.name || `case-${index + 1}`,
      url: item.url,
      model: item.model,
      protocol: normalizeProtocol(item.protocol, item.url),
      apiKey: item.apiKey,
    }
  })
}

async function runOnce(spec: CaseSpec, iteration: number): Promise<RunResult> {
  const startedAt = performance.now()
  const response = await fetch(spec.url, {
    method: 'POST',
    headers: buildHeaders(spec),
    body: JSON.stringify(buildBody(spec)),
  })
  const headersAt = performance.now()
  let firstByteMs = 0
  let bytes = 0

  if (response.body) {
    const reader = response.body.getReader()
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) {
        break
      }

      if (!firstByteMs) {
        firstByteMs = performance.now() - startedAt
      }
      bytes += chunk.value.byteLength
    }
  } else {
    const buffer = await response.arrayBuffer()
    bytes = buffer.byteLength
  }

  const totalMs = performance.now() - startedAt
  return {
    name: `${spec.name}#${iteration}`,
    status: response.status,
    ok: response.ok,
    headersMs: headersAt - startedAt,
    firstByteMs: firstByteMs || totalMs,
    totalMs,
    bytes,
  }
}

function buildHeaders(spec: CaseSpec) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }

  if (spec.protocol === 'anthropic-messages') {
    headers['anthropic-version'] = env.BENCH_ANTHROPIC_VERSION || '2023-06-01'
    if (spec.apiKey) {
      headers.authorization = `Bearer ${spec.apiKey}`
      headers['x-api-key'] = spec.apiKey
    }
  } else if (spec.apiKey) {
    headers.authorization = `Bearer ${spec.apiKey}`
  }

  return headers
}

function buildBody(spec: CaseSpec) {
  const stream = env.BENCH_STREAM !== 'false'
  const prompt = env.BENCH_PROMPT || 'Please reply with one short sentence: ping.'
  const maxTokens = readPositiveInt(env.BENCH_MAX_TOKENS, 256)
  const messages = [{ role: 'user', content: prompt }]

  if (spec.protocol === 'anthropic-messages') {
    return {
      model: spec.model,
      max_tokens: maxTokens,
      stream,
      messages,
    }
  }

  return {
    model: spec.model,
    max_tokens: maxTokens,
    stream,
    messages,
  }
}

function summarize(results: RunResult[]) {
  const byCase = new Map<string, RunResult[]>()
  for (const result of results) {
    const caseName = result.name.replace(/#\d+$/, '')
    byCase.set(caseName, [...(byCase.get(caseName) ?? []), result])
  }

  return [...byCase.entries()].map(([name, items]) => ({
    case: name,
    runs: items.length,
    success: items.filter((item) => item.ok).length,
    first_byte_avg_ms: average(items.map((item) => item.firstByteMs)),
    first_byte_p95_ms: percentile(items.map((item) => item.firstByteMs), 0.95),
    total_avg_ms: average(items.map((item) => item.totalMs)),
    total_p95_ms: percentile(items.map((item) => item.totalMs), 0.95),
    bytes_avg: Math.round(average(items.map((item) => item.bytes))),
  }))
}

function average(values: number[]) {
  if (!values.length) {
    return 0
  }

  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
}

function percentile(values: number[], ratio: number) {
  if (!values.length) {
    return 0
  }

  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  return Math.round(sorted[index])
}

function readPositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function normalizeProtocol(value: unknown, url: string): Protocol {
  if (value === 'openai-chat' || value === 'openai') {
    return 'openai-chat'
  }
  if (value === 'anthropic-messages' || value === 'anthropic' || value === 'claude-code') {
    return 'anthropic-messages'
  }
  return url.includes('/messages') ? 'anthropic-messages' : 'openai-chat'
}

function resolveBenchmarkUrl(apiBaseUrl: string, protocol: Protocol) {
  if (protocol !== 'anthropic-messages') {
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

function trimSlash(value: string) {
  return value.replace(/\/+$/, '')
}

function printUsage() {
  console.log(`
No benchmark cases configured.

Example:
  BENCH_ROUTER_API_KEY=local-router-token \\
  BENCH_ROUTER_FORWARD_MODEL=claude-opus-4-7 \\
  BENCH_ROUTER_CONVERT_MODEL=claude-sonnet-4-6 \\
  BENCH_DIRECT_URL=https://example.com/v1/messages \\
  BENCH_DIRECT_MODEL=claude-opus-4-7 \\
  BENCH_DIRECT_API_KEY=sk-xxx \\
  npm run bench:latency

Advanced:
  BENCH_CASES='[{"name":"router","url":"http://127.0.0.1:4568/v1/messages","protocol":"anthropic-messages","model":"claude-sonnet-4-6","apiKey":"local-router-token"}]' npm run bench:latency
`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
