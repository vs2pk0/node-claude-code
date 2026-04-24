import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { defaultConfig } from './defaultConfig.js'
import { parseConfig } from './validation.js'
import type { AppConfig, RequestRecord, RequestRecordInput, StatsSummary } from './types.js'

const defaultDataDir = process.platform === 'darwin'
  ? path.join(os.homedir(), '.node-claude-code')
  : path.join(process.cwd(), 'data')

const dataDir = path.resolve(process.env.DATA_DIR ?? defaultDataDir)
const settingsPath = path.join(dataDir, 'settings.json')
const databasePath = path.join(dataDir, 'node-claude-code.db')

fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true })
fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true })

const db = new Database(databasePath)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')

let cachedConfig: AppConfig | undefined
const pendingRequestRecords: RequestRecordInput[] = []
let requestFlushScheduled = false

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS requests (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    target_model TEXT NOT NULL,
    route_key TEXT NOT NULL,
    status INTEGER NOT NULL,
    success INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    error TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_requests_created_at ON requests(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_requests_provider_model ON requests(provider, model);
`)

ensureRequestColumn('api_key', "TEXT NOT NULL DEFAULT ''")
ensureRequestColumn('queue_ms', 'INTEGER NOT NULL DEFAULT 0')
ensureRequestColumn('upstream_ms', 'INTEGER NOT NULL DEFAULT 0')
ensureRequestColumn('first_byte_ms', 'INTEGER NOT NULL DEFAULT 0')

const insertRequestStatement = db.prepare(`
  INSERT INTO requests (
    id, created_at, endpoint, provider, api_key, model, target_model, route_key,
    status, success, latency_ms, queue_ms, upstream_ms, first_byte_ms,
    input_tokens, output_tokens, total_tokens, error
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)

process.once('exit', () => {
  flushPendingRequests()
})

export const storage = {
  dataDir,
  settingsPath,
  databasePath,
  getConfig,
  saveConfig,
  recordRequest,
  enqueueRequest,
  flushPendingRequests,
  getSummary,
  getRecentRequests,
  deleteAllRequests,
  deleteRequest,
  deleteModelStats,
}

function getConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig
  }

  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('config') as { value: string } | undefined

  if (row) {
    cachedConfig = parseConfig(JSON.parse(row.value))
    return cachedConfig
  }

  if (fs.existsSync(settingsPath)) {
    const config = parseConfig(JSON.parse(fs.readFileSync(settingsPath, 'utf8')))
    saveConfig(config)
    return config
  }

  return saveConfig(defaultConfig)
}

function saveConfig(input: unknown): AppConfig {
  const config = parseConfig(input)
  const value = JSON.stringify(config, null, 2)
  const updatedAt = new Date().toISOString()

  db.prepare(
    `
      INSERT INTO settings (key, value, updated_at)
      VALUES ('config', ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `,
  ).run(value, updatedAt)

  fs.writeFileSync(settingsPath, `${value}\n`, 'utf8')
  cachedConfig = config
  return config
}

function recordRequest(input: RequestRecordInput): RequestRecord {
  const createdAt = new Date().toISOString()
  const totalTokens = input.inputTokens + input.outputTokens
  const id = randomUUID()
  const apiKey = input.apiKey ?? ''
  const queueMs = input.queueMs ?? 0
  const upstreamMs = input.upstreamMs ?? 0
  const firstByteMs = input.firstByteMs ?? 0

  insertRequestStatement.run(
    id,
    createdAt,
    input.endpoint,
    input.provider,
    apiKey,
    input.model,
    input.targetModel,
    input.routeKey,
    input.status,
    input.success ? 1 : 0,
    input.latencyMs,
    queueMs,
    upstreamMs,
    firstByteMs,
    input.inputTokens,
    input.outputTokens,
    totalTokens,
    input.error ?? null,
  )

  return {
    ...input,
    apiKey,
    queueMs,
    upstreamMs,
    firstByteMs,
    id,
    createdAt,
    totalTokens,
  }
}

function enqueueRequest(input: RequestRecordInput) {
  pendingRequestRecords.push(input)
  if (requestFlushScheduled) {
    return
  }

  requestFlushScheduled = true
  setImmediate(flushPendingRequests)
}

function flushPendingRequests() {
  requestFlushScheduled = false
  if (!pendingRequestRecords.length) {
    return 0
  }

  const batch = pendingRequestRecords.splice(0, pendingRequestRecords.length)
  const insertBatch = db.transaction((records: RequestRecordInput[]) => {
    for (const record of records) {
      recordRequest(record)
    }
  })

  insertBatch(batch)
  return batch.length
}

function getSummary(): StatsSummary {
  flushPendingRequests()
  const config = getConfig()
  const tokenSums = summaryTokenSums(config.Stats.excludeFailedTokens)
  const totals = db
    .prepare(
      `
        SELECT
          COUNT(*) AS requests,
          SUM(success) AS success,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed,
          ${tokenSums.input} AS inputTokens,
          ${tokenSums.output} AS outputTokens,
          ${tokenSums.total} AS totalTokens,
          COALESCE(AVG(latency_ms), 0) AS avgLatencyMs
        FROM requests
      `,
    )
    .get() as StatsSummary['totals']

  const byProvider = db
    .prepare(
      `
        SELECT
          provider,
          COUNT(*) AS requests,
          ${tokenSums.input} AS inputTokens,
          ${tokenSums.output} AS outputTokens,
          ${tokenSums.total} AS totalTokens
        FROM requests
        GROUP BY provider
        ORDER BY requests DESC, totalTokens DESC
      `,
    )
    .all() as StatsSummary['byProvider']

  const byModel = db
    .prepare(
      `
        SELECT
          model,
          target_model AS targetModel,
          provider,
          COUNT(*) AS requests,
          ${tokenSums.input} AS inputTokens,
          ${tokenSums.output} AS outputTokens,
          ${tokenSums.total} AS totalTokens
        FROM requests
        GROUP BY provider, model, target_model
        ORDER BY requests DESC, totalTokens DESC
        LIMIT 20
      `,
    )
    .all() as StatsSummary['byModel']

  const byProviderModelKey = db
    .prepare(
      `
        SELECT
          provider,
          api_key AS apiKey,
          model,
          target_model AS targetModel,
          COUNT(*) AS requests,
          ${tokenSums.input} AS inputTokens,
          ${tokenSums.output} AS outputTokens,
          ${tokenSums.total} AS totalTokens
        FROM requests
        GROUP BY provider, api_key, model, target_model
        ORDER BY requests DESC, totalTokens DESC
        LIMIT 200
      `,
    )
    .all() as StatsSummary['byProviderModelKey']

  return {
    totals: {
      requests: Number(totals.requests ?? 0),
      success: Number(totals.success ?? 0),
      failed: Number(totals.failed ?? 0),
      inputTokens: Number(totals.inputTokens ?? 0),
      outputTokens: Number(totals.outputTokens ?? 0),
      totalTokens: Number(totals.totalTokens ?? 0),
      avgLatencyMs: Math.round(Number(totals.avgLatencyMs ?? 0)),
    },
    byProvider,
    byModel,
    byProviderModelKey,
    recent: getRecentRequests(200),
  }
}

function summaryTokenSums(excludeFailedTokens: boolean) {
  return {
    input: sumTokenColumn('input_tokens', excludeFailedTokens),
    output: sumTokenColumn('output_tokens', excludeFailedTokens),
    total: sumTokenColumn('total_tokens', excludeFailedTokens),
  }
}

function sumTokenColumn(column: 'input_tokens' | 'output_tokens' | 'total_tokens', excludeFailedTokens: boolean) {
  const value = excludeFailedTokens ? `CASE WHEN success = 1 THEN ${column} ELSE 0 END` : column
  return `COALESCE(SUM(${value}), 0)`
}

function getRecentRequests(limit = 200): RequestRecord[] {
  flushPendingRequests()
  type RequestRow = Omit<RequestRecord, 'success'> & { success: number }

  const rows = db
    .prepare(
      `
        SELECT
          id,
          created_at AS createdAt,
          endpoint,
          provider,
          api_key AS apiKey,
          model,
          target_model AS targetModel,
          route_key AS routeKey,
          status,
          success,
          latency_ms AS latencyMs,
          queue_ms AS queueMs,
          upstream_ms AS upstreamMs,
          first_byte_ms AS firstByteMs,
          input_tokens AS inputTokens,
          output_tokens AS outputTokens,
          total_tokens AS totalTokens,
          error
        FROM requests
        ORDER BY created_at DESC
        LIMIT ?
      `,
    )
    .all(limit) as RequestRow[]

  return rows.map((row) => ({
    ...row,
    success: Boolean(row.success),
  }))
}

function ensureRequestColumn(column: string, definition: string) {
  const columns = db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>
  if (columns.some((existing) => existing.name === column)) {
    return
  }

  db.exec(`ALTER TABLE requests ADD COLUMN ${column} ${definition}`)
}

function deleteAllRequests() {
  flushPendingRequests()
  const result = db.prepare('DELETE FROM requests').run()
  return {
    deleted: result.changes,
  }
}

function deleteRequest(id: string) {
  flushPendingRequests()
  const result = db.prepare('DELETE FROM requests WHERE id = ?').run(id)
  return {
    deleted: result.changes,
  }
}

function deleteModelStats(input: { provider: string; model: string; targetModel: string }) {
  flushPendingRequests()
  const result = db
    .prepare(
      `
        DELETE FROM requests
        WHERE provider = ?
          AND model = ?
          AND target_model = ?
      `,
    )
    .run(input.provider, input.model, input.targetModel)

  return {
    deleted: result.changes,
  }
}
