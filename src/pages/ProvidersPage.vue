<script setup lang="ts">
import { ref } from 'vue'
import { CopyOutlined, DeleteOutlined, ImportOutlined, PlusOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { useAppState } from '@/composables/useAppState'
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

    <a-collapse class="provider-list">
      <a-collapse-panel
        v-for="(provider, index) in draft.Providers"
        :key="`provider-${index}`"
        :header="provider.name || `Provider ${index + 1}`"
      >
        <template #extra>
          <a-space>
            <a-tooltip title="复制">
              <a-button size="small" @click.stop="handleCopyProvider(index)">
                <template #icon><CopyOutlined /></template>
              </a-button>
            </a-tooltip>
            <a-tag :color="providerStatus(provider) === '就绪' ? 'success' : 'warning'">
              {{ providerStatus(provider) }}
            </a-tag>
            <a-button danger size="small" @click.stop="removeProvider(index)">
              <template #icon><DeleteOutlined /></template>
            </a-button>
          </a-space>
        </template>

        <a-form layout="vertical">
          <div class="form-grid">
            <a-form-item label="Name">
              <a-input v-model:value="provider.name" />
            </a-form-item>
            <a-form-item label="API Base URL">
              <a-input v-model:value="provider.api_base_url" />
            </a-form-item>
            <a-form-item label="API Key">
              <a-input-password v-model:value="provider.api_key" autocomplete="new-password" />
            </a-form-item>
            <a-form-item v-if="providerEditors[index]" label="Models">
              <div class="model-row-list">
                <div
                  v-for="(modelRow, modelIndex) in providerEditors[index].models"
                  :key="`${index}-${modelIndex}`"
                  class="model-row"
                >
                  <a-input v-model:value="modelRow.model" placeholder="真实模型" />
                  <a-input v-model:value="modelRow.alias" placeholder="模型别名（可不填）" />
                  <a-button class="row-delete-button" size="small" @click="removeProviderModel(index, modelIndex)">
                    <template #icon><DeleteOutlined /></template>
                  </a-button>
                </div>
                <a-button size="small" class="model-row-add" @click="addProviderModel(index)">
                  <template #icon><PlusOutlined /></template>
                  添加模型
                </a-button>
              </div>
            </a-form-item>
          </div>
          <a-form-item v-if="providerEditors[index]" label="Transformer">
            <a-textarea
              v-model:value="providerEditors[index].transformerText"
              class="json-editor"
              :auto-size="{ minRows: 6, maxRows: 14 }"
            />
          </a-form-item>
        </a-form>
      </a-collapse-panel>
    </a-collapse>
  </section>
</template>
