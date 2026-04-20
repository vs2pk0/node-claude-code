import { Router } from 'express'
import { ZodError } from 'zod'
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

  router.get('/stats/summary', (_req, res) => {
    res.json(storage.getSummary())
  })

  router.get('/stats/requests', (req, res) => {
    const limit = Number(req.query.limit ?? 50)
    res.json(storage.getRecentRequests(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 50))
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

  res.status(400).json({
    error: {
      type: 'validation_error',
      message: error instanceof Error ? error.message : String(error),
    },
  })
}
