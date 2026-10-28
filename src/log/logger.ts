export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

const SECRET = /key|secret|private|authorization|token/i

function redact(fields: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!fields) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET.test(key) ? '[redacted]' : value
  }
  return out
}

export function createLogger(name = 'omnis'): Logger {
  const emit = (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify(
      { ts: new Date().toISOString(), level, name, msg: message, ...redact(fields) },
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    )
    if (level === 'error') console.error(line)
    else console.log(line)
  }
  return {
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  }
}
