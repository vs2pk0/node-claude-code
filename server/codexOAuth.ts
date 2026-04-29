import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { storage } from './storage.js'
import { saveCodexAuthFile } from './codexAuth.js'

type JsonRecord = Record<string, unknown>

interface CodexOAuthSession {
  id: string
  state: string
  codeVerifier: string
  verificationUrl: string
  intervalMs: number
  expiresAt: number
  createdAt: number
  status: 'pending' | 'complete' | 'error'
  server?: Server
  authFile?: unknown
  error?: string
}

const clientId = 'app_EMoamEEZ73f0CkXaXp7hrann'
const authUrl = 'https://auth.openai.com/oauth/authorize'
const tokenUrl = 'https://auth.openai.com/oauth/token'
const callbackPort = 1455
const callbackPath = '/auth/callback'
const callbackRedirectUri = `http://localhost:${callbackPort}${callbackPath}`
const defaultPollIntervalMs = 3_000
const sessionTtlMs = 5 * 60_000
const sessions = new Map<string, CodexOAuthSession>()

export async function startCodexOAuthLogin() {
  cleanupExpiredSessions()

  const pkce = generatePkceCodes()
  const session: CodexOAuthSession = {
    id: randomUUID(),
    state: generateState(),
    codeVerifier: pkce.codeVerifier,
    verificationUrl: '',
    intervalMs: defaultPollIntervalMs,
    expiresAt: Date.now() + sessionTtlMs,
    createdAt: Date.now(),
    status: 'pending',
  }
  session.verificationUrl = buildCodexAuthUrl(session.state, pkce.codeChallenge)
  session.server = await startCallbackServer(session)
  sessions.set(session.id, session)

  return publicSession(session)
}

export async function pollCodexOAuthLogin(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) {
    throw httpError(404, 'Codex OAuth 登录会话不存在')
  }
  if (session.status !== 'pending') {
    return publicSession(session)
  }
  if (Date.now() > session.expiresAt) {
    failSession(session, 'Codex OAuth 登录已超时')
    return publicSession(session)
  }

  return publicSession(session)
}

function startCallbackServer(session: CodexOAuthSession) {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer((req, res) => {
      void handleCallbackRequest(session, req.url || '', res)
    })

    server.once('error', (error) => {
      reject(error)
    })
    server.listen(callbackPort, 'localhost', () => {
      server.removeAllListeners('error')
      resolve(server)
    })
  })
}

async function handleCallbackRequest(session: CodexOAuthSession, rawUrl: string, res: ServerResponse) {
  const requestUrl = new URL(rawUrl, callbackRedirectUri)
  if (requestUrl.pathname !== callbackPath) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
    return
  }

  try {
    const state = requestUrl.searchParams.get('state') || ''
    const code = requestUrl.searchParams.get('code') || ''
    const error = requestUrl.searchParams.get('error') || ''
    const errorDescription = requestUrl.searchParams.get('error_description') || ''

    if (error) {
      throw new Error(errorDescription || error)
    }
    if (state !== session.state) {
      throw new Error('Codex OAuth state 校验失败')
    }
    if (!code) {
      throw new Error('Codex OAuth 回调缺少 code')
    }

    const tokenData = await exchangeCodexToken(code, session.codeVerifier, callbackRedirectUri)
    const authMetadata = createCodexAuthMetadata(tokenData)
    session.authFile = saveCodexAuthFile(storage.getConfig().Codex, {
      fileName: codexAuthFileName(authMetadata),
      content: JSON.stringify(authMetadata),
    })
    session.status = 'complete'
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(successHtml())
  } catch (error) {
    failSession(session, error instanceof Error ? error.message : String(error))
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
    res.end(errorHtml(session.error || 'Codex OAuth 登录失败'))
  } finally {
    closeSessionServer(session)
  }
}

async function exchangeCodexToken(code: string, codeVerifier: string, redirectUri: string) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  })
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  return readJsonResponse(response, 'Codex token exchange failed')
}

function buildCodexAuthUrl(state: string, codeChallenge: string) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: callbackRedirectUri,
    scope: 'openid email profile offline_access',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'login',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  })
  return `${authUrl}?${params.toString()}`
}

function generatePkceCodes() {
  const codeVerifier = randomBytes(96).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge }
}

function generateState() {
  return randomBytes(32).toString('base64url')
}

function createCodexAuthMetadata(tokenData: JsonRecord) {
  const idToken = readString(tokenData.id_token)
  const claims = parseJwtClaims(idToken)
  const authInfo = asRecord(claims['https://api.openai.com/auth'])
  const profile = asRecord(claims['https://api.openai.com/profile'])
  const expiresIn = readNumber(tokenData.expires_in) || 604800

  return {
    access_token: readString(tokenData.access_token),
    account_id: readString(authInfo.chatgpt_account_id),
    disabled: false,
    email: readString(claims.email) || readString(profile.email),
    expired: new Date(Date.now() + expiresIn * 1000).toISOString(),
    id_token: idToken,
    last_refresh: new Date().toISOString(),
    plan_type: readString(authInfo.chatgpt_plan_type),
    refresh_token: readString(tokenData.refresh_token),
    type: 'codex',
  }
}

function codexAuthFileName(metadata: JsonRecord) {
  const email = readString(metadata.email) || 'account'
  const plan = readString(metadata.plan_type) || 'codex'
  return `codex-${email}-${plan}.json`
}

function publicSession(session: CodexOAuthSession) {
  return {
    id: session.id,
    status: session.status,
    verificationUrl: session.verificationUrl,
    userCode: '',
    intervalMs: session.intervalMs,
    expiresAt: new Date(session.expiresAt).toISOString(),
    authFile: session.authFile,
    error: session.error,
  }
}

function cleanupExpiredSessions() {
  const now = Date.now()
  for (const [id, session] of sessions) {
    if (now > session.expiresAt || now - session.createdAt > sessionTtlMs * 2) {
      if (session.status === 'pending') {
        failSession(session, 'Codex OAuth 登录已超时')
      }
      closeSessionServer(session)
      sessions.delete(id)
    }
  }
}

function failSession(session: CodexOAuthSession, message: string) {
  session.status = 'error'
  session.error = message
  closeSessionServer(session)
}

function closeSessionServer(session: CodexOAuthSession) {
  const server = session.server
  session.server = undefined
  if (server?.listening) {
    server.close()
  }
}

async function readJsonResponse(response: Response, message: string) {
  const text = await response.text()
  const data = safeJson(text)
  if (!response.ok) {
    const details = readString(data.error_description) || readString(data.error) || text.trim()
    throw httpError(response.status, details ? `${message}: ${details}` : message)
  }
  return data
}

function parseJwtClaims(token: string) {
  const payload = token.split('.')[1]
  if (!payload) {
    return {}
  }

  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as JsonRecord
  } catch {
    return {}
  }
}

function successHtml() {
  return `<!doctype html><meta charset="utf-8"><title>Codex 登录成功</title><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:48px;color:#1f2a33"><h1>Codex 登录成功</h1><p>认证文件已保存，可以关闭这个页面并回到 Node Claude Code。</p></body>`
}

function errorHtml(message: string) {
  return `<!doctype html><meta charset="utf-8"><title>Codex 登录失败</title><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:48px;color:#1f2a33"><h1>Codex 登录失败</h1><p>${escapeHtml(message)}</p></body>`
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function safeJson(text: string) {
  try {
    return JSON.parse(text) as JsonRecord
  } catch {
    return {}
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function readString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function readNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function httpError(status: number, message: string) {
  const error = new Error(message) as Error & { status?: number }
  error.status = status
  return error
}
