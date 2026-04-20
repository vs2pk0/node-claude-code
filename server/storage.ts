import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { defaultConfig } from './defaultConfig.js'
import { parseConfig } from './validation.js'
import type { AppConfig, RequestRecord, RequestRecordInput, StatsSummary } from './types.js'

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), 'data'))
const settingsPath = path.join(dataDir, 'settings.json')
const databasePath = path.join(dataDir, 'node-claude-code.db')

fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true })
fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true })

const db = new Database(databasePath)
db.pragma('journal_mode = WAL')
db.pragma('busy_timeout = 5000')

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

export const storage = {
  dataDir,
  settingsPath,
  databasePath,
  getConfig,
  saveConfig,
  recordRequest,
  getSummary,
  getRecentRequests,
  deleteAllRequests,
  deleteRequest,
  deleteModelStats,
}

function getConfig(): AppConfig {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('config') as { value: string } | undefined

  if (row) {
    return parseConfig(JSON.parse(row.value))
  }

  if (fs.existsSync(settingsPath)) {
    const config = parseConfig(JSON.parse(fs.readFileSync(settingsPath, 'utf8')))
    saveConfig(config)
    return config
  }

  saveConfig(defaultConfig)
  return defaultConfig
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
  return config
}

function recordRequest(input: RequestRecordInput): RequestRecord {
  const createdAt = new Date().toISOString()
  const totalTokens = input.inputTokens + input.outputTokens
  const id = randomUUID()

  db.prepare(
    `
      INSERT INTO requests (
        id, created_at, endpoint, provider, model, target_model, route_key,
        status, success, latency_ms, input_tokens, output_tokens, total_tokens, error
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    id,
    createdAt,
    input.endpoint,
    input.provider,
    input.model,
    input.targetModel,
    input.routeKey,
    input.status,
    input.success ? 1 : 0,
    input.latencyMs,
    input.inputTokens,
    input.outputTokens,
    totalTokens,
    input.error ?? null,
  )

  return {
    ...input,
    id,
    createdAt,
    totalTokens,
  }
}

function getSummary(): StatsSummary {
  const totals = db
    .prepare(
      `
        SELECT
          COUNT(*) AS requests,
          SUM(success) AS success,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed,
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(total_tokens), 0) AS totalTokens,
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
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(total_tokens), 0) AS totalTokens
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
          COALESCE(SUM(input_tokens), 0) AS inputTokens,
          COALESCE(SUM(output_tokens), 0) AS outputTokens,
          COALESCE(SUM(total_tokens), 0) AS totalTokens
        FROM requests
        GROUP BY provider, model, target_model
        ORDER BY requests DESC, totalTokens DESC
        LIMIT 20
      `,
    )
    .all() as StatsSummary['byModel']

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
    recent: getRecentRequests(12),
  }
}

function getRecentRequests(limit = 50): RequestRecord[] {
  type RequestRow = Omit<RequestRecord, 'success'> & { success: number }

  const rows = db
    .prepare(
      `
        SELECT
          id,
          created_at AS createdAt,
          endpoint,
          provider,
          model,
          target_model AS targetModel,
          route_key AS routeKey,
          status,
          success,
          latency_ms AS latencyMs,
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

function deleteAllRequests() {
  const result = db.prepare('DELETE FROM requests').run()
  return {
    deleted: result.changes,
  }
}

function deleteRequest(id: string) {
  const result = db.prepare('DELETE FROM requests WHERE id = ?').run(id)
  return {
    deleted: result.changes,
  }
}

function deleteModelStats(input: { provider: string; model: string; targetModel: string }) {
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
