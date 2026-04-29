<script setup lang="ts">
import { ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { DownloadOutlined, FolderOpenOutlined, ImportOutlined, SaveOutlined, SyncOutlined } from '@ant-design/icons-vue'
import { useAppState } from '@/composables/useAppState'

const {
  draft,
  desktopMode,
  loading,
  originUrl,
  jsonPreview,
  health,
  beforeImport,
  downloadSettings,
  openConfigDirectory,
  persistConfig,
  saveJsonConfig,
} = useAppState()

const jsonEditorText = ref('')
const jsonEditorDirty = ref(false)
const jsonEditorError = ref('')

watch(
  jsonPreview,
  (value) => {
    if (!jsonEditorDirty.value) {
      jsonEditorText.value = value
    }
  },
  { immediate: true },
)

function markJsonEditorDirty() {
  jsonEditorDirty.value = true
  jsonEditorError.value = ''
}

function resetJsonEditor() {
  jsonEditorText.value = jsonPreview.value
  jsonEditorDirty.value = false
  jsonEditorError.value = ''
}

function formatJsonEditor() {
  try {
    jsonEditorText.value = JSON.stringify(JSON.parse(jsonEditorText.value), null, 2)
    jsonEditorDirty.value = true
    jsonEditorError.value = ''
    message.success('JSON 已格式化')
  } catch (error) {
    jsonEditorError.value = error instanceof Error ? error.message : String(error)
  }
}

async function saveJsonEditor() {
  try {
    const normalized = JSON.stringify(JSON.parse(jsonEditorText.value), null, 2)
    await saveJsonConfig(normalized)
    jsonEditorText.value = jsonPreview.value
    jsonEditorDirty.value = false
    jsonEditorError.value = ''
  } catch (error) {
    jsonEditorError.value = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <section v-if="draft" class="panel io-panel">
    <a-card class="tool-card">
      <template #title>配置交换</template>
      <div class="io-actions">
        <a-upload accept=".json,application/json" :show-upload-list="false" :before-upload="beforeImport">
          <a-button :loading="loading.importing">
            <template #icon><ImportOutlined /></template>
            导入 JSON
          </a-button>
        </a-upload>
        <a-button @click="downloadSettings">
          <template #icon><DownloadOutlined /></template>
          导出 JSON
        </a-button>
        <a-button v-if="desktopMode" @click="openConfigDirectory">
          <template #icon><FolderOpenOutlined /></template>
          打开配置文件夹
        </a-button>
        <a-button type="primary" :loading="loading.saving" @click="persistConfig">
          <template #icon><SaveOutlined /></template>
          保存当前配置
        </a-button>
      </div>
      <div class="env-strip">
        <div>
          <span>ANTHROPIC_BASE_URL</span>
          <code>{{ originUrl }}</code>
        </div>
        <div>
          <span>ANTHROPIC_AUTH_TOKEN</span>
          <code>{{ draft.APIKEY || 'empty' }}</code>
        </div>
        <div>
          <span>配置目录</span>
          <code>{{ health?.dataDir || 'loading' }}</code>
        </div>
      </div>
    </a-card>

    <a-card class="tool-card">
      <template #title>当前 JSON</template>
      <template #extra>
        <div class="json-editor-actions">
          <a-tag v-if="jsonEditorDirty" color="gold">未保存</a-tag>
          <a-button size="small" @click="formatJsonEditor">
            <template #icon><SyncOutlined /></template>
            格式化
          </a-button>
          <a-button size="small" :disabled="!jsonEditorDirty" @click="resetJsonEditor">重置</a-button>
          <a-button size="small" type="primary" :loading="loading.saving" @click="saveJsonEditor">
            <template #icon><SaveOutlined /></template>
            校验并保存
          </a-button>
        </div>
      </template>
      <a-alert
        v-if="jsonEditorError"
        class="json-editor-alert"
        type="error"
        show-icon
        :message="jsonEditorError"
      />
      <a-textarea
        v-model:value="jsonEditorText"
        class="json-editor"
        spellcheck="false"
        :auto-size="{ minRows: 24, maxRows: 42 }"
        @input="markJsonEditorDirty"
      />
    </a-card>
  </section>
</template>
