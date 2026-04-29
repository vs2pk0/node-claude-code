import { Router } from 'express'
import { ZodError } from 'zod'
import {
  deleteCodexAuthFile,
  exportCodexAuthFile,
  exportCodexAuthFiles,
  listCodexAuthFilesWithUsage,
  refreshCodexAuthUsage,
  resolveCodexAuthDir,
  saveCodexAuthFile,
  updateCodexAuthFile,
} from './codexAuth.js'
import { pollCodexOAuthLogin, startCodexOAuthLogin } from './codexOAuth.js'
import { storage } from './storage.js'
import { parseConfig } from './validation.js'

export function createApiRouter() {
  const router = Router()

  router.get('/health', (_req, res) => {
    const config = storage.getConfig()
    const runtimeHost = process.env.HOST || config.HOST
    const runtimePort = Number(process.env.PORT || config.PORT)

    res.json({
      ok: true,
      configured: {
        host: config.HOST,
        port: config.PORT,
      },
      runtime: {
        host: runtimeHost,
        port: runtimePort,
      },
      dataDir: storage.dataDir,
      settingsPath: storage.settingsPath,
      databasePath: storage.databasePath,
    })
  })

  router.get('/config', (_req, res) => {
    res.json(storage.getConfig())
  })

  router.put('/config', (req, res) => {
    try {
      const config = storage.saveConfig(req.body)
      res.json(config)
    } catch (error) {
      sendValidationError(res, error)
    }
  })

  router.post('/config/import', (req, res) => {
    try {
      const config = storage.saveConfig(parseConfig(req.body))
      res.json(config)
    } catch (error) {
      sendValidationError(res, error)
    }
  })

  router.get('/config/export', (_req, res) => {
    const config = storage.getConfig()
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('content-disposition', 'attachment; filename="settings.json"')
    res.send(`${JSON.stringify(config, null, 2)}\n`)
  })

  router.get('/codex/auths', async (_req, res) => {
    try {
      const codex = storage.getConfig().Codex
      res.json({
        dataDir: storage.dataDir,
        authDir: resolveCodexAuthDir(codex),
        auths: await listCodexAuthFilesWithUsage(codex),
      })
    } catch (error) {
      sendValidationError(res, error)
    }
  })

  router.post('/codex/auths', (req, res) => {
    try {
      const fileName = readString(req.body?.fileName)
      const content = readString(req.body?.content)
      if (!content) {
        res.status(400).json({
          error: {
            type: 'validation_error',
            message: 'content is required',
          },
        })
        return
      }

      res.json(saveCodexAuthFile(storage.getConfig().Codex, { fileName, content }))
    } catch (error) {
      sendValidationError(res, error)
    }
  })

  router.patch('/codex/auths/:id', (req, res) => {
    try {
      res.json(updateCodexAuthFile(storage.getConfig().Codex, req.params.id, {
        enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : undefined,
        label: typeof req.body?.label === 'string' ? req.body.label : undefined,
      }))
    } catch (error) {
      sendValidationError(res, error)
    }
  })

  router.post('/codex/auths/:id/usage', async (req, res) => {
    try {
      res.json(await refreshCodexAuthUsage(storage.getConfig().Codex, req.params.id))
    } catch (error) {
      sendValidationError(res, error)
    }
  })

  router.post('/codex/auths/export', (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids)
        ? req.body.ids.map(readString).filter(Boolean)
        : []
      if (!ids.length) {
        res.status(400).json({
          error: {
            type: 'validation_error',
            message: 'ids is required',
          },
        })
        return
      }

      res.json({ files: exportCodexAuthFiles(storage.getConfig().Codex, ids) })
    } catch (error) {
      sendValidationError(res, error)
    }
  })

  router.get('/codex/auths/:id/export', (req, res) => {
    try {
      res.json(exportCodexAuthFile(storage.getConfig().Codex, req.params.id))
    } catch (error) {
      sendValidationError(res, error)
    }
  })

  router.delete('/codex/auths/:id', (req, res) => {
    try {
      res.json(deleteCodexAuthFile(storage.getConfig().Codex, req.params.id))
    } catch (error) {
      sendValidationError(res, error)
    }
  })

  router.post('/codex/oauth/start', async (_req, res) => {
    try {
      res.json(await startCodexOAuthLogin())
    } catch (error) {
      sendValidationError(res, error)
    }
  })

  router.get('/codex/oauth/:id', async (req, res) => {
    try {
      res.json(await pollCodexOAuthLogin(req.params.id))
    } catch (error) {
      sendValidationError(res, error)
    }
  })

  router.get('/stats/summary', (_req, res) => {
    res.json(storage.getSummary())
  })

  router.get('/stats/requests', (req, res) => {
    const limit = Number(req.query.limit ?? 50)
    const start = readOptionalDate(req.query.start)
    const end = readOptionalDate(req.query.end)
    res.json(storage.getRequests({
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 5000) : 50,
      start,
      end,
    }))
  })

  router.delete('/stats/requests', (_req, res) => {
    res.json(storage.deleteAllRequests())
  })

  router.delete('/stats/requests/:id', (req, res) => {
    const result = storage.deleteRequest(req.params.id)
    if (!result.deleted) {
      res.status(404).json({
        error: {
          type: 'not_found',
          message: 'Request record was not found',
        },
      })
      return
    }

    res.json(result)
  })

  router.delete('/stats/models', (req, res) => {
    const provider = readString(req.body?.provider ?? req.query.provider)
    const model = readString(req.body?.model ?? req.query.model)
    const targetModel = readString(req.body?.targetModel ?? req.query.targetModel)

    if (!provider || !model || !targetModel) {
      res.status(400).json({
        error: {
          type: 'validation_error',
          message: 'provider, model and targetModel are required',
        },
      })
      return
    }

    res.json(storage.deleteModelStats({ provider, model, targetModel }))
  })

  return router
}

function readString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function readOptionalDate(value: unknown) {
  const text = readString(value)
  if (!text) {
    return undefined
  }
  const timestamp = Date.parse(text)
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined
}

function sendValidationError(res: import('express').Response, error: unknown) {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        type: 'validation_error',
        message: error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      },
    })
    return
  }

  const status = typeof (error as { status?: unknown })?.status === 'number'
    ? (error as { status: number }).status
    : 400

  res.status(status).json({
    error: {
      type: 'validation_error',
      message: error instanceof Error ? error.message : String(error),
    },
  })
}
