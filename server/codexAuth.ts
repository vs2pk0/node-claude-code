import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { storage } from './storage.js'
import type { CodexConfig } from './types.js'

type JsonRecord = Record<string, unknown>

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

export interface CodexCredential {
  token: string
  label: string
  accountId: string
}

export interface CodexAuthExportFile {
  fileName: string
  content: string
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

const codexAuthCursorByDir = new Map<string, number>()
const codexAuthCacheByDir = new Map<string, { signature: string; candidates: CodexAuthCandidate[] }>()
const codexUsageUrl = 'https://chatgpt.com/backend-api/wham/usage'

interface CodexAuthCandidate {
  auth: CodexAuthFile
  token: string
}

export function listCodexAuthFiles(codex: CodexConfig): CodexAuthFile[] {
  return getCachedCodexAuthCandidates(codex).map((item) => item.auth)
}

export async function listCodexAuthFilesWithUsage(codex: CodexConfig): Promise<CodexAuthFile[]> {
  const auths = listCodexAuthFiles(codex)
  return Promise.all(auths.map((auth) => enrichCodexAuthUsage(codex, auth)))
}

export async function refreshCodexAuthUsage(codex: CodexConfig, id: string): Promise<CodexAuthFile> {
  const { fileName } = resolveAuthFileById(codex, id)
  const auth = readCodexAuthFile(codex, fileName)
  if (!auth) {
    throw httpError(404, '认证文件不存在')
  }
  return enrichCodexAuthUsage(codex, auth)
}

export function saveCodexAuthFile(codex: CodexConfig, input: { fileName: string; content: string }) {
  const parsed = parseAuthMetadata(input.content)
  const token = readCodexToken(parsed)
  if (!token) {
    throw httpError(400, '认证文件缺少 access_token 或 token_data.access_token')
  }

  const dir = ensureCodexAuthDir(codex)
  const fileName = uniqueFileName(dir, sanitizeFileName(input.fileName || authFileNameFromMetadata(parsed)))
  const targetPath = path.join(dir, fileName)
  const nextMetadata = {
    ...parsed,
    type: 'codex',
    disabled: parsed.disabled === true,
  }

  fs.writeFileSync(targetPath, `${JSON.stringify(nextMetadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  invalidateCodexAuthCache(codex)
  return readCodexAuthFile(codex, fileName)
}

export function updateCodexAuthFile(codex: CodexConfig, id: string, input: { enabled?: boolean; label?: string }) {
  const { fileName, fullPath } = resolveAuthFileById(codex, id)
  const metadata = readMetadataFile(fullPath)

  if (typeof input.enabled === 'boolean') {
    metadata.disabled = !input.enabled
  }
  if (typeof input.label === 'string') {
    metadata.label = input.label.trim()
  }

  fs.writeFileSync(fullPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  invalidateCodexAuthCache(codex)
  return readCodexAuthFile(codex, fileName)
}

export function deleteCodexAuthFile(codex: CodexConfig, id: string) {
  const { fullPath } = resolveAuthFileById(codex, id)
  fs.rmSync(fullPath, { force: true })
  invalidateCodexAuthCache(codex)
  return { deleted: 1 }
}

export function exportCodexAuthFile(codex: CodexConfig, id: string): CodexAuthExportFile {
  const { fileName, fullPath } = resolveAuthFileById(codex, id)
  return {
    fileName,
    content: fs.readFileSync(fullPath, 'utf8'),
  }
}

export function exportCodexAuthFiles(codex: CodexConfig, ids: string[]): CodexAuthExportFile[] {
  return ids.map((id) => exportCodexAuthFile(codex, id))
}

export function selectCodexCredential(codex: CodexConfig): CodexCredential {
  const directToken = codex.apiKey.trim()
  if (directToken) {
    return {
      token: directToken,
      label: 'codex-api-key',
      accountId: codex.accountId.trim(),
    }
  }

  const candidates = getCachedCodexAuthCandidates(codex).filter((item) => item.auth.enabled && item.auth.hasToken)
  if (candidates.length) {
    const dir = resolveCodexAuthDir(codex)
    const cursor = codexAuthCursorByDir.get(dir) ?? 0
    const candidate = candidates[cursor % candidates.length]
    const auth = candidate.auth
    codexAuthCursorByDir.set(dir, (cursor + 1) % candidates.length)
    if (candidate.token) {
      return {
        token: candidate.token,
        label: auth.label || auth.fileName,
        accountId: codex.accountId.trim() || auth.accountId,
      }
    }
  }

  const legacy = readLegacyCodexCredential(codex)
  if (legacy) {
    return legacy
  }

  throw httpError(400, '未找到可用的 Codex 认证账号，请上传并启用认证文件')
}

export function resolveCodexAuthDir(codex: Pick<CodexConfig, 'authDirectory'>) {
  const configured = codex.authDirectory.trim() || 'codex-auths'
  if (configured === '~') {
    return os.homedir()
  }
  if (configured.startsWith('~/')) {
    return path.join(os.homedir(), configured.slice(2))
  }
  if (path.isAbsolute(configured)) {
    return configured
  }
  return path.resolve(storage.dataDir, configured)
}

export function readCodexToken(metadata: JsonRecord) {
  const tokenData = asRecord(metadata.token_data)
  const token = asRecord(metadata.token)
  return (
    readString(metadata.access_token) ||
    readString(tokenData.access_token) ||
    readString(token.access_token) ||
    readString(metadata.id_token) ||
    readString(tokenData.id_token) ||
    readString(token.id_token)
  )
}

async function enrichCodexAuthUsage(codex: CodexConfig, auth: CodexAuthFile): Promise<CodexAuthFile> {
  if (!auth.enabled || !auth.hasToken) {
    return auth
  }

  try {
    const metadata = readMetadataFile(auth.path)
    const usage = await fetchCodexUsage(codex, metadata, auth.accountId)
    return {
      ...auth,
      planType: usage.planType || auth.planType,
      usage,
    }
  } catch (error) {
    return {
      ...auth,
      usageError: error instanceof Error ? error.message : String(error),
    }
  }
}

async function fetchCodexUsage(codex: CodexConfig, metadata: JsonRecord, fallbackAccountId: string): Promise<CodexUsage> {
  const token = readCodexToken(metadata)
  if (!token) {
    throw new Error('缺少 access_token')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch(codexUsageUrl, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        'chatgpt-account-id': readAccountId(metadata) || fallbackAccountId,
        'user-agent': codex.userAgent.trim() || 'codex-tui/0.118.0',
      },
    })
    const text = await response.text()
    const payload = safeJson(text)
    if (!response.ok) {
      const message =
        readString(asRecord(payload.error).message) ||
        readString(payload.error) ||
        text.trim() ||
        `HTTP ${response.status}`
      throw new Error(`额度查询失败：${message}`)
    }

    return normalizeCodexUsage(payload)
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeCodexUsage(payload: JsonRecord): CodexUsage {
  const rateLimit = asRecord(payload.rate_limit)
  const primary = normalizeUsageWindow(asRecord(rateLimit.primary_window))
  const secondary = normalizeUsageWindow(asRecord(rateLimit.secondary_window))
  const windows = [primary, secondary].filter((item): item is CodexUsageWindow => Boolean(item))
  const fiveHour = windows.find((item) => item.limitWindowSeconds > 0 && item.limitWindowSeconds <= 18_000)
  const weekly = windows.find((item) => item.limitWindowSeconds >= 604_800)
  const credits = asRecord(payload.credits)

  return {
    allowed: readBoolean(rateLimit.allowed),
    limitReached: readBoolean(rateLimit.limit_reached),
    planType: readString(payload.plan_type),
    fiveHour,
    weekly,
    credits: {
      hasCredits: readBoolean(credits.has_credits),
      unlimited: readBoolean(credits.unlimited),
      overageLimitReached: readBoolean(credits.overage_limit_reached),
      balance: readString(credits.balance),
    },
    updatedAt: new Date().toISOString(),
  }
}

function normalizeUsageWindow(window: JsonRecord): CodexUsageWindow | undefined {
  const limitWindowSeconds = readNumber(window.limit_window_seconds)
  if (!limitWindowSeconds) {
    return undefined
  }

  const usedPercent = clampPercent(readNumber(window.used_percent))
  const resetAtSeconds = readNumber(window.reset_at)
  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    limitWindowSeconds,
    resetAfterSeconds: readNumber(window.reset_after_seconds),
    resetAt: resetAtSeconds ? new Date(resetAtSeconds * 1000).toISOString() : '',
  }
}

function ensureCodexAuthDir(codex: CodexConfig) {
  const dir = resolveCodexAuthDir(codex)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function readCodexAuthFile(codex: CodexConfig, fileName: string): CodexAuthFile | undefined {
  return readCodexAuthCandidate(codex, fileName)?.auth
}

function getCachedCodexAuthCandidates(codex: CodexConfig): CodexAuthCandidate[] {
  const dir = resolveCodexAuthDir(codex)
  const snapshot = readCodexAuthDirSnapshot(dir)
  const cached = codexAuthCacheByDir.get(dir)
  if (cached && cached.signature === snapshot.signature) {
    return cached.candidates
  }

  const candidates = snapshot.fileNames
    .map((fileName) => readCodexAuthCandidate(codex, fileName))
    .filter((item): item is CodexAuthCandidate => Boolean(item))
    .sort((left, right) => left.auth.fileName.localeCompare(right.auth.fileName))

  codexAuthCacheByDir.set(dir, {
    signature: snapshot.signature,
    candidates,
  })
  return candidates
}

function readCodexAuthDirSnapshot(dir: string) {
  if (!fs.existsSync(dir)) {
    return {
      signature: 'missing',
      fileNames: [] as string[],
    }
  }

  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => {
      try {
        const stat = fs.statSync(path.join(dir, entry.name))
        return {
          fileName: entry.name,
          signature: `${entry.name}:${stat.size}:${stat.mtimeMs}`,
        }
      } catch {
        return undefined
      }
    })
    .filter((item): item is { fileName: string; signature: string } => Boolean(item))
    .sort((left, right) => left.fileName.localeCompare(right.fileName))

  return {
    signature: files.map((item) => item.signature).join('|'),
    fileNames: files.map((item) => item.fileName),
  }
}

function invalidateCodexAuthCache(codex: CodexConfig) {
  codexAuthCacheByDir.delete(resolveCodexAuthDir(codex))
}

function readCodexAuthCandidate(codex: CodexConfig, fileName: string): CodexAuthCandidate | undefined {
  const dir = resolveCodexAuthDir(codex)
  const fullPath = path.join(dir, fileName)
  try {
    const metadata = readMetadataFile(fullPath)
    const stat = fs.statSync(fullPath)
    const token = readCodexToken(metadata)
    const accountId =
      readAccountId(metadata)
    const planType =
      readString(metadata.plan_type) ||
      readString(asRecord(metadata.token_data).plan_type) ||
      readString(asRecord(metadata.codex_auth_info).chatgpt_plan_type) ||
      inferPlanTypeFromFileName(fileName)
    const email = readString(metadata.email) || readString(asRecord(metadata.user).email)
    const expired = readString(metadata.expired) || readString(asRecord(metadata.token_data).expire)
    const label = readString(metadata.label) || email || accountId || fileName

    return {
      auth: {
        id: fileName,
        fileName,
        path: fullPath,
        label,
        email,
        accountId,
        planType,
        expired,
        enabled: metadata.disabled !== true,
        hasToken: Boolean(token),
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
      },
      token,
    }
  } catch {
    return undefined
  }
}

function readAccountId(metadata: JsonRecord) {
  return (
    readString(metadata.account_id) ||
    readString(asRecord(metadata.token_data).account_id) ||
    readString(asRecord(metadata.codex_auth_info).chatgpt_account_id)
  )
}

function inferPlanTypeFromFileName(fileName: string) {
  const normalized = fileName.toLowerCase()
  for (const plan of ['plus', 'pro', 'team', 'business', 'free']) {
    if (normalized.includes(`-${plan}`) || normalized.includes(`_${plan}`)) {
      return plan
    }
  }
  return ''
}

function readLegacyCodexCredential(codex: CodexConfig): CodexCredential | undefined {
  const authFilePath = codex.authFilePath.trim()
  if (!authFilePath) {
    return undefined
  }

  const resolvedPath = resolvePath(authFilePath)
  const metadata = readMetadataFile(resolvedPath)
  const token = readCodexToken(metadata)
  if (!token) {
    throw httpError(400, `Codex auth 文件缺少 access_token: ${resolvedPath}`)
  }

  const tokenData = asRecord(metadata.token_data)
  return {
    token,
    label: path.basename(resolvedPath),
    accountId: codex.accountId.trim() || readString(metadata.account_id) || readString(tokenData.account_id),
  }
}

function resolveAuthFileById(codex: CodexConfig, id: string) {
  const fileName = path.basename(id)
  if (!fileName || fileName !== id) {
    throw httpError(400, '认证文件名非法')
  }

  const fullPath = path.join(resolveCodexAuthDir(codex), fileName)
  if (!fs.existsSync(fullPath)) {
    throw httpError(404, '认证文件不存在')
  }
  return { fileName, fullPath }
}

function readMetadataFile(filePath: string) {
  return parseAuthMetadata(fs.readFileSync(filePath, 'utf8'))
}

function parseAuthMetadata(content: string) {
  const parsed = JSON.parse(content) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw httpError(400, '认证文件必须是 JSON 对象')
  }
  return parsed as JsonRecord
}

function authFileNameFromMetadata(metadata: JsonRecord) {
  const email = readString(metadata.email) || readString(asRecord(metadata.user).email)
  const accountId = readString(metadata.account_id) || readString(asRecord(metadata.token_data).account_id)
  return `codex-${email || accountId || Date.now()}.json`
}

function sanitizeFileName(value: string) {
  const baseName = path.basename(value.trim() || 'codex-auth.json')
  const normalized = baseName
    .replace(/[^a-z0-9._@+-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    || 'codex-auth.json'
  return normalized.toLowerCase().endsWith('.json') ? normalized : `${normalized}.json`
}

function uniqueFileName(dir: string, fileName: string) {
  const ext = path.extname(fileName) || '.json'
  const stem = path.basename(fileName, ext)
  let candidate = fileName
  let index = 2

  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}-${index}${ext}`
    index += 1
  }

  return candidate
}

function resolvePath(value: string) {
  if (value === '~') {
    return os.homedir()
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(2))
  }
  if (path.isAbsolute(value)) {
    return value
  }
  return path.resolve(storage.dataDir, value)
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function safeJson(text: string): JsonRecord {
  try {
    return asRecord(JSON.parse(text))
  } catch {
    return {}
  }
}

function readString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function readBoolean(value: unknown) {
  return value === true || value === 'true'
}

function clampPercent(value: number) {
  return Math.min(100, Math.max(0, Math.round(value)))
}

function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number }
  error.status = status
  return error
}
