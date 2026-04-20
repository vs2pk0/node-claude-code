import assert from 'node:assert/strict'
import test from 'node:test'
import { ConcurrencyLimiter } from '../server/concurrency.ts'

const config = {
  Concurrency: {
    enabled: true,
    maxConcurrent: 1,
    maxConcurrentPerProvider: 1,
    maxQueueSize: 1,
    queueTimeoutMs: 5000,
  },
} as any

const decision = {
  provider: { name: 'provider-a' },
  providerName: 'provider-a',
  targetModel: 'model-a',
  routeKey: 'default',
} as any

test('queued request is removed when its client signal aborts', async () => {
  const limiter = new ConcurrencyLimiter()
  const releaseActive = await limiter.acquire(config, decision)
  const controller = new AbortController()
  let queuedStarted = false

  const queued = limiter.acquire(config, decision, { signal: controller.signal }).then((release) => {
    queuedStarted = true
    release()
  })

  controller.abort()
  const error = await queued.then(
    () => undefined,
    (cause) => cause as { status?: number },
  )

  releaseActive()
  await sleep(20)

  assert.equal(error?.status, 499)
  assert.equal(queuedStarted, false)
})

test('acquire rejects immediately when queue size is exhausted', async () => {
  const limiter = new ConcurrencyLimiter()
  const releaseActive = await limiter.acquire(config, decision)
  const queued = limiter.acquire(config, decision)

  const error = await limiter.acquire(config, decision).then(
    () => undefined,
    (cause) => cause as { status?: number },
  )

  releaseActive()
  const releaseQueued = await queued
  releaseQueued()

  assert.equal(error?.status, 503)
})

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
