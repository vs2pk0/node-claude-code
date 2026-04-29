<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { UploadProps } from 'ant-design-vue'
import {
  ApiOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  LoginOutlined,
  PlusOutlined,
  ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import {
  deleteCodexAuthFile,
  exportCodexAuthFile,
  exportCodexAuthFiles,
  getCodexAuthFiles,
  pollCodexOAuthLogin,
  refreshCodexAuthUsage,
  startCodexOAuthLogin,
  updateCodexAuthFile,
  uploadCodexAuthFile,
  type CodexAuthFile,
  type CodexAuthExportFile,
  type CodexOAuthSession,
  type CodexUsageWindow,
} from '@/api'
import { useAppState } from '@/composables/useAppState'
import { isDesktopApp, openExternalUrl, restartDesktopService, saveDesktopExportFile } from '@/desktop'
import { readError } from '@/utils/format'

const { draft, originUrl } = useAppState()
const headersText = ref('{}')
const authFiles = ref<CodexAuthFile[]>([])
const authDataDir = ref('')
const authLoading = ref(false)
const authUploading = ref(false)
const activeTab = ref('oauth')
const oauthSession = ref<CodexOAuthSession>()
const oauthLoading = ref(false)
const quotaRefreshingIds = ref(new Set<string>())
const selectedAuthIds = ref(new Set<string>())
const exportingAuthIds = ref(new Set<string>())
const batchExporting = ref(false)
let oauthTimer: number | undefined

const codex = computed(() => draft.value?.Codex)
const endpoints = computed(() => {
  const origin = originUrl.value || (draft.value ? `http://${draft.value.HOST}:${draft.value.PORT}` : '')
  return {
    responses: origin ? `${origin}/backend-api/codex/responses` : '',
    compact: origin ? `${origin}/backend-api/codex/responses/compact` : '',
    openaiResponses: origin ? `${origin}/v1/responses` : '',
  }
})

watch(
  () => codex.value?.headers,
  (headers) => {
    headersText.value = JSON.stringify(headers ?? {}, null, 2)
  },
  { immediate: true, deep: true },
)

onMounted(loadCodexAuthFiles)
onBeforeUnmount(stopOAuthPolling)

const enabledAuthCount = computed(() => authFiles.value.filter((auth) => auth.enabled && auth.hasToken).length)
const selectedAuthCount = computed(() => selectedAuthIds.value.size)
const allAuthsSelected = computed(() => Boolean(authFiles.value.length) && selectedAuthIds.value.size === authFiles.value.length)

const beforeAuthUpload: UploadProps['beforeUpload'] = async (file) => {
  authUploading.value = true
  try {
    await uploadCodexAuthFile({
      fileName: file.name,
      content: await file.text(),
    })
    message.success('Codex 认证文件已上传')
    await loadCodexAuthFiles()
  } catch (error) {
    message.error(readError(error))
  } finally {
    authUploading.value = false
  }

  return false
}

async function loadCodexAuthFiles() {
  authLoading.value = true
  try {
    const payload = await getCodexAuthFiles()
    authFiles.value = payload.auths
    authDataDir.value = payload.authDir || payload.dataDir
    pruneSelectedAuths(payload.auths)
  } catch (error) {
    message.error(readError(error))
  } finally {
    authLoading.value = false
  }
}

function pruneSelectedAuths(auths: CodexAuthFile[]) {
  const ids = new Set(auths.map((auth) => auth.id))
  selectedAuthIds.value = new Set(Array.from(selectedAuthIds.value).filter((id) => ids.has(id)))
}

async function startOAuthLogin() {
  oauthLoading.value = true
  stopOAuthPolling()
  try {
    oauthSession.value = await startOAuthLoginWithServiceRefresh()
    const opened = await openOAuthPage()
    startOAuthPolling()
    message.success(opened ? '已打开 Codex OAuth 授权页面，请在浏览器完成登录' : '已创建 Codex OAuth 登录，请手动点击打开授权页面')
  } catch (error) {
    message.error(readError(error))
  } finally {
    oauthLoading.value = false
  }
}

async function startOAuthLoginWithServiceRefresh() {
  try {
    return await startCodexOAuthLogin()
  } catch (error) {
    if (!isDesktopApp() || !isNotFoundError(error)) {
      throw error
    }

    message.info('检测到本地服务缺少 OAuth 接口，正在重启服务后重试')
    await restartDesktopService()
    try {
      return await startCodexOAuthLogin()
    } catch (retryError) {
      if (isNotFoundError(retryError)) {
        throw new Error('本地服务仍缺少 OAuth 接口，请退出旧版 Node Claude Code 后打开最新打包的应用')
      }
      throw retryError
    }
  }
}

function startOAuthPolling() {
  stopOAuthPolling()
  const interval = Math.max(3000, oauthSession.value?.intervalMs ?? 5000)
  oauthTimer = window.setInterval(pollOAuthLogin, interval)
}

function stopOAuthPolling() {
  if (!oauthTimer) {
    return
  }
  window.clearInterval(oauthTimer)
  oauthTimer = undefined
}

async function pollOAuthLogin() {
  const session = oauthSession.value
  if (!session || session.status !== 'pending') {
    stopOAuthPolling()
    return
  }

  try {
    oauthSession.value = await pollCodexOAuthLogin(session.id)
    if (oauthSession.value.status === 'complete') {
      stopOAuthPolling()
      await loadCodexAuthFiles()
      activeTab.value = 'auths'
      message.success('Codex OAuth 登录完成，认证文件已保存')
    }
    if (oauthSession.value.status === 'error') {
      stopOAuthPolling()
      message.error(oauthSession.value.error || 'Codex OAuth 登录失败')
    }
  } catch (error) {
    stopOAuthPolling()
    message.error(readError(error))
  }
}

async function openOAuthPage() {
  const url = oauthSession.value?.verificationUrl
  if (!url) {
    return false
  }

  try {
    await openExternalUrl(url)
    return true
  } catch (error) {
    message.error(readError(error))
    return false
  }
}

async function copyUserCode() {
  const code = oauthSession.value?.userCode
  if (!code) {
    return
  }
  await navigator.clipboard.writeText(code)
  message.success('授权码已复制')
}

async function toggleAuth(auth: CodexAuthFile, enabled: boolean) {
  try {
    await updateCodexAuthFile(auth.id, { enabled })
    await loadCodexAuthFiles()
    message.success(enabled ? '认证账号已启用' : '认证账号已停用')
  } catch (error) {
    message.error(readError(error))
  }
}

async function handleAuthSwitch(auth: CodexAuthFile, checked: boolean) {
  await toggleAuth(auth, checked)
}

async function removeAuth(auth: CodexAuthFile) {
  try {
    await deleteCodexAuthFile(auth.id)
    const nextIds = new Set(selectedAuthIds.value)
    nextIds.delete(auth.id)
    selectedAuthIds.value = nextIds
    await loadCodexAuthFiles()
    message.success('认证文件已删除')
  } catch (error) {
    message.error(readError(error))
  }
}

function toggleAuthSelection(id: string) {
  const nextIds = new Set(selectedAuthIds.value)
  if (nextIds.has(id)) {
    nextIds.delete(id)
  } else {
    nextIds.add(id)
  }
  selectedAuthIds.value = nextIds
}

function toggleAllAuthSelections() {
  selectedAuthIds.value = allAuthsSelected.value
    ? new Set()
    : new Set(authFiles.value.map((auth) => auth.id))
}

async function exportAuth(auth: CodexAuthFile) {
  const nextIds = new Set(exportingAuthIds.value)
  nextIds.add(auth.id)
  exportingAuthIds.value = nextIds
  try {
    const saved = await saveAuthExportFile(await exportCodexAuthFile(auth.id))
    if (saved) {
      message.success(`已导出 ${auth.fileName}`)
    }
  } catch (error) {
    message.error(readError(error))
  } finally {
    const remainingIds = new Set(exportingAuthIds.value)
    remainingIds.delete(auth.id)
    exportingAuthIds.value = remainingIds
  }
}

async function exportSelectedAuths() {
  if (!selectedAuthIds.value.size) {
    message.warning('请先选择要导出的认证文件')
    return
  }

  batchExporting.value = true
  try {
    const { files } = await exportCodexAuthFiles(Array.from(selectedAuthIds.value))
    let savedCount = 0
    for (const file of files) {
      if (await saveAuthExportFile(file)) {
        savedCount += 1
      }
    }
    if (savedCount) {
      message.success(`已导出 ${savedCount} 个认证 JSON`)
    }
  } catch (error) {
    message.error(readError(error))
  } finally {
    batchExporting.value = false
  }
}

async function saveAuthExportFile(file: CodexAuthExportFile) {
  if (isDesktopApp()) {
    return Boolean(await saveDesktopExportFile(normalizeJsonContent(file.content), file.fileName))
  }

  downloadText(file.fileName, normalizeJsonContent(file.content))
  return true
}

async function refreshAuthUsage(auth: CodexAuthFile) {
  const nextIds = new Set(quotaRefreshingIds.value)
  nextIds.add(auth.id)
  quotaRefreshingIds.value = nextIds
  try {
    const nextAuth = await refreshCodexAuthUsage(auth.id)
    const index = authFiles.value.findIndex((item) => item.id === auth.id)
    if (index >= 0) {
      authFiles.value.splice(index, 1, nextAuth)
    }
    message.success('额度已刷新')
  } catch (error) {
    message.error(readError(error))
  } finally {
    const remainingIds = new Set(quotaRefreshingIds.value)
    remainingIds.delete(auth.id)
    quotaRefreshingIds.value = remainingIds
  }
}

function applyHeaders() {
  if (!codex.value) {
    return
  }

  const parsed = JSON.parse(headersText.value) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Headers 必须是 JSON 对象')
  }

  codex.value.headers = Object.fromEntries(
    Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  message.success('Codex Headers 已应用，记得保存配置')
}

function safeApplyHeaders() {
  try {
    applyHeaders()
  } catch (error) {
    message.error(error instanceof Error ? error.message : String(error))
  }
}

function addModel() {
  codex.value?.models.push({
    name: 'gpt-5-codex',
    alias: 'gpt-5-codex',
  })
}

function removeModel(index: number) {
  const models = codex.value?.models
  if (!models) {
    return
  }

  if (models.length <= 1) {
    models.splice(0, 1, {
      name: 'gpt-5-codex',
      alias: 'gpt-5-codex',
    })
    return
  }

  models.splice(index, 1)
}

function formatSize(size: number) {
  if (size < 1024) {
    return `${size} B`
  }
  return `${(size / 1024).toFixed(2)} KB`
}

function formatTime(value: string) {
  return value ? new Date(value).toLocaleString() : '-'
}

function formatResetTime(window?: CodexUsageWindow) {
  return window?.resetAt ? formatTime(window.resetAt) : '-'
}

function quotaPercent(window?: CodexUsageWindow) {
  return Math.round(window?.remainingPercent ?? 0)
}

function quotaProgressStatus(window?: CodexUsageWindow) {
  const percent = quotaPercent(window)
  if (percent <= 10) {
    return 'exception'
  }
  return percent <= 30 ? 'normal' : 'success'
}

function isNotFoundError(error: unknown) {
  return error instanceof Error && /not found|cannot\s+\w+\s+/i.test(error.message)
}

function normalizeJsonContent(content: string) {
  try {
    return `${JSON.stringify(JSON.parse(content), null, 2)}\n`
  } catch {
    return content.endsWith('\n') ? content : `${content}\n`
  }
}

function downloadText(fileName: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
</script>

<template>
  <section v-if="draft && codex" class="panel codex-panel">
    <a-card class="tool-card codex-hero-card">
      <template #title>
        <span class="card-title-with-help">
          <ApiOutlined />
          Codex 代理
        </span>
      </template>
      <a-alert
        type="info"
        show-icon
        message="兼容 Codex CLI 的 Responses 代理"
        description="启用后会把 /backend-api/codex/responses 与 /v1/responses 转发到 ChatGPT Codex 后端；反代会优先使用直接 API Key，否则从启用的认证文件池中轮询选择账号。"
      />
      <div class="codex-switch-row">
        <span>启用 Codex 代理</span>
        <a-switch v-model:checked="codex.enabled" />
      </div>
      <div class="codex-endpoint-grid">
        <div>
          <span>Codex Responses</span>
          <code :title="endpoints.responses">{{ endpoints.responses }}</code>
        </div>
        <div>
          <span>Codex Compact</span>
          <code :title="endpoints.compact">{{ endpoints.compact }}</code>
        </div>
        <div>
          <span>OpenAI Responses 兼容入口</span>
          <code :title="endpoints.openaiResponses">{{ endpoints.openaiResponses }}</code>
        </div>
      </div>
      <a-alert
        :type="enabledAuthCount ? 'success' : 'warning'"
        show-icon
        :message="enabledAuthCount ? `可用 Codex 认证账号：${enabledAuthCount} 个` : '还没有可用的 Codex 认证账号'"
        :description="enabledAuthCount ? '代理请求会在已启用账号之间按顺序轮询。' : '请上传包含 access_token 或 token_data.access_token 的 Codex JSON 认证文件，或填写直接 API Key。'"
      />
    </a-card>

    <a-card class="tool-card codex-tabs-card">
      <a-tabs v-model:activeKey="activeTab">
        <a-tab-pane key="oauth" tab="OAuth 登录">
          <div class="codex-oauth-panel">
            <div>
              <h3><LoginOutlined /> Codex OAuth</h3>
              <p>通过 OpenAI 浏览器 OAuth 登录 Codex，完成后会自动生成认证 JSON 并加入账号池。</p>
            </div>
            <div class="codex-oauth-actions">
              <a-button type="primary" size="large" :loading="oauthLoading" @click="startOAuthLogin">
                开始 Codex 登录
              </a-button>
            </div>
          </div>
          <a-card v-if="oauthSession" class="codex-oauth-session">
            <template #title>登录会话</template>
            <a-alert
              :type="oauthSession.status === 'complete' ? 'success' : oauthSession.status === 'error' ? 'error' : 'info'"
              show-icon
              :message="oauthSession.status === 'complete' ? '登录完成' : oauthSession.status === 'error' ? '登录失败' : '等待授权'"
              :description="oauthSession.status === 'pending' ? '请在打开的 OpenAI 授权页面完成登录，浏览器回调成功后会自动保存认证文件。' : oauthSession.error || '认证文件已保存。'"
            />
            <div class="codex-oauth-code">
              <template v-if="oauthSession.userCode">
                <span>授权码</span>
                <strong>{{ oauthSession.userCode }}</strong>
              </template>
              <span v-else>授权方式</span>
              <strong v-if="!oauthSession.userCode">浏览器回调</strong>
              <a-button v-if="oauthSession.userCode" @click="copyUserCode">
                <template #icon><CopyOutlined /></template>
                复制
              </a-button>
              <a-button @click="openOAuthPage">打开授权页面</a-button>
            </div>
          </a-card>
        </a-tab-pane>

        <a-tab-pane key="auths" tab="认证文件">
          <div class="codex-tab-actions">
            <div class="codex-auth-summary">
              <span>认证目录</span>
              <code>{{ codex.authDirectory || 'codex-auths' }}</code>
              <small>实际路径：{{ authDataDir || 'loading' }}</small>
            </div>
            <div class="section-actions">
              <a-button :disabled="!authFiles.length" @click="toggleAllAuthSelections">
                {{ allAuthsSelected ? '取消全选' : '全选' }}
              </a-button>
              <a-button :disabled="!selectedAuthCount" :loading="batchExporting" @click="exportSelectedAuths">
                <template #icon><DownloadOutlined /></template>
                导出选中 {{ selectedAuthCount ? `(${selectedAuthCount})` : '' }}
              </a-button>
              <a-button :loading="authLoading" @click="loadCodexAuthFiles">
                <template #icon><ReloadOutlined /></template>
                刷新
              </a-button>
              <a-upload accept=".json,application/json" :show-upload-list="false" :before-upload="beforeAuthUpload">
                <a-button :loading="authUploading">
                  <template #icon><UploadOutlined /></template>
                  上传认证文件
                </a-button>
              </a-upload>
            </div>
          </div>
          <a-empty v-if="!authFiles.length" description="暂无 Codex 认证文件" />
          <div v-else class="codex-auth-grid">
            <article v-for="auth in authFiles" :key="auth.id" class="codex-auth-card" :class="{ 'is-disabled': !auth.enabled }">
              <div class="codex-auth-card-head">
                <div>
                  <input
                    class="codex-auth-checkbox"
                    type="checkbox"
                    :checked="selectedAuthIds.has(auth.id)"
                    :aria-label="`选择 ${auth.fileName}`"
                    @change="toggleAuthSelection(auth.id)"
                  />
                  <a-tag color="blue">Codex</a-tag>
                  <a-tag :color="auth.enabled && auth.hasToken ? 'green' : 'default'">
                    {{ auth.enabled && auth.hasToken ? '启用' : '停用' }}
                  </a-tag>
                  <a-tag v-if="auth.planType">{{ auth.planType }}</a-tag>
                </div>
                <a-switch size="small" :checked="auth.enabled" :disabled="!auth.hasToken" @change="(checked: boolean) => handleAuthSwitch(auth, checked)" />
              </div>
              <h3>{{ auth.label || auth.fileName }}</h3>
              <p>{{ auth.fileName }}</p>
              <dl>
                <div>
                  <dt>Email</dt>
                  <dd>{{ auth.email || '-' }}</dd>
                </div>
                <div>
                  <dt>Account ID</dt>
                  <dd>{{ auth.accountId || '-' }}</dd>
                </div>
                <div>
                  <dt>大小</dt>
                  <dd>{{ formatSize(auth.size) }}</dd>
                </div>
                <div>
                  <dt>修改时间</dt>
                  <dd>{{ formatTime(auth.updatedAt) }}</dd>
                </div>
                <div>
                  <dt>过期时间</dt>
                  <dd>{{ formatTime(auth.expired) }}</dd>
                </div>
              </dl>
              <a-alert v-if="!auth.hasToken" type="error" show-icon message="缺少 access_token，无法用于反代" />
              <a-alert v-else-if="auth.usageError" type="warning" show-icon :message="auth.usageError" />
              <div v-if="auth.usage" class="codex-quota-panel">
                <div class="codex-quota-plan">
                  <span>套餐</span>
                  <strong>{{ auth.usage.planType || auth.planType || '-' }}</strong>
                  <a-tag :color="auth.usage.allowed && !auth.usage.limitReached ? 'green' : 'orange'">
                    {{ auth.usage.allowed && !auth.usage.limitReached ? '额度可用' : '额度受限' }}
                  </a-tag>
                  <a-button
                    size="small"
                    :loading="quotaRefreshingIds.has(auth.id)"
                    @click="refreshAuthUsage(auth)"
                  >
                    <template #icon><ReloadOutlined /></template>
                    刷新额度
                  </a-button>
                </div>
                <div class="codex-quota-row">
                  <div class="codex-quota-title">
                    <span>5 小时额度</span>
                    <strong>{{ quotaPercent(auth.usage.fiveHour) }}%</strong>
                    <small>{{ formatResetTime(auth.usage.fiveHour) }}</small>
                  </div>
                  <a-progress
                    :percent="quotaPercent(auth.usage.fiveHour)"
                    :show-info="false"
                    :status="quotaProgressStatus(auth.usage.fiveHour)"
                  />
                </div>
                <div class="codex-quota-row">
                  <div class="codex-quota-title">
                    <span>周额度</span>
                    <strong>{{ quotaPercent(auth.usage.weekly) }}%</strong>
                    <small>{{ formatResetTime(auth.usage.weekly) }}</small>
                  </div>
                  <a-progress
                    :percent="quotaPercent(auth.usage.weekly)"
                    :show-info="false"
                    :status="quotaProgressStatus(auth.usage.weekly)"
                  />
                </div>
                <small class="codex-quota-updated">更新时间：{{ formatTime(auth.usage.updatedAt) }}</small>
              </div>
              <a-button
                v-else-if="auth.hasToken"
                size="small"
                :loading="quotaRefreshingIds.has(auth.id)"
                @click="refreshAuthUsage(auth)"
              >
                <template #icon><ReloadOutlined /></template>
                刷新额度
              </a-button>
              <div class="codex-auth-actions">
                <a-button size="small" :loading="exportingAuthIds.has(auth.id)" @click="exportAuth(auth)">
                  <template #icon><DownloadOutlined /></template>
                  导出
                </a-button>
                <a-popconfirm title="确定删除这个认证文件？" ok-text="删除" cancel-text="取消" @confirm="removeAuth(auth)">
                  <a-button size="small" danger>
                    <template #icon><DeleteOutlined /></template>
                    删除
                  </a-button>
                </a-popconfirm>
              </div>
            </article>
          </div>
        </a-tab-pane>

        <a-tab-pane key="settings" tab="基础配置">
          <a-form layout="vertical">
            <div class="form-grid">
              <a-form-item label="Base URL">
                <a-input v-model:value="codex.baseUrl" />
              </a-form-item>
              <a-form-item label="User-Agent">
                <a-input v-model:value="codex.userAgent" />
              </a-form-item>
              <a-form-item label="Codex API Key">
                <a-input-password v-model:value="codex.apiKey" autocomplete="new-password" />
              </a-form-item>
              <a-form-item label="Auth File Path">
                <a-input v-model:value="codex.authFilePath" placeholder="兼容旧配置：例如 ~/.codex/auth.json" />
              </a-form-item>
              <a-form-item label="Auth Directory">
                <a-input v-model:value="codex.authDirectory" placeholder="默认 codex-auths，位于数据目录下" />
              </a-form-item>
              <a-form-item label="ChatGPT Account ID">
                <a-input v-model:value="codex.accountId" />
              </a-form-item>
              <a-form-item label="X-Codex-Beta-Features">
                <a-input v-model:value="codex.betaFeatures" />
              </a-form-item>
            </div>
          </a-form>
        </a-tab-pane>

        <a-tab-pane key="models" tab="模型与 Headers">
          <div class="codex-tab-stack">
            <section>
              <h3>模型映射</h3>
              <div class="codex-model-list">
                <div v-for="(model, index) in codex.models" :key="index" class="codex-model-row">
                  <a-input v-model:value="model.name" placeholder="上游模型，例如 gpt-5-codex" />
                  <a-input v-model:value="model.alias" placeholder="对外别名，例如 gpt-5-codex" />
                  <a-button class="row-delete-button" @click="removeModel(index)">
                    <template #icon><DeleteOutlined /></template>
                  </a-button>
                </div>
                <a-button class="model-row-add" @click="addModel">
                  <template #icon><PlusOutlined /></template>
                  添加模型
                </a-button>
              </div>
            </section>
            <section>
              <div class="codex-section-title-row">
                <h3>额外 Headers</h3>
                <a-button @click="safeApplyHeaders">应用 Headers</a-button>
              </div>
              <a-textarea v-model:value="headersText" class="json-editor" :rows="8" />
            </section>
          </div>
        </a-tab-pane>
      </a-tabs>
    </a-card>
  </section>
</template>
