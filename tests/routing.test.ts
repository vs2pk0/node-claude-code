import assert from 'node:assert/strict'
import test from 'node:test'
import { requestConcurrencyLimiter } from '../server/concurrency.ts'
import { defaultConfig } from '../server/defaultConfig.ts'
import { allModels, resolveRoute } from '../server/routing.ts'
import { parseConfig } from '../server/validation.ts'

test('legacy router target strings are normalized to editable route rules', () => {
  const config = parseConfig({
    ...defaultConfig,
    Providers: [provider('p1', ['m1'])],
    Router: {
      ...defaultConfig.Router,
      default: 'p1,m1',
    },
  })

  assert.equal(config.Router.default.model, 'claude-sonnet-4-6')
  assert.deepEqual(config.Router.default.targets, ['p1,m1'])
  assert.equal(config.Router.default.strategy, 'sequence')
  assert.equal(config.Router.default.delayMs, 0)
})

test('sequence strategy rotates selected route targets in order', () => {
  const config = parseConfig({
    ...defaultConfig,
    Providers: [provider('p1', ['m1']), provider('p2', ['m2'])],
    Router: {
      ...defaultConfig.Router,
      default: {
        model: 'route-sequence-model',
        targets: ['p1,m1', 'p2,m2'],
        strategy: 'sequence',
        delayMs: 250,
      },
    },
  })

  const first = resolveRoute(config, body('route-sequence-model'))
  assert.equal(first.providerName, 'p1')
  assert.equal(first.delayMs, 250)
  assert.equal(resolveRoute(config, body('route-sequence-model')).providerName, 'p2')
  assert.equal(resolveRoute(config, body('route-sequence-model')).providerName, 'p1')
})

test('selected route target model uses route sequence before provider direct matching', () => {
  const config = parseConfig({
    ...defaultConfig,
    Providers: [
      provider('p1', ['m1']),
      provider('p2', ['m2']),
    ],
    Router: {
      ...defaultConfig.Router,
      default: {
        model: 'route-direct-model',
        targets: ['p1,m1', 'p2,m2'],
        strategy: 'sequence',
      },
    },
  })

  const first = resolveRoute(config, body('m1'))
  const second = resolveRoute(config, body('m1'))

  assert.equal(first.routeKey, 'default')
  assert.equal(first.providerName, 'p1')
  assert.equal(second.routeKey, 'default')
  assert.equal(second.providerName, 'p2')
})

test('selected route target alias uses route sequence before provider direct matching', () => {
  const config = parseConfig({
    ...defaultConfig,
    Providers: [
      provider('p1', ['real-m1'], { 'real-m1': 'shared-alias' }),
      provider('p2', ['shared-alias']),
    ],
    Router: {
      ...defaultConfig.Router,
      default: {
        model: 'route-sequence-model',
        targets: ['p1,real-m1', 'p2,shared-alias'],
        strategy: 'sequence',
      },
    },
  })

  const first = resolveRoute(config, body('shared-alias'))
  const second = resolveRoute(config, body('shared-alias'))

  assert.equal(first.routeKey, 'default')
  assert.equal(first.providerName, 'p1')
  assert.equal(first.targetModel, 'real-m1')
  assert.equal(second.routeKey, 'default')
  assert.equal(second.providerName, 'p2')
  assert.equal(second.targetModel, 'shared-alias')
})

test('loadBalance strategy prefers the target with fewer active requests', async () => {
  const config = parseConfig({
    ...defaultConfig,
    Providers: [provider('p1', ['m1']), provider('p2', ['m2'])],
    Router: {
      ...defaultConfig.Router,
      default: {
        model: 'route-load-model',
        targets: ['p1,m1', 'p2,m2'],
        strategy: 'loadBalance',
      },
    },
  })
  const release = await requestConcurrencyLimiter.acquire(config, {
    provider: config.Providers[0],
    providerName: 'p1',
    targetModel: 'm1',
    routeKey: 'test',
  })

  try {
    const decision = resolveRoute(config, body('route-load-model'))
    assert.equal(decision.providerName, 'p2')
    assert.equal(decision.targetModel, 'm2')
  } finally {
    release()
  }
})

test('models endpoint includes editable Claude Code route model ids', () => {
  const config = parseConfig({
    ...defaultConfig,
    Providers: [provider('p1', ['m1'])],
    Router: {
      ...defaultConfig.Router,
      default: {
        model: 'route-visible-model',
        targets: ['p1,m1'],
        strategy: 'sequence',
      },
    },
  })

  assert.ok(allModels(config).some((model) => model.id === 'route-visible-model' && model.owned_by === 'router'))
})

test('models endpoint exposes provider aliases and resolves them to real models', () => {
  const config = parseConfig({
    ...defaultConfig,
    Providers: [provider('p1', ['real-provider-model'], { 'real-provider-model': 'friendly-model-id' })],
  })

  const modelIds = allModels(config).map((model) => model.id)
  assert.ok(modelIds.includes('friendly-model-id'))
  assert.equal(modelIds.includes('real-provider-model'), false)

  const decision = resolveRoute(config, body('friendly-model-id'))
  assert.equal(decision.providerName, 'p1')
  assert.equal(decision.targetModel, 'real-provider-model')
})

test('provider format settings are normalized with default fallback', () => {
  const config = parseConfig({
    ...defaultConfig,
    Providers: [
      {
        ...provider('p1', ['m1', 'm2']),
        model_formats: {
          m1: 'claude-code',
          m2: 'unknown-format',
        },
        claude_code_forward: true,
      },
    ],
  })

  assert.equal(config.Providers[0].claude_code_forward, true)
  assert.equal(config.Providers[0].model_formats?.m1, 'claude-code')
  assert.equal(config.Providers[0].model_formats?.m2, 'default')
})

test('ui settings default to showing model conflict warnings', () => {
  const legacyInput = JSON.parse(JSON.stringify(defaultConfig)) as Record<string, unknown>
  delete legacyInput.UI

  const legacyConfig = parseConfig(legacyInput)
  const disabledConfig = parseConfig({
    ...defaultConfig,
    UI: {
      showModelConflictWarnings: false,
    },
  })

  assert.equal(legacyConfig.UI.showModelConflictWarnings, true)
  assert.equal(disabledConfig.UI.showModelConflictWarnings, false)
})

function provider(name: string, models: string[], modelAliases?: Record<string, string>) {
  return {
    name,
    api_base_url: `http://127.0.0.1/${name}`,
    api_key: '',
    models,
    model_aliases: modelAliases,
  }
}

function body(model: string) {
  return {
    model,
    messages: [{ role: 'user', content: 'hello' }],
  }
}
