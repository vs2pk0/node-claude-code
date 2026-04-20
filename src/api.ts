import type { AppConfig, RequestRecord, StatsSummary } from './types'

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
  const response = await fetch(url, {
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
  const response = await fetch('/api/config/export')
  if (!response.ok) {
    throw new Error(response.statusText)
  }
  return response.blob()
}

export function getStatsSummary() {
  return apiFetch<StatsSummary>('/api/stats/summary')
}

export function getRecentRequests(limit = 80) {
  return apiFetch<RequestRecord[]>(`/api/stats/requests?limit=${limit}`)
}
