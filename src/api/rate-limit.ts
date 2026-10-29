export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>()

  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  take(id: string, now = Date.now()): { ok: boolean; remaining: number; retryAfterSec: number } {
    const current = this.buckets.get(id) ?? { tokens: this.limit, updated: now }
    const refill = ((now - current.updated) / this.windowMs) * this.limit
    current.tokens = Math.min(this.limit, current.tokens + refill)
    current.updated = now
    if (current.tokens < 1) {
      this.buckets.set(id, current)
      const retryAfterSec = Math.max(1, Math.ceil(((1 - current.tokens) / this.limit) * (this.windowMs / 1000)))
      return { ok: false, remaining: 0, retryAfterSec }
    }
    current.tokens -= 1
    this.buckets.set(id, current)
    return { ok: true, remaining: Math.floor(current.tokens), retryAfterSec: 0 }
  }
}
