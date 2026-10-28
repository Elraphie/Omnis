export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const workers = Math.max(1, Math.min(limit, items.length))
  async function worker() {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      out[index] = await fn(items[index]!, index)
    }
  }
  if (items.length === 0) return out
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return out
}

export function utcDay(date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

export function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => (typeof inner === 'bigint' ? inner.toString() : inner))
}
