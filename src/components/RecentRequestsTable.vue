<script setup lang="ts">
import type { TableColumnsType } from 'ant-design-vue'
import { DeleteOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import { useAppState } from '@/composables/useAppState'
import type { RequestRecord } from '@/types'
import { formatNumber, formatTime } from '@/utils/format'
import { createTablePagination } from '@/utils/pagination'

const props = withDefaults(
  defineProps<{
    records?: RequestRecord[]
    title?: string
  }>(),
  {
    records: () => [],
    title: '最近请求',
  },
)

const emit = defineEmits<{
  (event: 'reset'): void
  (event: 'remove', record: RequestRecord): void
}>()

const { resolveModelAlias, resolveProviderName } = useAppState()
const requestPagination = createTablePagination(8)

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
    title: 'Key',
    dataIndex: 'apiKey',
    key: 'apiKey',
    width: 150,
    ellipsis: true,
    customRender: ({ text }) => String(text || '-'),
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
    title: '排队',
    dataIndex: 'queueMs',
    width: 92,
    customRender: ({ text }) => `${formatNumber(Number(text))} ms`,
  },
  {
    title: '发起上游',
    dataIndex: 'upstreamMs',
    width: 110,
    customRender: ({ text }) => `${formatNumber(Number(text))} ms`,
  },
  {
    title: '首包',
    dataIndex: 'firstByteMs',
    width: 92,
    customRender: ({ text }) => `${formatNumber(Number(text))} ms`,
  },
  {
    title: '总耗时',
    dataIndex: 'latencyMs',
    width: 104,
    fixed: 'right',
    customRender: ({ text }) => `${formatNumber(Number(text))} ms`,
  },
  {
    title: '状态',
    dataIndex: 'success',
    width: 94,
    fixed: 'right',
    customRender: ({ record }) => (record.success ? '成功' : `失败 ${record.status}`),
  },
  {
    title: '操作',
    key: 'action',
    width: 86,
    fixed: 'right',
  },
]

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
</script>

<template>
  <a-card class="data-card recent-requests-card">
    <template #title>{{ props.title }}</template>
    <template #extra>
      <a-popconfirm
        title="确认重置最近请求？"
        description="会删除全部请求统计数据，模型统计和最近请求都会重新计算。"
        ok-text="确认重置"
        cancel-text="取消"
        ok-type="danger"
        @confirm="emit('reset')"
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
      :data-source="props.records"
      :pagination="requestPagination"
      :scroll="{ x: 1370 }"
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
            @confirm="emit('remove', record)"
          >
            <a-button class="row-delete-button" size="small">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </a-popconfirm>
        </template>
      </template>
    </a-table>
  </a-card>
</template>
