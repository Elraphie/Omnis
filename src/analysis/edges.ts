/** Pure summaries over recorded scans. The CLI in src/cli/report.ts loads rows and prints these. */

export interface OppRow {
  ts: string
  corridor: string
  buyVenue: string
  sellVenue: string
  sizeUsd: number
  netUsd: number
  netBps: number
}

export interface GapRow {
  ts: string
  corridor: string
  venue: string
  side: string
  gapBps: number
  refAsOf: string
}

/** Linear interpolation between closest ranks. `sorted` must be ascending. */
export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null
  const position = (sorted.length - 1) * q
  const low = Math.floor(position)
  const high = Math.ceil(position)
  const lowValue = sorted[low]!
  return lowValue + (sorted[high]! - lowValue) * (position - low)
}

function share(values: number[], test: (value: number) => boolean): number {
  return values.length === 0 ? 0 : values.filter(test).length / values.length
}

export function medianIntervalSec(scanTimes: string[]): number | null {
  const ms = scanTimes.map((ts) => Date.parse(ts)).sort((a, b) => a - b)
  const gaps: number[] = []
  for (let i = 1; i < ms.length; i += 1) gaps.push((ms[i]! - ms[i - 1]!) / 1000)
  return quantile(gaps.sort((a, b) => a - b), 0.5)
}

export interface ScanSummary {
  scans: number
  scansWithPositive: number
  scansOver10Bps: number
  /** Sum over scans of the best positive net edge: an upper bound, one fill per scan, at the quoted price. */
  capturableUsd: number
  best: { ts: string; route: string; netUsd: number; netBps: number } | null
}

export function routeKey(row: Pick<OppRow, 'corridor' | 'buyVenue' | 'sellVenue' | 'sizeUsd'>): string {
  return `${row.corridor} ${row.buyVenue}->${row.sellVenue} $${row.sizeUsd}`
}

export function scanSummary(rows: OppRow[], scanTimes: string[]): ScanSummary {
  const bestByScan = new Map<string, OppRow>()
  for (const row of rows) {
    const current = bestByScan.get(row.ts)
    if (!current || row.netUsd > current.netUsd) bestByScan.set(row.ts, row)
  }
  let capturableUsd = 0
  let scansWithPositive = 0
  let scansOver10Bps = 0
  let best: ScanSummary['best'] = null
  for (const row of bestByScan.values()) {
    if (row.netUsd > 0) {
      scansWithPositive += 1
      capturableUsd += row.netUsd
    }
    if (row.netBps >= 10 && row.netUsd > 0) scansOver10Bps += 1
    if (!best || row.netUsd > best.netUsd) best = { ts: row.ts, route: routeKey(row), netUsd: row.netUsd, netBps: row.netBps }
  }
  return { scans: scanTimes.length, scansWithPositive, scansOver10Bps, capturableUsd, best }
}

export interface RouteStats {
  route: string
  observations: number
  positiveShare: number
  over5Share: number
  over10Share: number
  over25Share: number
  medianBps: number | null
  p90Bps: number | null
  maxBps: number | null
  bestNetUsd: number | null
  /** Longest run of consecutive scans with a positive net edge on this route. */
  longestRunScans: number
  /** Separate positive episodes: how often the gap opened. */
  episodes: number
}

export function routeStats(rows: OppRow[], scanTimes: string[]): RouteStats[] {
  const ordered = [...new Set(scanTimes)].sort()
  const byRoute = new Map<string, Map<string, OppRow>>()
  for (const row of rows) {
    const key = routeKey(row)
    const seen = byRoute.get(key) ?? new Map<string, OppRow>()
    const current = seen.get(row.ts)
    if (!current || row.netUsd > current.netUsd) seen.set(row.ts, row)
    byRoute.set(key, seen)
  }
  const out: RouteStats[] = []
  for (const [route, seen] of byRoute) {
    const bps = [...seen.values()].map((row) => row.netBps).sort((a, b) => a - b)
    const usd = [...seen.values()].map((row) => row.netUsd)
    let run = 0
    let longestRunScans = 0
    let episodes = 0
    for (const ts of ordered) {
      const row = seen.get(ts)
      if (row && row.netUsd > 0) {
        if (run === 0) episodes += 1
        run += 1
        if (run > longestRunScans) longestRunScans = run
      } else {
        run = 0
      }
    }
    out.push({
      route,
      observations: seen.size,
      positiveShare: share(usd, (value) => value > 0),
      over5Share: share(bps, (value) => value >= 5),
      over10Share: share(bps, (value) => value >= 10),
      over25Share: share(bps, (value) => value >= 25),
      medianBps: quantile(bps, 0.5),
      p90Bps: quantile(bps, 0.9),
      maxBps: bps.length ? bps[bps.length - 1]! : null,
      bestNetUsd: usd.length ? Math.max(...usd) : null,
      longestRunScans,
      episodes,
    })
  }
  return out.sort((a, b) => (b.maxBps ?? -Infinity) - (a.maxBps ?? -Infinity))
}

export interface VenueHealth {
  venue: string
  scansWithErrors: number
  errors: number
  topMessage: string
}

/** Venue failures recorded in each scan's payload. A venue that is always down skews every other number. */
export function venueHealth(scanErrors: { venue: string; message: string }[][]): VenueHealth[] {
  const byVenue = new Map<string, { scans: number; errors: number; messages: Map<string, number> }>()
  for (const errors of scanErrors) {
    const seen = new Set<string>()
    for (const error of errors) {
      const entry = byVenue.get(error.venue) ?? { scans: 0, errors: 0, messages: new Map<string, number>() }
      entry.errors += 1
      if (!seen.has(error.venue)) entry.scans += 1
      seen.add(error.venue)
      const message = error.message.slice(0, 80)
      entry.messages.set(message, (entry.messages.get(message) ?? 0) + 1)
      byVenue.set(error.venue, entry)
    }
  }
  return [...byVenue].map(([venue, entry]) => ({
    venue,
    scansWithErrors: entry.scans,
    errors: entry.errors,
    topMessage: [...entry.messages].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
  })).sort((a, b) => b.errors - a.errors)
}

export interface GapStats {
  corridor: string
  venue: string
  side: string
  observations: number
  medianBps: number | null
  p10Bps: number | null
  p90Bps: number | null
  maxBps: number | null
  over25Share: number
  over50Share: number
  latestRefAsOf: string
}

export function gapStats(rows: GapRow[]): GapStats[] {
  const groups = new Map<string, GapRow[]>()
  for (const row of rows) {
    const key = `${row.corridor}|${row.venue}|${row.side}`
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  const out: GapStats[] = []
  for (const group of groups.values()) {
    const first = group[0]!
    const bps = group.map((row) => row.gapBps).sort((a, b) => a - b)
    out.push({
      corridor: first.corridor,
      venue: first.venue,
      side: first.side,
      observations: group.length,
      medianBps: quantile(bps, 0.5),
      p10Bps: quantile(bps, 0.1),
      p90Bps: quantile(bps, 0.9),
      maxBps: bps[bps.length - 1] ?? null,
      over25Share: share(bps, (value) => value >= 25),
      over50Share: share(bps, (value) => value >= 50),
      latestRefAsOf: group.reduce((latest, row) => (row.refAsOf > latest ? row.refAsOf : latest), ''),
    })
  }
  return out.sort((a, b) => a.corridor.localeCompare(b.corridor) || a.venue.localeCompare(b.venue) || a.side.localeCompare(b.side))
}
