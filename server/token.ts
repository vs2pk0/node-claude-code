const cjkPattern = /[\u3400-\u9fff\uf900-\ufaff]/g
const objectTokenCache = new WeakMap<object, number>()

export function estimateTokens(value: unknown): number {
  if (value && typeof value === 'object') {
    const cached = objectTokenCache.get(value)
    if (typeof cached === 'number') {
      return cached
    }
  }

  const stats = collectTokenStats(value)
  if (!stats.hasText) {
    return 0
  }

  const latinLength = stats.length - stats.cjkCount
  const tokens = Math.max(1, Math.ceil(stats.cjkCount + latinLength / 4))
  if (value && typeof value === 'object') {
    objectTokenCache.set(value, tokens)
  }

  return tokens
}

function collectTokenStats(value: unknown): { cjkCount: number; length: number; hasText: boolean } {
  const stats = {
    cjkCount: 0,
    length: 0,
    hasText: false,
  }
  appendTokenStats(value, stats)
  return stats
}

function appendTokenStats(
  value: unknown,
  stats: { cjkCount: number; length: number; hasText: boolean },
) {
  if (value == null) {
    return
  }

  if (typeof value === 'string') {
    appendStringStats(value, stats)
    return
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    appendStringStats(String(value), stats)
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendTokenStats(item, stats)
    }
    return
  }

  if (typeof value === 'object') {
    for (const item of Object.values(value)) {
      appendTokenStats(item, stats)
    }
  }
}

function appendStringStats(value: string, stats: { cjkCount: number; length: number; hasText: boolean }) {
  if (/\S/.test(value)) {
    stats.hasText = true
  }
  stats.length += value.length
  stats.cjkCount += value.match(cjkPattern)?.length ?? 0
}
