<script setup lang="ts">
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons-vue'
import { useAppState } from '@/composables/useAppState'

const { draft, providerEditors, addProvider, removeProvider, providerStatus } = useAppState()
</script>

<template>
  <section v-if="draft" class="panel providers-panel">
    <div class="section-actions">
      <a-button type="primary" @click="addProvider">
        <template #icon><PlusOutlined /></template>
        新增 Provider
      </a-button>
    </div>

    <a-collapse class="provider-list">
      <a-collapse-panel
        v-for="(provider, index) in draft.Providers"
        :key="`${provider.name}-${index}`"
        :header="provider.name || `Provider ${index + 1}`"
      >
        <template #extra>
          <a-space>
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
              <a-textarea
                v-model:value="providerEditors[index].modelsText"
                :auto-size="{ minRows: 4, maxRows: 9 }"
              />
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
