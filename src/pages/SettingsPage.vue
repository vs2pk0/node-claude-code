<script setup lang="ts">
import { useAppState } from '@/composables/useAppState'

const { draft, routeOptions } = useAppState()
</script>

<template>
  <section v-if="draft" class="panel settings-panel">
    <a-card class="tool-card">
      <template #title>本地服务</template>
      <a-form layout="vertical">
        <div class="form-grid">
          <a-form-item label="Host">
            <a-input v-model:value="draft.HOST" />
          </a-form-item>
          <a-form-item label="Port">
            <a-input-number v-model:value="draft.PORT" :min="1" :max="65535" class="full-input" />
          </a-form-item>
          <a-form-item label="Local API Key">
            <a-input-password v-model:value="draft.APIKEY" autocomplete="new-password" />
          </a-form-item>
          <a-form-item label="Timeout">
            <a-input v-model:value="draft.API_TIMEOUT_MS" />
          </a-form-item>
          <a-form-item label="Proxy URL">
            <a-input v-model:value="draft.PROXY_URL" />
          </a-form-item>
          <a-form-item label="Log Level">
            <a-select v-model:value="draft.LOG_LEVEL">
              <a-select-option value="debug">debug</a-select-option>
              <a-select-option value="info">info</a-select-option>
              <a-select-option value="warn">warn</a-select-option>
              <a-select-option value="error">error</a-select-option>
            </a-select>
          </a-form-item>
          <a-form-item label="LOG">
            <a-switch v-model:checked="draft.LOG" />
          </a-form-item>
          <a-form-item label="Claude Path">
            <a-input v-model:value="draft.CLAUDE_PATH" />
          </a-form-item>
        </div>
      </a-form>
    </a-card>

    <a-card class="tool-card">
      <template #title>路由策略</template>
      <a-form layout="vertical">
        <div class="form-grid">
          <a-form-item label="Default">
            <a-select v-model:value="draft.Router.default" show-search allow-clear :options="routeOptions" />
          </a-form-item>
          <a-form-item label="Background">
            <a-select v-model:value="draft.Router.background" show-search allow-clear :options="routeOptions" />
          </a-form-item>
          <a-form-item label="Think">
            <a-select v-model:value="draft.Router.think" show-search allow-clear :options="routeOptions" />
          </a-form-item>
          <a-form-item label="Long Context">
            <a-select v-model:value="draft.Router.longContext" show-search allow-clear :options="routeOptions" />
          </a-form-item>
          <a-form-item label="Image">
            <a-select v-model:value="draft.Router.image" show-search allow-clear :options="routeOptions" />
          </a-form-item>
          <a-form-item label="Threshold">
            <a-input-number
              v-model:value="draft.Router.longContextThreshold"
              :min="0"
              :step="1000"
              class="full-input"
            />
          </a-form-item>
        </div>
      </a-form>
    </a-card>
  </section>
</template>
