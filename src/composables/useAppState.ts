import { computed, reactive, ref } from 'vue'
import type { UploadProps } from 'ant-design-vue'
import { message } from 'ant-design-vue'
import { exportConfig, getConfig, getHealth, getStatsSummary, importConfig, saveConfig, type HealthPayload } from '@/api'
import type { AppConfig, ProviderConfig, StatsSummary } from '@/types'
import { readError } from '@/utils/format'

export interface ProviderEditorState {
  modelsText: string
  transformerText: string
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
    draft.value?.Providers.flatMap((provider) =>
      provider.models.map((model) => ({
        label: `${provider.name},${model}`,
        value: `${provider.name},${model}`,
      })),
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

function syncProviderEditors() {
  providerEditors.value =
    draft.value?.Providers.map((provider) => ({
      modelsText: provider.models.join('\n'),
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
      return {
        ...provider,
        models: parseLines(editor?.modelsText ?? ''),
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
      models: parseLines(providerEditors.value[index]?.modelsText ?? ''),
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

function parseLines(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
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
    removeProvider,
    providerStatus,
  }
}
