export function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

export function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(Math.round(value || 0))
}

export function readError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
