import { invoke, isTauri } from '@tauri-apps/api/core'

const fallbackDesktopBaseUrl = 'http://127.0.0.1:4568'

let apiBaseUrl = ''
let initPromise: Promise<void> | undefined

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
      console.warn('[desktop] failed to resolve embedded service URL, fallback to default port', error)
      apiBaseUrl = fallbackDesktopBaseUrl
    }
  })()

  return initPromise
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

export async function restartDesktopService() {
  if (!isTauri()) {
    return null
  }

  const nextBaseUrl = normalizeBaseUrl(await invoke<string>('restart_embedded_service'))
  apiBaseUrl = nextBaseUrl
  initPromise = Promise.resolve()
  return nextBaseUrl
}

function normalizeBaseUrl(url: string) {
  return url.replace(/\/+$/, '')
}
