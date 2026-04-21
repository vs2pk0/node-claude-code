<script setup lang="ts">
import { computed, ref } from 'vue'
import type { TableColumnsType } from 'ant-design-vue'
import { CopyOutlined, DeleteOutlined, HolderOutlined, ImportOutlined, PlusOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { useAppState } from '@/composables/useAppState'
import type { ModelFormatMode, ProviderConfig, RouterStrategy } from '@/types'
import { readError } from '@/utils/format'
import { createTablePagination } from '@/utils/pagination'

const {
  draft,
  providerEditors,
  addProvider,
  importProviderFromCurl,
  copyProvider,
  moveProvider,
  addProviderModel,
  removeProviderModel,
  addProviderApiKey,
  removeProviderApiKey,
  toggleProviderApiKeyDisabled,
  moveProviderApiKey,
  removeProvider,
  providerStatus,
  providerApiKeyRowCount,
  modelConflictWarningsEnabled,
  modelAliasConflictsForProvider,
  findModelAliasConflict,
} = useAppState()

const curlImportOpen = ref(false)
const curlText = ref('')
const draggedProviderIndex = ref<number>()
const dragOverProviderIndex = ref<number>()
const draggedProviderKey = ref<{ providerIndex: number; keyIndex: number }>()
const dragOverProviderKey = ref<{ providerIndex: number; keyIndex: number }>()
const providerPagination = createTablePagination(12, ['12', '24', '48', '96'])

interface ProviderRow {
  provider: ProviderConfig
  index: number
  key: string
}

const providerKeys = new WeakMap<ProviderConfig, string>()
let providerKeySeed = 0
const modelFormatOptions: Array<{ label: string; value: ModelFormatMode }> = [
  { label: '默认格式', value: 'default' },
  { label: 'Claude Code 直转', value: 'claude-code' },
]
const keyStrategyOptions: Array<{ label: string; value: RouterStrategy }> = [
  { label: '按顺序', value: 'sequence' },
  { label: '负载平衡', value: 'loadBalance' },
  { label: '随机调用', value: 'random' },
]

const providerRows = computed<ProviderRow[]>(() => {
  return draft.value?.Providers.map((provider, index) => ({ provider, index, key: providerStableKey(provider) })) ?? []
})

const providerColumns: TableColumnsType<ProviderRow> = [
  {
    title: '',
    key: 'drag',
    width: 52,
    fixed: 'left',
  },
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

function providerCustomRow(record: ProviderRow) {
  return {
    class: [
      draggedProviderIndex.value === record.index ? 'provider-row-dragging' : '',
      dragOverProviderIndex.value === record.index && draggedProviderIndex.value !== record.index
        ? 'provider-row-drag-over'
        : '',
    ]
      .filter(Boolean)
      .join(' '),
    onDragover: (event: DragEvent) => handleProviderDragOver(event, record),
    onDrop: (event: DragEvent) => handleProviderDrop(event, record),
  }
}

function handleProviderDragStart(event: DragEvent, record: ProviderRow) {
  draggedProviderIndex.value = record.index
  dragOverProviderIndex.value = record.index
  event.dataTransfer?.setData('text/plain', String(record.index))
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
  }
}

function handleProviderDragOver(event: DragEvent, record: ProviderRow) {
  if (draggedProviderIndex.value === undefined) {
    return
  }

  event.preventDefault()
  dragOverProviderIndex.value = record.index
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
}

function handleProviderDrop(event: DragEvent, record: ProviderRow) {
  event.preventDefault()
  const draggedIndex = draggedProviderIndex.value ?? Number(event.dataTransfer?.getData('text/plain'))
  if (!Number.isInteger(draggedIndex)) {
    handleProviderDragEnd()
    return
  }

  const rowElement = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
  const rowRect = rowElement?.getBoundingClientRect()
  const dropAfter = rowRect ? event.clientY > rowRect.top + rowRect.height / 2 : false

  moveProvider(draggedIndex, record.index + (dropAfter ? 1 : 0))
  handleProviderDragEnd()
}

function handleProviderDragEnd() {
  draggedProviderIndex.value = undefined
  dragOverProviderIndex.value = undefined
}

function handleProviderApiKeyDragStart(event: DragEvent, providerIndex: number, keyIndex: number) {
  event.stopPropagation()
  draggedProviderKey.value = { providerIndex, keyIndex }
  dragOverProviderKey.value = { providerIndex, keyIndex }
  event.dataTransfer?.setData('text/plain', `${providerIndex}:${keyIndex}`)
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
  }
}

function handleProviderApiKeyDragOver(event: DragEvent, providerIndex: number, keyIndex: number) {
  if (draggedProviderKey.value?.providerIndex !== providerIndex) {
    return
  }

  event.preventDefault()
  event.stopPropagation()
  dragOverProviderKey.value = { providerIndex, keyIndex }
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'move'
  }
}

function handleProviderApiKeyDrop(event: DragEvent, providerIndex: number, keyIndex: number) {
  event.preventDefault()
  event.stopPropagation()
  if (draggedProviderKey.value?.providerIndex !== providerIndex) {
    handleProviderApiKeyDragEnd()
    return
  }

  const rowElement = event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined
  const rowRect = rowElement?.getBoundingClientRect()
  const dropAfter = rowRect ? event.clientY > rowRect.top + rowRect.height / 2 : false

  moveProviderApiKey(providerIndex, draggedProviderKey.value.keyIndex, keyIndex + (dropAfter ? 1 : 0))
  handleProviderApiKeyDragEnd()
}

function handleProviderApiKeyDragEnd() {
  draggedProviderKey.value = undefined
  dragOverProviderKey.value = undefined
}

function isProviderKeyDragging(providerIndex: number, keyIndex: number) {
  return draggedProviderKey.value?.providerIndex === providerIndex && draggedProviderKey.value.keyIndex === keyIndex
}

function isProviderKeyDragOver(providerIndex: number, keyIndex: number) {
  return (
    dragOverProviderKey.value?.providerIndex === providerIndex
    && dragOverProviderKey.value.keyIndex === keyIndex
    && !isProviderKeyDragging(providerIndex, keyIndex)
  )
}

function providerModelCount(record: ProviderRow) {
  return providerEditors.value[record.index]?.models.filter((row) => row.model.trim()).length ?? record.provider.models.length
}

function providerAliasConflictDescription(providerIndex: number) {
  if (!modelConflictWarningsEnabled.value) {
    return ''
  }

  return modelAliasConflictsForProvider(providerIndex)
    .map((conflict) => {
      const sources = conflict.entries
        .map((entry) => `${entry.providerName}/${entry.alias || entry.model}`)
        .join('、')
      return `${conflict.publicId}：${sources}`
    })
    .join('；')
}

function providerHasAliasConflict(providerIndex: number) {
  if (!modelConflictWarningsEnabled.value) {
    return false
  }

  return modelAliasConflictsForProvider(providerIndex).length > 0
}

function modelAliasInputStatus(providerIndex: number, modelIndex: number) {
  if (!modelConflictWarningsEnabled.value) {
    return undefined
  }

  return findModelAliasConflict(providerIndex, modelIndex) ? 'warning' : undefined
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
      :pagination="providerPagination"
      :row-key="providerRowKey"
      :scroll="{ x: 1000 }"
      :custom-row="providerCustomRow"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'drag'">
          <a-tooltip title="拖拽调整顺序">
            <span
              class="provider-drag-handle"
              draggable="true"
              @dragstart="handleProviderDragStart($event, record)"
              @dragend="handleProviderDragEnd"
            >
              <HolderOutlined />
            </span>
          </a-tooltip>
        </template>
        <template v-else-if="column.key === 'name'">
          <span class="provider-name-cell">{{ record.provider.name || `Provider ${record.index + 1}` }}</span>
        </template>
        <template v-else-if="column.key === 'apiBaseUrl'">
          <span class="provider-url-cell">{{ record.provider.api_base_url || '-' }}</span>
        </template>
        <template v-else-if="column.key === 'models'">
          {{ providerModelCount(record) }}
        </template>
        <template v-else-if="column.key === 'status'">
          <a-space size="small">
            <a-tag :color="providerStatus(record.provider) === '就绪' ? 'success' : 'warning'">
              {{ providerStatus(record.provider) }}
            </a-tag>
            <a-tag v-if="record.provider.claude_code_forward" color="blue">直转</a-tag>
            <a-tag v-if="providerHasAliasConflict(record.index)" color="orange">模型冲突</a-tag>
          </a-space>
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
              <a-form-item label="API Key" class="provider-keys-form-item">
                <div class="provider-key-list">
                  <div
                    v-for="(_, keyIndex) in record.provider.api_keys"
                    :key="`${record.key}-key-${keyIndex}`"
                    class="provider-key-row"
                    :class="{
                      'is-disabled': record.provider.api_key_disabled[keyIndex],
                      'is-dragging': isProviderKeyDragging(record.index, keyIndex),
                      'is-drag-over': isProviderKeyDragOver(record.index, keyIndex),
                    }"
                    @dragover="handleProviderApiKeyDragOver($event, record.index, keyIndex)"
                    @drop="handleProviderApiKeyDrop($event, record.index, keyIndex)"
                  >
                    <a-tooltip title="拖拽调整 Key 顺序">
                      <span
                        class="provider-key-drag-handle"
                        draggable="true"
                        @dragstart="handleProviderApiKeyDragStart($event, record.index, keyIndex)"
                        @dragend="handleProviderApiKeyDragEnd"
                      >
                        <HolderOutlined />
                      </span>
                    </a-tooltip>
                    <a-input-password
                      v-model:value="record.provider.api_keys[keyIndex]"
                      autocomplete="new-password"
                      placeholder="API Key"
                    />
                    <a-input
                      v-model:value="record.provider.api_key_names[keyIndex]"
                      placeholder="备注名（可不填）"
                    />
                    <a-button
                      class="key-disable-button"
                      size="small"
                      @click="toggleProviderApiKeyDisabled(record.index, keyIndex)"
                    >
                      {{ record.provider.api_key_disabled[keyIndex] ? '启用' : '停用' }}
                    </a-button>
                    <a-button
                      class="row-delete-button"
                      size="small"
                      @click="removeProviderApiKey(record.index, keyIndex)"
                    >
                      <template #icon><DeleteOutlined /></template>
                    </a-button>
                  </div>
                  <div class="provider-key-actions">
                    <a-button size="small" @click="addProviderApiKey(record.index)">
                      <template #icon><PlusOutlined /></template>
                      添加 Key
                    </a-button>
                    <a-select
                      v-if="providerApiKeyRowCount(record.provider) > 1"
                      v-model:value="record.provider.api_key_strategy"
                      class="provider-key-strategy"
                      :options="keyStrategyOptions"
                    />
                  </div>
                </div>
              </a-form-item>
              <a-form-item label="转发 Claude Code">
                <a-switch v-model:checked="record.provider.claude_code_forward" />
              </a-form-item>
              <a-form-item v-if="providerEditors[record.index]" label="Models" class="models-form-item">
                <div class="model-row-list">
                  <a-alert
                    v-if="providerAliasConflictDescription(record.index)"
                    type="warning"
                    show-icon
                    message="模型显示 ID 存在重复"
                    :description="providerAliasConflictDescription(record.index)"
                  />
                  <div
                    v-for="(modelRow, modelIndex) in providerEditors[record.index].models"
                    :key="`${record.index}-${modelIndex}`"
                    class="model-row"
                  >
                    <a-input v-model:value="modelRow.model" placeholder="真实模型" />
                    <a-input
                      v-model:value="modelRow.alias"
                      placeholder="模型别名（可不填）"
                      :status="modelAliasInputStatus(record.index, modelIndex)"
                    />
                    <a-select
                      v-model:value="modelRow.format"
                      :options="modelFormatOptions"
                      placeholder="格式处理"
                    />
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
