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

export interface ShadowRow {
  corridor: string
  buyVenue: string
  sellVenue: string
  sizeUsd: number
  scanNetBps: number
  outcome: string
  netUsd: number | null
  netBps: number | null
  buyStatus: string
  sellStatus: string | null
  buyDriftBps: number | null
  sellDriftBps: number | null
  textileStatus: string | null
  textileDetail: string | null
  elapsedMs: number
}

export interface ShadowStats {
  runs: number
  outcomes: Record<string, number>
  wouldFillNetUsd: number
  medianNetBps: number | null
  /** Scan net minus re-priced net, per run with both legs priced: edge lost between seeing and acting. */
  medianDecayBps: number | null
  medianElapsedMs: number | null
  drift: { venue: string; side: 'buy' | 'sell'; runs: number; medianBps: number | null; p10Bps: number | null }[]
  textile: { status: string; runs: number; topDetail: string }[]
  routes: { route: string; runs: number; wouldFillShare: number; medianNetBps: number | null; bestNetUsd: number | null }[]
}

export function shadowStats(rows: ShadowRow[]): ShadowStats {
  const sorted = (values: number[]) => [...values].sort((a, b) => a - b)
  const outcomes: Record<string, number> = {}
  for (const row of rows) outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1
  const priced = rows.filter((row) => row.netBps !== null)
  const drift = new Map<string, { venue: string; side: 'buy' | 'sell'; values: number[] }>()
  const addDrift = (venue: string, side: 'buy' | 'sell', value: number | null) => {
    if (value === null) return
    const key = `${venue}|${side}`
    const entry = drift.get(key) ?? { venue, side, values: [] }
    entry.values.push(value)
    drift.set(key, entry)
  }
  const textile = new Map<string, { runs: number; details: Map<string, number> }>()
  const routes = new Map<string, ShadowRow[]>()
  for (const row of rows) {
    addDrift(row.buyVenue, 'buy', row.buyDriftBps)
    addDrift(row.sellVenue, 'sell', row.sellDriftBps)
    if (row.textileStatus) {
      const entry = textile.get(row.textileStatus) ?? { runs: 0, details: new Map<string, number>() }
      entry.runs += 1
      if (row.textileDetail) entry.details.set(row.textileDetail, (entry.details.get(row.textileDetail) ?? 0) + 1)
      textile.set(row.textileStatus, entry)
    }
    const key = routeKey(row)
    routes.set(key, [...(routes.get(key) ?? []), row])
  }
  return {
    runs: rows.length,
    outcomes,
    wouldFillNetUsd: rows.filter((row) => row.outcome === 'would_fill').reduce((sum, row) => sum + (row.netUsd ?? 0), 0),
    medianNetBps: quantile(sorted(priced.map((row) => row.netBps!)), 0.5),
    medianDecayBps: quantile(sorted(priced.map((row) => row.scanNetBps - row.netBps!)), 0.5),
    medianElapsedMs: quantile(sorted(rows.map((row) => row.elapsedMs)), 0.5),
    drift: [...drift.values()].map((entry) => {
      const values = sorted(entry.values)
      return { venue: entry.venue, side: entry.side, runs: values.length, medianBps: quantile(values, 0.5), p10Bps: quantile(values, 0.1) }
    }).sort((a, b) => a.venue.localeCompare(b.venue) || a.side.localeCompare(b.side)),
    textile: [...textile].map(([status, entry]) => ({
      status,
      runs: entry.runs,
      topDetail: [...entry.details].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
    })).sort((a, b) => b.runs - a.runs),
    routes: [...routes].map(([route, group]) => {
      const nets = group.filter((row) => row.netBps !== null)
      return {
        route,
        runs: group.length,
        wouldFillShare: group.filter((row) => row.outcome === 'would_fill').length / group.length,
        medianNetBps: quantile(sorted(nets.map((row) => row.netBps!)), 0.5),
        bestNetUsd: nets.length ? Math.max(...nets.map((row) => row.netUsd ?? -Infinity)) : null,
      }
    }).sort((a, b) => b.runs - a.runs),
  }
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
