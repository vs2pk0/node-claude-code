<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { TableColumnsType } from 'ant-design-vue'
import { message } from 'ant-design-vue'
import { DeleteOutlined, DownloadOutlined, ReloadOutlined, SearchOutlined } from '@ant-design/icons-vue'
import type { Dayjs } from 'dayjs'
import { deleteRequestRecord, getRecentRequests } from '@/api'
import { isDesktopApp, saveDesktopExportFile } from '@/desktop'
import type { RequestRecord } from '@/types'
import { formatNumber, formatTime, readError } from '@/utils/format'
import { createTablePagination } from '@/utils/pagination'

type RangeKey = '24h' | '7d' | 'all' | 'custom'
type TrendMode = 'hour' | 'day'

interface TrendPoint {
  label: string
  timestamp: number
  requests: number
  tokens: number
  inputTokens: number
  outputTokens: number
}

interface CredentialStats {
  credential: string
  requests: number
  success: number
  failed: number
  totalTokens: number
  successRate: number
}

const records = ref<RequestRecord[]>([])
const loading = ref(false)
const range = ref<RangeKey>('24h')
const customRange = ref<[Dayjs, Dayjs] | null>(null)
const modelFilter = ref('all')
const credentialFilter = ref('all')
const trendMode = ref<TrendMode>('hour')
const lastUpdatedAt = ref('')
const tablePagination = createTablePagination(8)
const selectedRowKeys = ref<string[]>([])
const deletingRecordIds = ref<Set<string>>(new Set())

const detailColumns: TableColumnsType<RequestRecord> = [
  { title: '时间', dataIndex: 'createdAt', key: 'createdAt', width: 126 },
  { title: '模型', dataIndex: 'model', key: 'model', width: 126, ellipsis: true },
  { title: '执行账号', key: 'executionAccount', width: 146, ellipsis: true },
  { title: '来源', dataIndex: 'endpoint', key: 'endpoint', width: 128, ellipsis: true },
  { title: '认证索引', dataIndex: 'apiKey', key: 'apiKey', width: 150, ellipsis: true },
  { title: '结果', dataIndex: 'success', key: 'success', width: 76 },
  { title: '失败原因', dataIndex: 'error', key: 'error', width: 170, ellipsis: true },
  { title: '延迟', dataIndex: 'latencyMs', key: 'latencyMs', width: 86 },
  { title: '输入', dataIndex: 'inputTokens', key: 'inputTokens', width: 96 },
  { title: '输出', dataIndex: 'outputTokens', key: 'outputTokens', width: 96 },
  { title: '总量', dataIndex: 'totalTokens', key: 'totalTokens', width: 96 },
  { title: '操作', key: 'action', width: 70, fixed: 'right' },
]

const credentialColumns: TableColumnsType<CredentialStats> = [
  { title: '凭证', dataIndex: 'credential', key: 'credential', ellipsis: true },
  { title: '请求次数', dataIndex: 'requests', key: 'requests', width: 130 },
  { title: '成功率', dataIndex: 'successRate', key: 'successRate', width: 130 },
  { title: '总 Token', dataIndex: 'totalTokens', key: 'totalTokens', width: 140 },
]

const rangeOptions = [
  { label: '最近24小时', value: '24h' },
  { label: '最近7天', value: '7d' },
  { label: '自定义', value: 'custom' },
  { label: '全部', value: 'all' },
]

const codexRecords = computed(() => records.value.filter(isCodexUsageRecord))

const rangeStart = computed(() => {
  if (range.value === 'all') {
    return 0
  }
  if (range.value === 'custom') {
    return customRange.value?.[0]?.valueOf() ?? 0
  }
  const hours = range.value === '24h' ? 24 : 24 * 7
  return Date.now() - hours * 60 * 60 * 1000
})

const rangeEnd = computed(() => {
  if (range.value !== 'custom') {
    return 0
  }
  return customRange.value?.[1]?.valueOf() ?? 0
})

const rangedRecords = computed(() => {
  const start = rangeStart.value
  const end = rangeEnd.value
  return codexRecords.value.filter((record) => {
    const timestamp = new Date(record.createdAt).getTime()
    return (!start || timestamp >= start) && (!end || timestamp <= end)
  })
})

const modelOptions = computed(() => [
  { label: '全部', value: 'all' },
  ...unique(rangedRecords.value.map((record) => record.model)).map((model) => ({ label: model, value: model })),
])

const credentialOptions = computed(() => [
  { label: '全部', value: 'all' },
  ...unique(rangedRecords.value.map(executionAccount)).map((credential) => ({ label: credential, value: credential })),
])

const filteredRecords = computed(() => rangedRecords.value.filter((record) => {
  const credential = executionAccount(record)
  return (modelFilter.value === 'all' || record.model === modelFilter.value)
    && (credentialFilter.value === 'all' || credential === credentialFilter.value)
}))
const successfulFilteredRecords = computed(() => filteredRecords.value.filter((record) => record.success))

const totals = computed(() => {
  const success = filteredRecords.value.filter((record) => record.success).length
  const failed = filteredRecords.value.length - success
  const inputTokens = sum(successfulFilteredRecords.value, 'inputTokens')
  const outputTokens = sum(successfulFilteredRecords.value, 'outputTokens')
  const totalTokens = sum(successfulFilteredRecords.value, 'totalTokens')
  const avgLatencyMs = filteredRecords.value.length
    ? Math.round(sum(filteredRecords.value, 'latencyMs') / filteredRecords.value.length)
    : 0
  const minutes = Math.max(1, rangeDurationMs(filteredRecords.value) / 60_000)

  return {
    requests: filteredRecords.value.length,
    success,
    failed,
    inputTokens,
    outputTokens,
    totalTokens,
    avgLatencyMs,
    rpm: filteredRecords.value.length / minutes,
    tpm: totalTokens / minutes,
    successRate: filteredRecords.value.length ? Math.round((success / filteredRecords.value.length) * 1000) / 10 : 0,
  }
})

const trendPoints = computed(() => buildTrendPoints(filteredRecords.value, trendMode.value))
const requestPath = computed(() => sparklinePath(trendPoints.value.map((point) => point.requests)))
const tokenPath = computed(() => sparklinePath(trendPoints.value.map((point) => point.tokens)))
const inputTokenPath = computed(() => sparklinePath(trendPoints.value.map((point) => point.inputTokens)))
const outputTokenPath = computed(() => sparklinePath(trendPoints.value.map((point) => point.outputTokens)))
const exportRecords = computed(() => filteredRecords.value.map((record) => ({
  ...record,
  executionAccount: executionAccount(record),
})))
const selectedRecordCount = computed(() => selectedRowKeys.value.length)
const rowSelection = computed(() => ({
  selectedRowKeys: selectedRowKeys.value,
  onChange: (keys: Array<string | number>) => {
    selectedRowKeys.value = keys.map(String)
  },
}))

const credentialStats = computed(() => {
  const grouped = new Map<string, CredentialStats>()
  for (const record of filteredRecords.value) {
    const credential = executionAccount(record)
    const stat = grouped.get(credential) ?? {
      credential,
      requests: 0,
      success: 0,
      failed: 0,
      totalTokens: 0,
      successRate: 0,
    }
    stat.requests += 1
    stat.success += record.success ? 1 : 0
    stat.failed += record.success ? 0 : 1
    stat.totalTokens += record.success ? record.totalTokens : 0
    stat.successRate = stat.requests ? Math.round((stat.success / stat.requests) * 1000) / 10 : 0
    grouped.set(credential, stat)
  }
  return Array.from(grouped.values()).sort((left, right) => right.requests - left.requests)
})

onMounted(loadCodexUsageStats)

async function loadCodexUsageStats() {
  if (range.value === 'custom' && !customRange.value) {
    message.warning('请选择要查询的时间范围')
    return
  }
  loading.value = true
  try {
    records.value = await getRecentRequests(2000, requestRangeParams())
    selectedRowKeys.value = selectedRowKeys.value.filter((id) => records.value.some((record) => record.id === id))
    lastUpdatedAt.value = new Date().toISOString()
  } catch (error) {
    message.error(readError(error))
  } finally {
    loading.value = false
  }
}

function clearFilters() {
  modelFilter.value = 'all'
  credentialFilter.value = 'all'
}

async function deleteRecord(record: RequestRecord) {
  deletingRecordIds.value = new Set([...deletingRecordIds.value, record.id])
  try {
    await deleteRequestRecord(record.id)
    records.value = records.value.filter((item) => item.id !== record.id)
    selectedRowKeys.value = selectedRowKeys.value.filter((id) => id !== record.id)
    message.success('已删除这条请求记录')
  } catch (error) {
    message.error(readError(error))
  } finally {
    const next = new Set(deletingRecordIds.value)
    next.delete(record.id)
    deletingRecordIds.value = next
  }
}

async function deleteSelectedRecords() {
  const ids = [...selectedRowKeys.value]
  if (!ids.length) {
    return
  }

  loading.value = true
  try {
    await Promise.all(ids.map((id) => deleteRequestRecord(id)))
    const idSet = new Set(ids)
    records.value = records.value.filter((record) => !idSet.has(record.id))
    selectedRowKeys.value = []
    message.success(`已删除 ${ids.length} 条请求记录`)
  } catch (error) {
    message.error(readError(error))
  } finally {
    loading.value = false
  }
}

async function exportJson() {
  try {
    await exportText('codex-usage-stats.json', `${JSON.stringify(exportRecords.value, null, 2)}\n`, 'application/json')
  } catch (error) {
    message.error(readError(error))
  }
}

async function exportCsv() {
  const header = ['时间', '模型名称', '执行账号', '来源', '认证索引', '结果', '失败原因', '延迟', '输入Tokens', '输出Tokens', '总Token数']
  const lines = exportRecords.value.map((record) => [
    record.createdAt,
    record.model,
    record.executionAccount,
    record.endpoint,
    record.apiKey,
    record.success ? '成功' : '失败',
    record.error || '',
    record.latencyMs,
    record.inputTokens,
    record.outputTokens,
    record.totalTokens,
  ].map(csvCell).join(','))
  try {
    await exportText('codex-usage-stats.csv', `\ufeff${[header.join(','), ...lines].join('\n')}\n`, 'text/csv;charset=utf-8')
  } catch (error) {
    message.error(readError(error))
  }
}

function metricTokenSummary() {
  return `成功请求：输入 ${formatNumber(totals.value.inputTokens)} / 输出 ${formatNumber(totals.value.outputTokens)}`
}

function trendTicks() {
  if (!trendPoints.value.length) {
    return '暂无数据'
  }
  return `${trendPoints.value[0].label} - ${trendPoints.value[trendPoints.value.length - 1].label}`
}

function rowKey(record: RequestRecord) {
  return record.id
}

function credentialRowKey(record: CredentialStats) {
  return record.credential
}

function formatLatency(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}秒` : `${formatNumber(ms)}ms`
}

function formatDecimal(value: number) {
  return value >= 10 ? value.toFixed(0) : value.toFixed(2)
}

function rangeDurationMs(data: RequestRecord[]) {
  if (range.value === 'custom' && customRange.value) {
    return Math.max(60 * 1000, customRange.value[1].valueOf() - customRange.value[0].valueOf())
  }
  if (range.value === '24h') {
    return 24 * 60 * 60 * 1000
  }
  if (range.value === '7d') {
    return 7 * 24 * 60 * 60 * 1000
  }
  if (data.length <= 1) {
    return 60 * 60 * 1000
  }
  const times = data.map((record) => new Date(record.createdAt).getTime())
  return Math.max(60 * 1000, Math.max(...times) - Math.min(...times))
}

function requestRangeParams() {
  const start = rangeStart.value
  const end = rangeEnd.value
  return {
    start: start ? new Date(start).toISOString() : undefined,
    end: end ? new Date(end).toISOString() : undefined,
  }
}

function buildTrendPoints(data: RequestRecord[], mode: TrendMode): TrendPoint[] {
  const grouped = new Map<string, TrendPoint>()
  for (const record of data) {
    const date = new Date(record.createdAt)
    const bucket = new Date(date)
    if (mode === 'hour') {
      bucket.setMinutes(0, 0, 0)
    } else {
      bucket.setHours(0, 0, 0, 0)
    }
    const key = bucket.toISOString()
    const point = grouped.get(key) ?? {
      label: formatTrendLabel(bucket, mode),
      timestamp: bucket.getTime(),
      requests: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    }
    point.requests += 1
    point.tokens += record.success ? record.totalTokens : 0
    point.inputTokens += record.success ? record.inputTokens : 0
    point.outputTokens += record.success ? record.outputTokens : 0
    grouped.set(key, point)
  }
  return Array.from(grouped.values()).sort((left, right) => left.timestamp - right.timestamp)
}

function formatTrendLabel(date: Date, mode: TrendMode) {
  const day = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
  return mode === 'hour' ? `${day} ${date.getHours()}:00` : day
}

function sparklinePath(values: number[]) {
  if (!values.length) {
    return ''
  }
  const width = 560
  const height = 120
  const max = Math.max(...values, 1)
  return values.map((value, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * width
    const y = height - (value / max) * height
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`
  }).join(' ')
}

function sum(records: RequestRecord[], key: 'inputTokens' | 'outputTokens' | 'totalTokens' | 'latencyMs') {
  return records.reduce((total, record) => total + Number(record[key] || 0), 0)
}

function unique(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right))
}

function csvCell(value: unknown) {
  const text = String(value ?? '')
  return `"${text.replace(/"/g, '""')}"`
}

function executionAccount(record: RequestRecord) {
  if (record.provider === 'codex') {
    return record.apiKey || record.provider || '-'
  }
  return record.provider || record.apiKey || '-'
}

function isCodexUsageRecord(record: RequestRecord) {
  const endpoint = record.endpoint.toLowerCase()
  return record.provider === 'codex'
    || record.routeKey === 'codex'
    || endpoint.includes('/backend-api/codex')
    || endpoint.includes('/v1/responses')
}

async function exportText(fileName: string, content: string, type: string) {
  if (isDesktopApp()) {
    const savedPath = await saveDesktopExportFile(content, fileName)
    if (savedPath) {
      message.success(`已导出到 ${savedPath}`)
    }
    return
  }

  downloadText(fileName, content, type)
  message.success(`已导出 ${fileName}`)
}

function downloadText(fileName: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
</script>

<template>
  <section class="panel usage-panel">
    <div class="usage-page-head">
      <div>
        <h2>调用统计</h2>
        <p>聚合 Codex 代理请求、Codex 模型调用、Token、凭证与趋势数据。</p>
      </div>
      <div class="usage-actions">
        <span>时间范围</span>
        <a-select v-model:value="range" :options="rangeOptions" />
        <a-range-picker
          v-if="range === 'custom'"
          v-model:value="customRange"
          show-time
          format="YYYY/MM/DD HH:mm"
        />
        <a-button :loading="loading" @click="loadCodexUsageStats">
          <template #icon><SearchOutlined /></template>
          查询
        </a-button>
        <a-button @click="exportCsv">
          <template #icon><DownloadOutlined /></template>
          导出 CSV
        </a-button>
        <a-button @click="exportJson">
          <template #icon><DownloadOutlined /></template>
          导出 JSON
        </a-button>
        <a-button :loading="loading" @click="loadCodexUsageStats">
          <template #icon><ReloadOutlined /></template>
          刷新
        </a-button>
        <small>更新于：{{ lastUpdatedAt ? formatTime(lastUpdatedAt) : '-' }}</small>
      </div>
    </div>

    <div class="usage-metric-grid">
      <a-card class="usage-metric-card is-gray">
        <span>总请求数</span>
        <strong>{{ formatNumber(totals.requests) }}</strong>
        <small>
          成功 {{ formatNumber(totals.success) }} / 失败 {{ formatNumber(totals.failed) }} / 平均延迟 {{ formatLatency(totals.avgLatencyMs) }}
        </small>
      </a-card>
      <a-card class="usage-metric-card is-purple">
        <span>总 Token 数</span>
        <strong>{{ formatNumber(totals.totalTokens) }}</strong>
        <small>{{ metricTokenSummary() }}</small>
      </a-card>
      <a-card class="usage-metric-card is-green">
        <span>RPM</span>
        <strong>{{ formatDecimal(totals.rpm) }}</strong>
        <small>总请求数：{{ formatNumber(totals.requests) }}</small>
      </a-card>
      <a-card class="usage-metric-card is-orange">
        <span>TPM</span>
        <strong>{{ formatDecimal(totals.tpm) }}</strong>
        <small>总 Token 数：{{ formatNumber(totals.totalTokens) }}</small>
      </a-card>
      <a-card class="usage-metric-card is-gold">
        <span>成功率</span>
        <strong>{{ totals.successRate }}%</strong>
        <small>统计 Codex 代理请求与 Codex 模型调用</small>
      </a-card>
    </div>

    <div class="usage-chart-grid">
      <a-card class="usage-chart-card">
        <template #title>请求趋势</template>
        <template #extra>
          <a-segmented v-model:value="trendMode" :options="[{ label: '按小时', value: 'hour' }, { label: '按天', value: 'day' }]" />
        </template>
        <svg viewBox="0 0 560 140" preserveAspectRatio="none">
          <path class="chart-grid-line" d="M0 120 H560" />
          <path class="chart-line gray" :d="requestPath" />
        </svg>
        <small>{{ trendTicks() }}</small>
      </a-card>

      <a-card class="usage-chart-card">
        <template #title>Token 使用趋势</template>
        <template #extra>
          <a-segmented v-model:value="trendMode" :options="[{ label: '按小时', value: 'hour' }, { label: '按天', value: 'day' }]" />
        </template>
        <svg viewBox="0 0 560 140" preserveAspectRatio="none">
          <path class="chart-grid-line" d="M0 120 H560" />
          <path class="chart-line purple" :d="tokenPath" />
        </svg>
        <small>{{ trendTicks() }}</small>
      </a-card>
    </div>

    <a-card class="usage-chart-card">
      <template #title>Token 类型分布</template>
      <template #extra>
        <a-segmented v-model:value="trendMode" :options="[{ label: '按小时', value: 'hour' }, { label: '按天', value: 'day' }]" />
      </template>
      <div class="usage-legend">
        <span class="gray">输入 Tokens</span>
        <span class="green">输出 Tokens</span>
      </div>
      <svg viewBox="0 0 1120 180" preserveAspectRatio="none">
        <path class="chart-grid-line" d="M0 150 H1120" />
        <path class="chart-line gray" :d="inputTokenPath" transform="scale(2 1.25)" />
        <path class="chart-line green" :d="outputTokenPath" transform="scale(2 1.25)" />
      </svg>
    </a-card>

    <a-card class="usage-detail-card">
      <template #title>请求事件明细</template>
      <template #extra>
        <div class="usage-actions">
          <a-button type="link" @click="clearFilters">清空筛选</a-button>
          <a-popconfirm
            title="确定删除选中的请求记录？"
            ok-text="删除"
            cancel-text="取消"
            :disabled="!selectedRecordCount"
            @confirm="deleteSelectedRecords"
          >
            <a-button danger :disabled="!selectedRecordCount">
              <template #icon><DeleteOutlined /></template>
              删除选中 {{ selectedRecordCount ? `(${selectedRecordCount})` : '' }}
            </a-button>
          </a-popconfirm>
          <a-button @click="exportCsv">导出 CSV</a-button>
          <a-button @click="exportJson">导出 JSON</a-button>
        </div>
      </template>
      <div class="usage-filter-grid">
        <label>
          <span>模型</span>
          <a-select v-model:value="modelFilter" :options="modelOptions" />
        </label>
        <label>
          <span>执行账号</span>
          <a-select v-model:value="credentialFilter" :options="credentialOptions" />
        </label>
      </div>
      <p class="usage-count">{{ formatNumber(filteredRecords.length) }} 条事件</p>
      <a-table
        size="small"
        :columns="detailColumns"
        :data-source="filteredRecords"
        :loading="loading"
        :pagination="tablePagination"
        :scroll="{ x: 1260 }"
        :row-key="rowKey"
        :row-selection="rowSelection"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'createdAt'">{{ formatTime(record.createdAt) }}</template>
          <template v-else-if="column.key === 'executionAccount'">{{ executionAccount(record) }}</template>
          <template v-else-if="column.key === 'success'">
            <a-tag :color="record.success ? 'green' : 'red'">{{ record.success ? '成功' : '失败' }}</a-tag>
          </template>
          <template v-else-if="column.key === 'error'">{{ record.error || '-' }}</template>
          <template v-else-if="column.key === 'latencyMs'">{{ formatLatency(record.latencyMs) }}</template>
          <template v-else-if="column.key === 'inputTokens'">{{ formatNumber(record.inputTokens) }}</template>
          <template v-else-if="column.key === 'outputTokens'">{{ formatNumber(record.outputTokens) }}</template>
          <template v-else-if="column.key === 'totalTokens'">{{ formatNumber(record.totalTokens) }}</template>
          <template v-else-if="column.key === 'action'">
            <a-popconfirm title="确定删除这条记录？" ok-text="删除" cancel-text="取消" @confirm="deleteRecord(record)">
              <a-button size="small" danger :loading="deletingRecordIds.has(record.id)">
                <template #icon><DeleteOutlined /></template>
              </a-button>
            </a-popconfirm>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-card class="usage-detail-card">
      <template #title>凭证统计</template>
      <a-table
        size="middle"
        :columns="credentialColumns"
        :data-source="credentialStats"
        :pagination="false"
        :row-key="credentialRowKey"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'requests'">
            {{ formatNumber(record.requests) }} <span class="muted">({{ formatNumber(record.failed) }} 失败)</span>
          </template>
          <template v-else-if="column.key === 'successRate'">{{ record.successRate }}%</template>
          <template v-else-if="column.key === 'totalTokens'">{{ formatNumber(record.totalTokens) }}</template>
        </template>
      </a-table>
    </a-card>
  </section>
</template>
