<script setup lang="ts">
import { computed, ref } from 'vue'
import { CodeOutlined, CopyOutlined, InfoCircleOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { useAppState } from '@/composables/useAppState'
import type { RouterRuleConfig } from '@/types'

const { draft, routeOptions, originUrl } = useAppState()

const claudeConfigOpen = ref(false)
const strategyOptions = [
  { label: '按顺序', value: 'sequence' },
  { label: '负载平衡', value: 'loadBalance' },
  { label: '随机调用', value: 'random' },
]

const claudeCodeConfig = computed(() => {
  const config = draft.value
  if (!config) {
    return {
      env: {},
    }
  }

  const primaryModel = config.Router.default.model || 'claude-sonnet-4-6'
  const reasoningModel = config.Router.think.model || primaryModel
  const haikuModel = config.Router.background.model || 'claude-haiku-4-5-20251001'
  const opusModel = config.Router.think.model || 'claude-opus-4-7'

  return {
    env: {
      ANTHROPIC_BASE_URL: originUrl.value || `http://${config.HOST}:${config.PORT}`,
      ANTHROPIC_MODEL: primaryModel,
      ANTHROPIC_REASONING_MODEL: reasoningModel,
      ANTHROPIC_DEFAULT_SONNET_MODEL: primaryModel,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: haikuModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: opusModel,
      ANTHROPIC_AUTH_TOKEN: config.APIKEY,
    },
  }
})

const claudeCodeJson = computed(() => JSON.stringify(claudeCodeConfig.value, null, 2))

function hasMultipleTargets(rule: RouterRuleConfig) {
  return rule.targets.length > 1
}

async function copyClaudeCodeJson() {
  try {
    await navigator.clipboard.writeText(claudeCodeJson.value)
    message.success('Claude Code JSON 已复制')
  } catch {
    message.error('复制失败，请手动选择复制')
  }
}

function generateLocalApiKey() {
  if (!draft.value) {
    return
  }

  draft.value.APIKEY = `sk-ncc-${randomBase64Url(32)}`
  message.success('已生成新的 Local API Key')
}

function randomBase64Url(byteLength: number) {
  const bytes = new Uint8Array(byteLength)
  const cryptoApi = globalThis.crypto

  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }

  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
</script>

<template>
  <section v-if="draft" class="panel settings-panel">
    <a-card class="tool-card">
      <template #title>本地服务</template>
      <template #extra>
        <a-button @click="claudeConfigOpen = true">
          <template #icon><CodeOutlined /></template>
          Claude Code JSON 配置
        </a-button>
      </template>
      <a-form layout="vertical">
        <div class="form-grid">
          <a-form-item label="Host">
            <a-input v-model:value="draft.HOST" />
          </a-form-item>
          <a-form-item label="Port">
            <a-input-number v-model:value="draft.PORT" :min="1" :max="65535" class="full-input" />
          </a-form-item>
          <a-form-item class="api-key-item">
            <template #label>
              <span class="field-label-with-action">
                <span>Local API Key</span>
                <a-button size="small" @click.stop.prevent="generateLocalApiKey">
                  <template #icon><ReloadOutlined /></template>
                  随机生成
                </a-button>
              </span>
            </template>
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

    <a-modal v-model:open="claudeConfigOpen" title="Claude Code JSON 配置" width="720px" :footer="null">
      <div class="claude-config-actions">
        <a-button type="primary" @click="copyClaudeCodeJson">
          <template #icon><CopyOutlined /></template>
          复制 JSON
        </a-button>
      </div>
      <pre class="json-preview"><code>{{ claudeCodeJson }}</code></pre>
    </a-modal>

    <a-card class="tool-card">
      <template #title>
        <span class="card-title-with-help">
          <span>路由策略</span>
          <a-tooltip title="普通模型名命中已选目标的真实模型或别名时，会参与该路由策略；需要直连时使用 provider,model。">
            <InfoCircleOutlined />
          </a-tooltip>
        </span>
      </template>
      <a-form layout="vertical">
        <div class="route-rule-grid">
          <div class="route-rule-item">
            <a-form-item label="Default 模型 ID">
              <a-input v-model:value="draft.Router.default.model" />
            </a-form-item>
            <a-form-item label="Default">
              <div class="route-target-row">
                <a-select
                  v-model:value="draft.Router.default.targets"
                  mode="multiple"
                  show-search
                  allow-clear
                  :options="routeOptions"
                />
                <a-select
                  v-if="hasMultipleTargets(draft.Router.default)"
                  v-model:value="draft.Router.default.strategy"
                  class="route-strategy-select"
                  :options="strategyOptions"
                />
              </div>
            </a-form-item>
          </div>
          <div class="route-rule-item">
            <a-form-item label="Background 模型 ID">
              <a-input v-model:value="draft.Router.background.model" />
            </a-form-item>
            <a-form-item label="Background">
              <div class="route-target-row">
                <a-select
                  v-model:value="draft.Router.background.targets"
                  mode="multiple"
                  show-search
                  allow-clear
                  :options="routeOptions"
                />
                <a-select
                  v-if="hasMultipleTargets(draft.Router.background)"
                  v-model:value="draft.Router.background.strategy"
                  class="route-strategy-select"
                  :options="strategyOptions"
                />
              </div>
            </a-form-item>
          </div>
          <div class="route-rule-item">
            <a-form-item label="Think 模型 ID">
              <a-input v-model:value="draft.Router.think.model" />
            </a-form-item>
            <a-form-item label="Think">
              <div class="route-target-row">
                <a-select
                  v-model:value="draft.Router.think.targets"
                  mode="multiple"
                  show-search
                  allow-clear
                  :options="routeOptions"
                />
                <a-select
                  v-if="hasMultipleTargets(draft.Router.think)"
                  v-model:value="draft.Router.think.strategy"
                  class="route-strategy-select"
                  :options="strategyOptions"
                />
              </div>
            </a-form-item>
          </div>
          <div class="route-rule-item">
            <a-form-item label="Long Context 模型 ID">
              <a-input v-model:value="draft.Router.longContext.model" />
            </a-form-item>
            <a-form-item label="Long Context">
              <div class="route-target-row">
                <a-select
                  v-model:value="draft.Router.longContext.targets"
                  mode="multiple"
                  show-search
                  allow-clear
                  :options="routeOptions"
                />
                <a-select
                  v-if="hasMultipleTargets(draft.Router.longContext)"
                  v-model:value="draft.Router.longContext.strategy"
                  class="route-strategy-select"
                  :options="strategyOptions"
                />
              </div>
            </a-form-item>
          </div>
          <div class="route-rule-item">
            <a-form-item label="Image 模型 ID">
              <a-input v-model:value="draft.Router.image.model" />
            </a-form-item>
            <a-form-item label="Image">
              <div class="route-target-row">
                <a-select
                  v-model:value="draft.Router.image.targets"
                  mode="multiple"
                  show-search
                  allow-clear
                  :options="routeOptions"
                />
                <a-select
                  v-if="hasMultipleTargets(draft.Router.image)"
                  v-model:value="draft.Router.image.strategy"
                  class="route-strategy-select"
                  :options="strategyOptions"
                />
              </div>
            </a-form-item>
          </div>
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

    <a-card class="tool-card">
      <template #title>并发控制</template>
      <a-form layout="vertical">
        <div class="form-grid">
          <a-form-item label="启用排队">
            <a-switch v-model:checked="draft.Concurrency.enabled" />
          </a-form-item>
          <a-form-item label="全局最大并发">
            <a-input-number v-model:value="draft.Concurrency.maxConcurrent" :min="1" :max="64" class="full-input" />
          </a-form-item>
          <a-form-item label="单 Provider 最大并发">
            <a-input-number
              v-model:value="draft.Concurrency.maxConcurrentPerProvider"
              :min="1"
              :max="32"
              class="full-input"
            />
          </a-form-item>
          <a-form-item label="最大排队数">
            <a-input-number
              v-model:value="draft.Concurrency.maxQueueSize"
              :min="1"
              :max="10000"
              class="full-input"
            />
          </a-form-item>
          <a-form-item label="队列超时 ms">
            <a-input-number
              v-model:value="draft.Concurrency.queueTimeoutMs"
              :min="1000"
              :step="1000"
              class="full-input"
            />
          </a-form-item>
        </div>
      </a-form>
    </a-card>
  </section>
</template>
