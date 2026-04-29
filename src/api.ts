import type { AppConfig, RequestRecord, StatsSummary } from './types'
import { getApiUrl, initApiBaseUrl } from './desktop'

export interface CodexAuthFile {
  id: string
  fileName: string
  path: string
  label: string
  email: string
  accountId: string
  planType: string
  expired: string
  enabled: boolean
  hasToken: boolean
  size: number
  updatedAt: string
  usage?: CodexUsage
  usageError?: string
}

export interface CodexUsageWindow {
  usedPercent: number
  remainingPercent: number
  limitWindowSeconds: number
  resetAfterSeconds: number
  resetAt: string
}

export interface CodexUsage {
  allowed: boolean
  limitReached: boolean
  planType: string
  fiveHour?: CodexUsageWindow
  weekly?: CodexUsageWindow
  credits?: {
    hasCredits: boolean
    unlimited: boolean
    overageLimitReached: boolean
    balance: string
  }
  updatedAt: string
}

export interface CodexAuthListPayload {
  dataDir: string
  authDir: string
  auths: CodexAuthFile[]
}

export interface CodexAuthExportFile {
  fileName: string
  content: string
}

export interface CodexOAuthSession {
  id: string
  status: 'pending' | 'complete' | 'error'
  verificationUrl: string
  userCode: string
  intervalMs: number
  expiresAt: string
  authFile?: CodexAuthFile
  error?: string
}

export interface HealthPayload {
  ok: boolean
  configured: {
    host: string
    port: number
  }
  runtime: {
    host: string
    port: number
  }
  dataDir: string
  settingsPath: string
  databasePath: string
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  await initApiBaseUrl()

  const response = await fetch(getApiUrl(url), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => undefined)
    const message = payload?.error?.message ?? response.statusText
    throw new Error(message)
  }

  return (await response.json()) as T
}

export function getConfig() {
  return apiFetch<AppConfig>('/api/config')
}

export function getHealth() {
  return apiFetch<HealthPayload>('/api/health')
}

export function saveConfig(config: AppConfig) {
  return apiFetch<AppConfig>('/api/config', {
    method: 'PUT',
    body: JSON.stringify(config),
  })
}

export function importConfig(config: AppConfig) {
  return apiFetch<AppConfig>('/api/config/import', {
    method: 'POST',
    body: JSON.stringify(config),
  })
}

export async function exportConfig() {
  await initApiBaseUrl()

  const response = await fetch(getApiUrl('/api/config/export'))
  if (!response.ok) {
    throw new Error(response.statusText)
  }
  return response.blob()
}

export function getStatsSummary() {
  return apiFetch<StatsSummary>('/api/stats/summary')
}

export function getRecentRequests(limit = 200, range?: { start?: string; end?: string }) {
  const params = new URLSearchParams({ limit: String(limit) })
  if (range?.start) {
    params.set('start', range.start)
  }
  if (range?.end) {
    params.set('end', range.end)
  }
  return apiFetch<RequestRecord[]>(`/api/stats/requests?${params.toString()}`)
}

export function resetStats() {
  return apiFetch<{ deleted: number }>('/api/stats/requests', {
    method: 'DELETE',
  })
}

export function deleteRequestRecord(id: string) {
  return apiFetch<{ deleted: number }>(`/api/stats/requests/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export function deleteModelStats(input: { provider: string; model: string; targetModel: string }) {
  return apiFetch<{ deleted: number }>('/api/stats/models', {
    method: 'DELETE',
    body: JSON.stringify(input),
  })
}

export function getCodexAuthFiles() {
  return apiFetch<CodexAuthListPayload>('/api/codex/auths')
}

export function uploadCodexAuthFile(input: { fileName: string; content: string }) {
  return apiFetch<CodexAuthFile>('/api/codex/auths', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateCodexAuthFile(id: string, input: { enabled?: boolean; label?: string }) {
  return apiFetch<CodexAuthFile>(`/api/codex/auths/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  })
}

export function refreshCodexAuthUsage(id: string) {
  return apiFetch<CodexAuthFile>(`/api/codex/auths/${encodeURIComponent(id)}/usage`, {
    method: 'POST',
  })
}

export function exportCodexAuthFile(id: string) {
  return apiFetch<CodexAuthExportFile>(`/api/codex/auths/${encodeURIComponent(id)}/export`)
}

export function exportCodexAuthFiles(ids: string[]) {
  return apiFetch<{ files: CodexAuthExportFile[] }>('/api/codex/auths/export', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}

export function deleteCodexAuthFile(id: string) {
  return apiFetch<{ deleted: number }>(`/api/codex/auths/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export function startCodexOAuthLogin() {
  return apiFetch<CodexOAuthSession>('/api/codex/oauth/start', {
    method: 'POST',
  })
}

export function pollCodexOAuthLogin(id: string) {
  return apiFetch<CodexOAuthSession>(`/api/codex/oauth/${encodeURIComponent(id)}`)
}
