<script setup lang="ts">
import type { TableColumnsType } from 'ant-design-vue'
import { message } from 'ant-design-vue'
import { DeleteOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import { deleteModelStats, deleteRequestRecord, resetStats } from '@/api'
import { useAppState } from '@/composables/useAppState'
import type { RequestRecord, StatsSummary } from '@/types'
import { formatNumber, formatTime, readError } from '@/utils/format'

const { summary, successRate, loadStats, resolveModelAlias, resolveProviderName } = useAppState()

const requestColumns: TableColumnsType<RequestRecord> = [
  {
    title: '时间',
    dataIndex: 'createdAt',
    width: 168,
    customRender: ({ text }) => formatTime(String(text)),
  },
  {
    title: '端点',
    dataIndex: 'endpoint',
    width: 150,
  },
  {
    title: 'Provider',
    dataIndex: 'provider',
    key: 'provider',
    width: 120,
  },
  {
    title: '映射模型',
    dataIndex: 'model',
    key: 'model',
    width: 180,
    ellipsis: true,
  },
  {
    title: '实际模型',
    dataIndex: 'targetModel',
    key: 'targetModel',
    width: 180,
    ellipsis: true,
  },
  {
    title: 'Token',
    dataIndex: 'totalTokens',
    width: 112,
    customRender: ({ record }) => `${formatNumber(record.inputTokens)} / ${formatNumber(record.outputTokens)}`,
  },
  {
    title: '耗时',
    dataIndex: 'latencyMs',
    width: 96,
    customRender: ({ text }) => `${formatNumber(Number(text))} ms`,
  },
  {
    title: '状态',
    dataIndex: 'success',
    width: 94,
    customRender: ({ record }) => (record.success ? '成功' : `失败 ${record.status}`),
  },
  {
    title: '操作',
    key: 'action',
    width: 86,
    fixed: 'right',
  },
]

const modelColumns: TableColumnsType<StatsSummary['byModel'][number]> = [
  {
    title: '映射模型',
    dataIndex: 'model',
    key: 'model',
    width: 180,
    ellipsis: true,
  },
  {
    title: '实际模型',
    dataIndex: 'targetModel',
    key: 'targetModel',
    width: 180,
    ellipsis: true,
  },
  {
    title: 'Provider',
    dataIndex: 'provider',
    key: 'provider',
    width: 120,
  },
  {
    title: '请求',
    dataIndex: 'requests',
    width: 90,
    customRender: ({ text }) => formatNumber(Number(text)),
  },
  {
    title: '输入 Token',
    dataIndex: 'inputTokens',
    width: 120,
    customRender: ({ text }) => formatNumber(Number(text)),
  },
  {
    title: '输出 Token',
    dataIndex: 'outputTokens',
    width: 120,
    customRender: ({ text }) => formatNumber(Number(text)),
  },
  {
    title: '操作',
    key: 'action',
    width: 86,
    fixed: 'right',
  },
]

function modelRowKey(record: StatsSummary['byModel'][number]) {
  return `${record.provider}:${record.model}:${record.targetModel}`
}

function displayMappedModel(providerName: string, model: string) {
  return resolveModelAlias(providerName, model)
}

function displayTargetModel(providerName: string, model: string) {
  return resolveModelAlias(providerName, model)
}

function displayProviderName(providerName: string, model: string) {
  return resolveProviderName(providerName, model)
}

function hasProviderNameAlias(providerName: string, model: string) {
  return displayProviderName(providerName, model) !== providerName
}

async function resetAllStats(label: string) {
  try {
    const result = await resetStats()
    await loadStats()
    message.success(`${label}已重置，删除 ${formatNumber(result.deleted)} 条记录`)
  } catch (error) {
    message.error(readError(error))
  }
}

async function removeModelGroup(record: StatsSummary['byModel'][number]) {
  try {
    const result = await deleteModelStats({
      provider: record.provider,
      model: record.model,
      targetModel: record.targetModel,
    })
    await loadStats()
    message.success(`已删除 ${formatNumber(result.deleted)} 条统计记录`)
  } catch (error) {
    message.error(readError(error))
  }
}

async function removeRequest(record: RequestRecord) {
  try {
    await deleteRequestRecord(record.id)
    await loadStats()
    message.success('请求记录已删除')
  } catch (error) {
    message.error(readError(error))
  }
}
</script>

<template>
  <section class="panel dashboard">
    <div class="stats-grid">
      <a-card class="metric-card">
        <span class="metric-label">请求数</span>
        <strong>{{ formatNumber(summary?.totals.requests || 0) }}</strong>
        <small>{{ successRate }}% 成功</small>
      </a-card>
      <a-card class="metric-card">
        <span class="metric-label">输入 Token</span>
        <strong>{{ formatNumber(summary?.totals.inputTokens || 0) }}</strong>
        <small>Prompt</small>
      </a-card>
      <a-card class="metric-card">
        <span class="metric-label">输出 Token</span>
        <strong>{{ formatNumber(summary?.totals.outputTokens || 0) }}</strong>
        <small>Completion</small>
      </a-card>
      <a-card class="metric-card">
        <span class="metric-label">平均耗时</span>
        <strong>{{ formatNumber(summary?.totals.avgLatencyMs || 0) }} ms</strong>
        <small>最近全部请求</small>
      </a-card>
    </div>

    <div class="data-grid">
      <a-card class="data-card">
        <template #title>模型统计</template>
        <template #extra>
          <a-popconfirm
            title="确认重置模型统计？"
            description="会删除全部请求统计数据，模型统计和最近请求都会重新计算。"
            ok-text="确认重置"
            cancel-text="取消"
            ok-type="danger"
            @confirm="resetAllStats('模型统计')"
          >
            <a-button danger size="small">
              <template #icon><ReloadOutlined /></template>
              重置
            </a-button>
          </a-popconfirm>
        </template>
        <a-table
          size="middle"
          :columns="modelColumns"
          :data-source="summary?.byModel || []"
          :pagination="{ pageSize: 8, size: 'small' }"
          :scroll="{ x: 860 }"
          :row-key="modelRowKey"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'model'">
              <span>{{ displayMappedModel(record.provider, record.model) }}</span>
            </template>
            <template v-else-if="column.key === 'provider'">
              <a-tooltip v-if="hasProviderNameAlias(record.provider, record.targetModel)" :title="record.provider">
                <span>{{ displayProviderName(record.provider, record.targetModel) }}</span>
              </a-tooltip>
              <span v-else>{{ record.provider }}</span>
            </template>
            <template v-else-if="column.key === 'targetModel'">
              <span>{{ displayTargetModel(record.provider, record.targetModel) }}</span>
            </template>
            <template v-else-if="column.key === 'action'">
              <a-popconfirm
                title="确认删除这组模型统计？"
                description="会删除匹配该映射模型、实际模型和 Provider 的全部请求记录。"
                ok-text="确认删除"
                cancel-text="取消"
                ok-type="danger"
                @confirm="removeModelGroup(record)"
              >
                <a-button class="row-delete-button" size="small">
                  <template #icon><DeleteOutlined /></template>
                </a-button>
              </a-popconfirm>
            </template>
          </template>
        </a-table>
      </a-card>
      <a-card class="data-card">
        <template #title>最近请求</template>
        <template #extra>
          <a-popconfirm
            title="确认重置最近请求？"
            description="会删除全部请求统计数据，模型统计和最近请求都会重新计算。"
            ok-text="确认重置"
            cancel-text="取消"
            ok-type="danger"
            @confirm="resetAllStats('最近请求')"
          >
            <a-button danger size="small">
              <template #icon><ReloadOutlined /></template>
              重置
            </a-button>
          </a-popconfirm>
        </template>
        <a-table
          size="middle"
          :columns="requestColumns"
          :data-source="summary?.recent || []"
          :pagination="{ pageSize: 8, size: 'small' }"
          :scroll="{ x: 940 }"
          row-key="id"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'model'">
              <span>{{ displayMappedModel(record.provider, record.model) }}</span>
            </template>
            <template v-else-if="column.key === 'provider'">
              <a-tooltip v-if="hasProviderNameAlias(record.provider, record.targetModel)" :title="record.provider">
                <span>{{ displayProviderName(record.provider, record.targetModel) }}</span>
              </a-tooltip>
              <span v-else>{{ record.provider }}</span>
            </template>
            <template v-else-if="column.key === 'targetModel'">
              <span>{{ displayTargetModel(record.provider, record.targetModel) }}</span>
            </template>
            <template v-else-if="column.key === 'action'">
              <a-popconfirm
                title="确认删除这条请求记录？"
                description="删除后相关模型统计会重新计算。"
                ok-text="确认删除"
                cancel-text="取消"
                ok-type="danger"
                @confirm="removeRequest(record)"
              >
                <a-button class="row-delete-button" size="small">
                  <template #icon><DeleteOutlined /></template>
                </a-button>
              </a-popconfirm>
            </template>
          </template>
        </a-table>
      </a-card>
    </div>
  </section>
</template>
