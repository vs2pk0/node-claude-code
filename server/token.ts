const cjkPattern = /[\u3400-\u9fff\uf900-\ufaff]/g

export function estimateTokens(value: unknown): number {
  const text = collectText(value).trim()
  if (!text) {
    return 0
  }

  const cjkCount = text.match(cjkPattern)?.length ?? 0
  const latinLength = text.replace(cjkPattern, '').length

  return Math.max(1, Math.ceil(cjkCount + latinLength / 4))
}

function collectText(value: unknown): string {
  if (value == null) {
    return ''
  }

  if (typeof value === 'string') {
    return value
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  if (Array.isArray(value)) {
    return value.map(collectText).join('\n')
  }

  if (typeof value === 'object') {
    return Object.values(value).map(collectText).join('\n')
  }

  return ''
}
