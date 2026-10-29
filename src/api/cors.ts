/** Same-host browser calls are allowed. Everything else must be listed. Wildcards are never echoed. */
export function originAllowed(origin: string | undefined, allow: string[], host: string | undefined): boolean {
  if (!origin) return true
  if (origin.includes('*')) return false
  if (host && (origin === `http://${host}` || origin === `https://${host}`)) return true
  return allow.includes(origin)
}

export function corsHeaders(origin: string | undefined, allow: string[], host: string | undefined): Record<string, string> | null {
  if (!originAllowed(origin, allow, host)) return null
  if (!origin) return {}
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'content-type, authorization, x-api-key',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'Origin',
  }
}
