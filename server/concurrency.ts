import type { AppConfig, RouteDecision } from './types.js'

interface QueueLimits {
  enabled: boolean
  maxConcurrent: number
  maxConcurrentPerProvider: number
  maxQueueSize: number
  queueTimeoutMs: number
}

interface QueueItem {
  providerKey: string
  targetKey: string
  limits: QueueLimits
  skipProviderLimit: boolean
  resolve: (release: () => void) => void
  timeout: NodeJS.Timeout
  signal?: AbortSignal
  abortListener?: () => void
}

interface AcquireOptions {
  signal?: AbortSignal
  skipProviderLimit?: boolean
}

export class ConcurrencyLimiter {
  private active = 0
  private activeByProvider = new Map<string, number>()
  private activeByTarget = new Map<string, number>()
  private queue: QueueItem[] = []

  acquire(config: AppConfig, decision: RouteDecision, options: AcquireOptions = {}): Promise<() => void> {
    const limits = readLimits(config)
    if (!limits.enabled) {
      return Promise.resolve(noop)
    }

    if (options.signal?.aborted) {
      return Promise.reject(clientClosedError())
    }

    const providerKey = decision.providerName || decision.provider.name
    const targetKey = routeTargetKey(providerKey, decision.targetModel)
    const skipProviderLimit = options.skipProviderLimit === true
    if (this.canStart(providerKey, limits, skipProviderLimit)) {
      return Promise.resolve(this.start(providerKey, targetKey))
    }

    if (this.queue.length >= limits.maxQueueSize) {
      return Promise.reject(queueFullError(limits.maxQueueSize))
    }

    return new Promise((resolve, reject) => {
      let settled = false
      let item: QueueItem

      const rejectQueued = (error: Error) => {
        if (settled) {
          return
        }

        settled = true
        this.removeQueued(item)
        this.cleanupQueued(item)
        reject(error)
      }

      const timeout = setTimeout(() => {
        rejectQueued(queueTimeoutError(limits.queueTimeoutMs))
      }, limits.queueTimeoutMs)

      const abortListener = () => rejectQueued(clientClosedError())

      item = {
        providerKey,
        targetKey,
        limits,
        skipProviderLimit,
        resolve: (release) => {
          if (settled) {
            release()
            return
          }

          settled = true
          this.cleanupQueued(item)
          resolve(release)
        },
        timeout,
        signal: options.signal,
        abortListener,
      }

      options.signal?.addEventListener('abort', abortListener, { once: true })
      this.queue.push(item)
      this.drain()
    })
  }

  private canStart(providerKey: string, limits: QueueLimits, skipProviderLimit = false) {
    const activeForProvider = this.activeByProvider.get(providerKey) ?? 0
    return this.active < limits.maxConcurrent && (skipProviderLimit || activeForProvider < limits.maxConcurrentPerProvider)
  }

  activeTargetCount(providerName: string, targetModel: string) {
    return this.activeByTarget.get(routeTargetKey(providerName, targetModel)) ?? 0
  }

  activeProviderCount(providerName: string) {
    return this.activeByProvider.get(providerName) ?? 0
  }

  private start(providerKey: string, targetKey: string) {
    this.active += 1
    this.activeByProvider.set(providerKey, (this.activeByProvider.get(providerKey) ?? 0) + 1)
    this.activeByTarget.set(targetKey, (this.activeByTarget.get(targetKey) ?? 0) + 1)

    let released = false
    return () => {
      if (released) {
        return
      }

      released = true
      this.active = Math.max(0, this.active - 1)
      const activeForProvider = Math.max(0, (this.activeByProvider.get(providerKey) ?? 0) - 1)
      if (activeForProvider) {
        this.activeByProvider.set(providerKey, activeForProvider)
      } else {
        this.activeByProvider.delete(providerKey)
      }

      const activeForTarget = Math.max(0, (this.activeByTarget.get(targetKey) ?? 0) - 1)
      if (activeForTarget) {
        this.activeByTarget.set(targetKey, activeForTarget)
      } else {
        this.activeByTarget.delete(targetKey)
      }

      this.drain()
    }
  }

  private drain() {
    for (let index = 0; index < this.queue.length; index += 1) {
      const item = this.queue[index]
      if (!this.canStart(item.providerKey, item.limits, item.skipProviderLimit)) {
        continue
      }

      this.queue.splice(index, 1)
      index -= 1
      item.resolve(this.start(item.providerKey, item.targetKey))
    }
  }

  private removeQueued(item: QueueItem) {
    const index = this.queue.indexOf(item)
    if (index >= 0) {
      this.queue.splice(index, 1)
    }
  }

  private cleanupQueued(item: QueueItem) {
    clearTimeout(item.timeout)
    if (item.signal && item.abortListener) {
      item.signal.removeEventListener('abort', item.abortListener)
    }
  }
}

export const requestConcurrencyLimiter = new ConcurrencyLimiter()

function readLimits(config: AppConfig): QueueLimits {
  const raw = config.Concurrency ?? {}
  const enabled = raw.enabled !== false
  const maxConcurrent = positiveInteger(raw.maxConcurrent, 4)
  const maxConcurrentPerProvider = positiveInteger(raw.maxConcurrentPerProvider, 1)
  const maxQueueSize = positiveInteger(raw.maxQueueSize, 64)
  const queueTimeoutMs = positiveInteger(raw.queueTimeoutMs, 300000)

  return {
    enabled,
    maxConcurrent,
    maxConcurrentPerProvider,
    maxQueueSize,
    queueTimeoutMs,
  }
}

function positiveInteger(value: unknown, fallback: number) {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) && numberValue > 0 ? Math.floor(numberValue) : fallback
}

function routeTargetKey(providerName: string, targetModel: string) {
  return `${providerName},${targetModel}`
}

function queueTimeoutError(timeoutMs: number) {
  const error = new Error(`Request waited more than ${timeoutMs} ms in concurrency queue`) as Error & { status?: number }
  error.status = 503
  return error
}

function queueFullError(maxQueueSize: number) {
  const error = new Error(`Concurrency queue is full (${maxQueueSize} waiting requests)`) as Error & { status?: number }
  error.status = 503
  return error
}

export function clientClosedError() {
  const error = new Error('Client closed the request before it could be processed') as Error & {
    code?: string
    status?: number
  }
  error.code = 'CLIENT_CLOSED_REQUEST'
  error.status = 499
  return error
}

function noop() {}
