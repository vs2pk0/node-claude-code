<script setup lang="ts">
import type { TableColumnsType } from 'ant-design-vue'
import { useAppState } from '@/composables/useAppState'
import type { RequestRecord, StatsSummary } from '@/types'
import { formatNumber, formatTime } from '@/utils/format'

const { summary, successRate } = useAppState()

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
    width: 120,
  },
  {
    title: '映射模型',
    dataIndex: 'model',
    width: 180,
    ellipsis: true,
  },
  {
    title: '实际模型',
    dataIndex: 'targetModel',
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
]

const modelColumns: TableColumnsType<StatsSummary['byModel'][number]> = [
  {
    title: '映射模型',
    dataIndex: 'model',
    width: 180,
    ellipsis: true,
  },
  {
    title: '实际模型',
    dataIndex: 'targetModel',
    width: 180,
    ellipsis: true,
  },
  {
    title: 'Provider',
    dataIndex: 'provider',
    width: 120,
  },
  {
    title: '请求',
    dataIndex: 'requests',
    width: 90,
    customRender: ({ text }) => formatNumber(Number(text)),
  },
  {
    title: 'Token',
    dataIndex: 'totalTokens',
    width: 120,
    customRender: ({ text }) => formatNumber(Number(text)),
  },
]

function modelRowKey(record: StatsSummary['byModel'][number]) {
  return `${record.provider}:${record.model}:${record.targetModel}`
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
        <a-table
          size="middle"
          :columns="modelColumns"
          :data-source="summary?.byModel || []"
          :pagination="{ pageSize: 8, size: 'small' }"
          :scroll="{ x: 740 }"
          :row-key="modelRowKey"
        />
      </a-card>
      <a-card class="data-card">
        <template #title>最近请求</template>
        <a-table
          size="middle"
          :columns="requestColumns"
          :data-source="summary?.recent || []"
          :pagination="{ pageSize: 8, size: 'small' }"
          :scroll="{ x: 940 }"
          row-key="id"
        />
      </a-card>
    </div>
  </section>
</template>
