<script setup lang="ts">
import { DownloadOutlined, FolderOpenOutlined, ImportOutlined, SaveOutlined } from '@ant-design/icons-vue'
import { useAppState } from '@/composables/useAppState'

const { draft, desktopMode, loading, originUrl, jsonPreview, health, beforeImport, downloadSettings, openConfigDirectory, persistConfig } = useAppState()
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
      <pre class="json-preview">{{ jsonPreview }}</pre>
    </a-card>
  </section>
</template>
