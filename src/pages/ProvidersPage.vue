<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TableColumnsType } from 'ant-design-vue'
import { CopyOutlined, DeleteOutlined, ImportOutlined, PlusOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { useAppState } from '@/composables/useAppState'
import type { ProviderConfig } from '@/types'
import { readError } from '@/utils/format'

const {
  draft,
  providerEditors,
  addProvider,
  importProviderFromCurl,
  copyProvider,
  addProviderModel,
  removeProviderModel,
  removeProvider,
  providerStatus,
} = useAppState()

const curlImportOpen = ref(false)
const curlText = ref('')

interface ProviderRow {
  provider: ProviderConfig
  index: number
  key: string
}

const providerKeys = new WeakMap<ProviderConfig, string>()
let providerKeySeed = 0

const providerRows = computed<ProviderRow[]>(() => {
  return draft.value?.Providers.map((provider, index) => ({ provider, index, key: providerStableKey(provider) })) ?? []
})

const providerColumns: TableColumnsType<ProviderRow> = [
  {
    title: 'Name',
    key: 'name',
    width: 220,
    ellipsis: true,
  },
  {
    title: 'API Base URL',
    key: 'apiBaseUrl',
    width: 420,
    ellipsis: true,
  },
  {
    title: 'Models',
    key: 'models',
    width: 110,
  },
  {
    title: '状态',
    key: 'status',
    width: 100,
  },
  {
    title: '操作',
    key: 'action',
    width: 150,
    fixed: 'right',
  },
]

function openCurlImport() {
  curlText.value = ''
  curlImportOpen.value = true
}

function handleCurlImport() {
  try {
    const provider = importProviderFromCurl(curlText.value)
    message.success(`已导入 Provider：${provider.name}`)
    curlImportOpen.value = false
    curlText.value = ''
  } catch (error) {
    message.error(readError(error))
  }
}

function handleCopyProvider(index: number) {
  try {
    const provider = copyProvider(index)
    message.success(`已复制 Provider：${provider.name}`)
  } catch (error) {
    message.error(readError(error))
  }
}

function providerRowKey(record: ProviderRow) {
  return record.key
}

function providerModelCount(record: ProviderRow) {
  return providerEditors.value[record.index]?.models.filter((row) => row.model.trim()).length ?? record.provider.models.length
}

function providerStableKey(provider: ProviderConfig) {
  const existingKey = providerKeys.get(provider)
  if (existingKey) {
    return existingKey
  }

  providerKeySeed += 1
  const key = `provider-${providerKeySeed}`
  providerKeys.set(provider, key)
  return key
}
</script>

<template>
  <section v-if="draft" class="panel providers-panel">
    <div class="section-actions">
      <a-button type="primary" @click="addProvider">
        <template #icon><PlusOutlined /></template>
        新增 Provider
      </a-button>
      <a-button @click="openCurlImport">
        <template #icon><ImportOutlined /></template>
        Curl 导入
      </a-button>
    </div>

    <a-modal
      v-model:open="curlImportOpen"
      title="Curl 导入"
      ok-text="导入 Provider"
      cancel-text="取消"
      width="760px"
      :ok-button-props="{ disabled: !curlText.trim() }"
      @ok="handleCurlImport"
    >
      <a-textarea
        v-model:value="curlText"
        class="curl-import-editor"
        :auto-size="{ minRows: 8, maxRows: 16 }"
        placeholder="curl --request POST --url https://api.example.com/v1/chat/completions --header 'Authorization: Bearer sk-...' --data '{&quot;model&quot;:&quot;model-name&quot;}'"
      />
    </a-modal>

    <a-table
      class="provider-table"
      size="middle"
      :columns="providerColumns"
      :data-source="providerRows"
      :pagination="{ pageSize: 12, size: 'small', showSizeChanger: true, pageSizeOptions: ['12', '24', '48'] }"
      :row-key="providerRowKey"
      :scroll="{ x: 1000 }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <span class="provider-name-cell">{{ record.provider.name || `Provider ${record.index + 1}` }}</span>
        </template>
        <template v-else-if="column.key === 'apiBaseUrl'">
          <span class="provider-url-cell">{{ record.provider.api_base_url || '-' }}</span>
        </template>
        <template v-else-if="column.key === 'models'">
          {{ providerModelCount(record) }}
        </template>
        <template v-else-if="column.key === 'status'">
          <a-tag :color="providerStatus(record.provider) === '就绪' ? 'success' : 'warning'">
            {{ providerStatus(record.provider) }}
          </a-tag>
        </template>
        <template v-else-if="column.key === 'action'">
          <a-space class="provider-table-actions">
            <a-tooltip title="复制">
              <a-button size="small" @click="handleCopyProvider(record.index)">
                <template #icon><CopyOutlined /></template>
              </a-button>
            </a-tooltip>
            <a-button danger size="small" @click="removeProvider(record.index)">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </a-space>
        </template>
      </template>

      <template #expandedRowRender="{ record }">
        <div class="provider-editor-panel">
          <a-form layout="vertical">
            <div class="form-grid">
              <a-form-item label="Name">
                <a-input v-model:value="record.provider.name" />
              </a-form-item>
              <a-form-item label="API Base URL">
                <a-input v-model:value="record.provider.api_base_url" />
              </a-form-item>
              <a-form-item label="API Key">
                <a-input-password v-model:value="record.provider.api_key" autocomplete="new-password" />
              </a-form-item>
              <a-form-item v-if="providerEditors[record.index]" label="Models">
                <div class="model-row-list">
                  <div
                    v-for="(modelRow, modelIndex) in providerEditors[record.index].models"
                    :key="`${record.index}-${modelIndex}`"
                    class="model-row"
                  >
                    <a-input v-model:value="modelRow.model" placeholder="真实模型" />
                    <a-input v-model:value="modelRow.alias" placeholder="模型别名（可不填）" />
                    <a-button
                      class="row-delete-button"
                      size="small"
                      @click="removeProviderModel(record.index, modelIndex)"
                    >
                      <template #icon><DeleteOutlined /></template>
                    </a-button>
                  </div>
                  <a-button size="small" class="model-row-add" @click="addProviderModel(record.index)">
                    <template #icon><PlusOutlined /></template>
                    添加模型
                  </a-button>
                </div>
              </a-form-item>
            </div>
            <a-form-item v-if="providerEditors[record.index]" label="Transformer">
              <a-textarea
                v-model:value="providerEditors[record.index].transformerText"
                class="json-editor"
                :auto-size="{ minRows: 6, maxRows: 14 }"
              />
            </a-form-item>
          </a-form>
        </div>
      </template>
    </a-table>
  </section>
</template>
