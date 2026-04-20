import { computed, reactive, ref } from 'vue'
import type { UploadProps } from 'ant-design-vue'
import { message } from 'ant-design-vue'
import { exportConfig, getConfig, getHealth, getStatsSummary, importConfig, saveConfig, type HealthPayload } from '@/api'
import type { AppConfig, ProviderConfig, StatsSummary } from '@/types'
import { readError } from '@/utils/format'

export interface ProviderEditorState {
  models: ProviderModelEditorState[]
  transformerText: string
}

export interface ProviderModelEditorState {
  model: string
  alias: string
}

const draft = ref<AppConfig>()
const health = ref<HealthPayload>()
const summary = ref<StatsSummary>()
const providerEditors = ref<ProviderEditorState[]>([])
const loading = reactive({
  config: false,
  stats: false,
  saving: false,
  importing: false,
})

let initialized = false
let statsTimer: number | undefined

const routeOptions = computed(() => {
  return (
    draft.value?.Providers.flatMap((provider, index) =>
      readEditableModelRows(provider, index).map(({ model, alias }) => {
        return {
          label: alias && alias !== model ? `${provider.name},${alias} (${model})` : `${provider.name},${model}`,
          value: `${provider.name},${model}`,
        }
      }),
    ) ?? []
  )
})

const originUrl = computed(() => {
  const config = draft.value
  if (!config) {
    return ''
  }

  const runtime = health.value?.runtime
  return `http://${runtime?.host || config.HOST}:${runtime?.port || config.PORT}`
})

const uiUrl = computed(() => (originUrl.value ? `${originUrl.value}/ui` : ''))

const jsonPreview = computed(() => {
  return JSON.stringify(previewDraft(), null, 2)
})

const successRate = computed(() => {
  const totals = summary.value?.totals
  if (!totals?.requests) {
    return 0
  }
  return Math.round((totals.success / totals.requests) * 100)
})

async function initializeApp() {
  if (initialized) {
    return
  }

  initialized = true
  await refreshAll()
  startStatsPolling()
}

function startStatsPolling() {
  if (statsTimer) {
    return
  }
  statsTimer = window.setInterval(loadStats, 15000)
}

function stopStatsPolling() {
  if (!statsTimer) {
    return
  }
  window.clearInterval(statsTimer)
  statsTimer = undefined
}

async function refreshAll() {
  await Promise.all([loadConfig(), loadStats(), loadHealth()])
}

async function loadConfig() {
  loading.config = true
  try {
    draft.value = await getConfig()
    syncProviderEditors()
  } catch (error) {
    message.error(readError(error))
  } finally {
    loading.config = false
  }
}

async function loadHealth() {
  try {
    health.value = await getHealth()
  } catch (error) {
    message.error(readError(error))
  }
}

async function loadStats() {
  loading.stats = true
  try {
    summary.value = await getStatsSummary()
  } catch (error) {
    message.error(readError(error))
  } finally {
    loading.stats = false
  }
}

async function persistConfig() {
  if (!draft.value) {
    return
  }

  const materialized = materializeDraft()
  if (!materialized) {
    return
  }

  loading.saving = true
  try {
    draft.value = await saveConfig(materialized)
    syncProviderEditors()
    message.success('已保存')
  } catch (error) {
    message.error(readError(error))
  } finally {
    loading.saving = false
  }
}

async function downloadSettings() {
  try {
    const blob = await exportConfig()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'settings.json'
    link.click()
    URL.revokeObjectURL(url)
  } catch (error) {
    message.error(readError(error))
  }
}

const beforeImport: UploadProps['beforeUpload'] = async (file) => {
  loading.importing = true
  try {
    const text = await file.text()
    const payload = JSON.parse(text) as AppConfig
    draft.value = await importConfig(payload)
    syncProviderEditors()
    await loadStats()
    message.success('已导入')
  } catch (error) {
    message.error(readError(error))
  } finally {
    loading.importing = false
  }

  return false
}

function addProvider() {
  if (!draft.value) {
    return
  }

  draft.value.Providers.push({
    name: `provider-${draft.value.Providers.length + 1}`,
    api_base_url: '',
    api_key: '',
    models: ['model-name'],
    model_aliases: {},
    transformer: {
      use: [
        [
          'maxtoken',
          {
            max_tokens: 65536,
          },
        ],
      ],
    },
  })
  syncProviderEditors()
}

function importProviderFromCurl(curlText: string) {
  if (!draft.value) {
    throw new Error('配置尚未加载')
  }

  const parsed = parseCurlProvider(curlText)
  const provider: ProviderConfig = {
    name: uniqueProviderName(parsed.name),
    api_base_url: parsed.apiBaseUrl,
    api_key: parsed.apiKey,
    models: [parsed.model],
    model_aliases: {},
    transformer: {
      use: [
        [
          'maxtoken',
          {
            max_tokens: 65536,
          },
        ],
      ],
    },
  }

  draft.value.Providers.push(provider)
  syncProviderEditors()
  return provider
}

function copyProvider(index: number) {
  if (!draft.value) {
    throw new Error('配置尚未加载')
  }

  const provider = draft.value.Providers[index]
  const editor = providerEditors.value[index]
  if (!provider || !editor) {
    throw new Error('Provider 不存在')
  }

  const modelEntries = materializeModelRows(editor.models)
  const copiedProvider: ProviderConfig = {
    ...deepClone(provider),
    name: `${provider.name || `provider-${index + 1}`}-${formatTimestamp(new Date())}`,
    models: modelEntries.models,
    model_aliases: modelEntries.aliases,
    transformer: parseTransformer(editor.transformerText),
  }

  draft.value.Providers.splice(index + 1, 0, copiedProvider)
  syncProviderEditors()
  return copiedProvider
}

function addProviderModel(providerIndex: number) {
  providerEditors.value[providerIndex]?.models.push(createModelEditorRow())
}

function removeProviderModel(providerIndex: number, modelIndex: number) {
  const editor = providerEditors.value[providerIndex]
  if (!editor) {
    return
  }

  if (editor.models.length <= 1) {
    editor.models = [createModelEditorRow()]
    return
  }

  editor.models.splice(modelIndex, 1)
}

function removeProvider(index: number) {
  draft.value?.Providers.splice(index, 1)
  syncProviderEditors()
}

function providerStatus(provider: ProviderConfig) {
  if (!provider.api_base_url) {
    return '未配置'
  }
  return provider.api_key ? '就绪' : '缺少 Key'
}

function resolveModelAlias(providerName: string, model: string) {
  const targetModel = model.trim()
  if (!targetModel) {
    return model
  }

  const providers = draft.value?.Providers ?? []
  const exactProviderIndex = providers.findIndex((provider) => provider.name === providerName)
  if (exactProviderIndex >= 0) {
    const alias = readEditableModelAlias(providers[exactProviderIndex], exactProviderIndex, targetModel)
    if (alias) {
      return alias
    }
  }

  for (let index = 0; index < providers.length; index += 1) {
    const alias = readEditableModelAlias(providers[index], index, targetModel)
    if (alias) {
      return alias
    }
  }

  return model
}

function resolveProviderName(providerName: string, model = '') {
  const providers = draft.value?.Providers ?? []
  const exactProvider = providers.find((provider) => provider.name === providerName)
  if (exactProvider) {
    return exactProvider.name
  }

  if (model.trim()) {
    const modelOwner = providers.find((provider, index) =>
      readEditableModelRows(provider, index).some((row) => row.model === model.trim()),
    )
    if (modelOwner?.name) {
      return modelOwner.name
    }
  }

  return providerName
}

function syncProviderEditors() {
  providerEditors.value =
    draft.value?.Providers.map((provider) => ({
      models: createModelEditorRows(provider),
      transformerText: JSON.stringify(provider.transformer ?? {}, null, 2),
    })) ?? []
}

function materializeDraft(): AppConfig | undefined {
  if (!draft.value) {
    return undefined
  }

  try {
    draft.value.Providers = draft.value.Providers.map((provider, index) => {
      const editor = providerEditors.value[index]
      const modelEntries = materializeModelRows(editor?.models ?? [])
      return {
        ...provider,
        models: modelEntries.models,
        model_aliases: modelEntries.aliases,
        transformer: parseTransformer(editor?.transformerText ?? ''),
      }
    })

    return JSON.parse(JSON.stringify(draft.value)) as AppConfig
  } catch (error) {
    message.error(readError(error))
    return undefined
  }
}

function previewDraft() {
  if (!draft.value) {
    return {}
  }

  return {
    ...draft.value,
    Providers: draft.value.Providers.map((provider, index) => ({
      ...provider,
      ...safePreviewModelPayload(providerEditors.value[index]?.models ?? []),
      transformer: safePreviewTransformer(providerEditors.value[index]?.transformerText ?? ''),
    })),
  }
}

function parseTransformer(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) {
    return undefined
  }

  const parsed = JSON.parse(text) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Transformer 必须是 JSON 对象')
  }

  return parsed as Record<string, unknown>
}

function safePreviewTransformer(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) {
    return undefined
  }

  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function materializeModelRows(rows: ProviderModelEditorState[]) {
  const models: string[] = []
  const aliases: Record<string, string> = {}
  const usedModels = new Set<string>()

  for (const row of rows) {
    const model = row.model.trim()
    const alias = row.alias.trim()
    if (!model && !alias) {
      continue
    }

    if (!model) {
      throw new Error('Models 中存在只有别名没有真实模型的行')
    }

    if (usedModels.has(model)) {
      throw new Error(`Models 存在重复模型：${model}`)
    }

    usedModels.add(model)
    models.push(model)
    if (alias) {
      aliases[model] = alias
    }
  }

  return {
    models,
    aliases: Object.keys(aliases).length ? aliases : undefined,
  }
}

function safePreviewModelPayload(rows: ProviderModelEditorState[]) {
  try {
    const entries = materializeModelRows(rows)
    return {
      models: entries.models,
      model_aliases: entries.aliases,
    }
  } catch {
    return {
      models: rows.map((row) => row.model.trim()).filter(Boolean),
      model_aliases: {},
    }
  }
}

function createModelEditorRows(provider: ProviderConfig) {
  const rows = provider.models.map((model) => createModelEditorRow(model, readModelAlias(provider, model)))
  return rows.length ? rows : [createModelEditorRow()]
}

function readEditableModelRows(provider: ProviderConfig, providerIndex: number) {
  const editor = providerEditors.value[providerIndex]
  if (!editor) {
    return provider.models.map((model) => ({
      model,
      alias: readModelAlias(provider, model),
    }))
  }

  return editor.models
    .map((row) => ({
      model: row.model.trim(),
      alias: row.alias.trim(),
    }))
    .filter((row) => row.model)
}

function readEditableModelAlias(provider: ProviderConfig, providerIndex: number, model: string) {
  const editorAlias = readEditableModelRows(provider, providerIndex).find((row) => row.model === model)?.alias
  if (editorAlias) {
    return editorAlias
  }

  return readModelAlias(provider, model)
}

function createModelEditorRow(model = '', alias = ''): ProviderModelEditorState {
  return {
    model,
    alias,
  }
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function formatTimestamp(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

function readModelAlias(provider: ProviderConfig, model: string) {
  const aliases = provider.model_aliases
  const alias = aliases?.[model]
  return typeof alias === 'string' && alias.trim() ? alias.trim() : ''
}

function parseCurlProvider(curlText: string) {
  const tokens = tokenizeCurl(curlText)
  if (!tokens.length || tokens[0] !== 'curl') {
    throw new Error('请输入完整的 curl 命令')
  }

  let apiBaseUrl = ''
  let apiKey = ''
  let data = ''

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    const next = tokens[index + 1] ?? ''

    if (token === '--url') {
      apiBaseUrl = next
      index += 1
      continue
    }

    if (token.startsWith('--url=')) {
      apiBaseUrl = token.slice('--url='.length)
      continue
    }

    if (token === '--header' || token === '-H') {
      apiKey = extractBearerKey(next) || apiKey
      index += 1
      continue
    }

    if (token.startsWith('--header=')) {
      apiKey = extractBearerKey(token.slice('--header='.length)) || apiKey
      continue
    }

    if (token === '--data' || token === '--data-raw' || token === '--data-binary' || token === '--data-ascii' || token === '-d') {
      data = next
      index += 1
      continue
    }

    const dataPrefix = ['--data=', '--data-raw=', '--data-binary=', '--data-ascii=', '-d='].find((prefix) =>
      token.startsWith(prefix),
    )
    if (dataPrefix) {
      data = token.slice(dataPrefix.length)
      continue
    }

    if (!apiBaseUrl && /^https?:\/\//i.test(token)) {
      apiBaseUrl = token
    }
  }

  if (!apiBaseUrl) {
    throw new Error('未解析到 API Base URL')
  }

  if (!apiKey) {
    throw new Error('未解析到 Authorization Bearer')
  }

  const payload = parseCurlJsonPayload(data)
  const model = typeof payload.model === 'string' ? payload.model.trim() : ''
  if (!model) {
    throw new Error('未解析到请求体中的 model')
  }

  return {
    name: providerNameFromUrl(apiBaseUrl),
    apiBaseUrl,
    apiKey,
    model,
  }
}

function tokenizeCurl(input: string) {
  const normalized = input.replace(/\\\r?\n\s*/g, ' ').trim()
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    const next = normalized[index + 1]

    if (quote === "'") {
      if (char === "'") {
        quote = undefined
      } else {
        current += char
      }
      continue
    }

    if (quote === '"') {
      if (char === '"') {
        quote = undefined
      } else if (char === '\\' && next) {
        current += next
        index += 1
      } else {
        current += char
      }
      continue
    }

    if (char === "'" || char === '"') {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    if (char === '\\' && next) {
      current += next
      index += 1
      continue
    }

    current += char
  }

  if (quote) {
    throw new Error('curl 命令中存在未闭合的引号')
  }

  if (current) {
    tokens.push(current)
  }

  return tokens
}

function extractBearerKey(header: string) {
  const match = header.match(/^authorization\s*:\s*bearer\s+(.+)$/i)
  return match?.[1]?.trim() ?? ''
}

function parseCurlJsonPayload(data: string) {
  if (!data.trim()) {
    throw new Error('未解析到 JSON 请求体')
  }

  const candidates = [data.trim()]
  if (data.includes('\\"')) {
    candidates.push(data.replace(/\\"/g, '"').trim())
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // Try the next normalized candidate.
    }
  }

  throw new Error('请求体不是有效的 JSON')
}

function providerNameFromUrl(value: string) {
  try {
    const hostname = new URL(value).hostname.toLowerCase()
    const parts = hostname
      .split('.')
      .filter((part) => part && !['api', 'openapi', 'gateway', 'www'].includes(part))
    const name = parts.length >= 2 ? parts[parts.length - 2] : parts[0] || 'provider'
    return sanitizeProviderName(name)
  } catch {
    return 'provider'
  }
}

function sanitizeProviderName(name: string) {
  return name
    .replace(/[^a-z0-9-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    || 'provider'
}

function uniqueProviderName(baseName: string) {
  const existing = new Set(draft.value?.Providers.map((provider) => provider.name) ?? [])
  if (!existing.has(baseName)) {
    return baseName
  }

  let index = 2
  while (existing.has(`${baseName}-${index}`)) {
    index += 1
  }
  return `${baseName}-${index}`
}

export function useAppState() {
  return {
    draft,
    health,
    summary,
    providerEditors,
    loading,
    routeOptions,
    originUrl,
    uiUrl,
    jsonPreview,
    successRate,
    initializeApp,
    stopStatsPolling,
    refreshAll,
    loadConfig,
    loadStats,
    loadHealth,
    persistConfig,
    downloadSettings,
    beforeImport,
    addProvider,
    importProviderFromCurl,
    copyProvider,
    addProviderModel,
    removeProviderModel,
    removeProvider,
    providerStatus,
    resolveModelAlias,
    resolveProviderName,
  }
}
