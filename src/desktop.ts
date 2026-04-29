import { invoke, isTauri } from '@tauri-apps/api/core'

let apiBaseUrl = ''
let initPromise: Promise<void> | undefined

export interface DesktopServiceStatus {
  running: boolean
  configured: {
    host: string
    port: number
  }
  runtime: {
    host: string
    port: number
  } | null
  dataDir: string
  settingsPath: string
  databasePath: string
}

export function isDesktopApp() {
  return isTauri()
}

export function getApiUrl(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`
  return apiBaseUrl ? `${apiBaseUrl}${normalizedPath}` : normalizedPath
}

export async function initApiBaseUrl() {
  if (initPromise) {
    return initPromise
  }

  initPromise = (async () => {
    if (!isTauri()) {
      apiBaseUrl = ''
      return
    }

    try {
      apiBaseUrl = normalizeBaseUrl(await invoke<string>('service_base_url'))
    } catch (error) {
      console.warn('[desktop] embedded service is not running yet', error)
      apiBaseUrl = ''
    }
  })()

  return initPromise
}

export async function getDesktopServiceStatus() {
  if (!isTauri()) {
    return null
  }

  return invoke<DesktopServiceStatus>('desktop_service_status')
}

export async function startDesktopService() {
  if (!isTauri()) {
    return null
  }

  const status = await invoke<DesktopServiceStatus>('start_embedded_service')
  syncBaseUrlFromStatus(status)
  return status
}

export async function stopDesktopService() {
  if (!isTauri()) {
    return null
  }

  const status = await invoke<DesktopServiceStatus>('stop_embedded_service_command')
  syncBaseUrlFromStatus(status)
  return status
}

export async function saveDesktopBootstrapConfig(host: string, port: number) {
  if (!isTauri()) {
    return null
  }

  return invoke<DesktopServiceStatus>('save_bootstrap_config', {
    host,
    port,
  })
}

export async function saveDesktopExportFile(content: string, fileName = 'settings.json') {
  if (!isTauri()) {
    return null
  }

  return invoke<string | null>('export_config_file', {
    content,
    fileName,
  })
}

export async function openDesktopConfigDirectory() {
  if (!isTauri()) {
    return null
  }

  return invoke<string>('open_config_dir')
}

export async function openExternalUrl(url: string) {
  if (!isTauri()) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }

  await invoke<void>('open_external_url', { url })
}

export async function restartDesktopService() {
  if (!isTauri()) {
    return null
  }

  const nextBaseUrl = normalizeBaseUrl(await invoke<string>('restart_embedded_service'))
  setDesktopApiBaseUrl(nextBaseUrl)
  return nextBaseUrl
}

export function setDesktopApiBaseUrl(url: string) {
  apiBaseUrl = normalizeBaseUrl(url)
  initPromise = Promise.resolve()
}

export function clearDesktopApiBaseUrl() {
  apiBaseUrl = ''
  initPromise = undefined
}

function syncBaseUrlFromStatus(status: DesktopServiceStatus | null) {
  if (status?.running && status.runtime) {
    setDesktopApiBaseUrl(`http://${status.runtime.host}:${status.runtime.port}`)
    return
  }

  clearDesktopApiBaseUrl()
}

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, '')
}
