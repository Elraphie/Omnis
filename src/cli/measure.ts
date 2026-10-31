import 'dotenv/config'
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Keeps a measurement desk running: paper mode on live quotes, shadow execution on, a wider size ladder,
 * restarted whenever it stops. Anything already set in the environment or .env wins over these defaults.
 */
const defaults: Record<string, string> = {
  MODE: 'paper',
  QUOTE_SOURCE: 'live',
  DATA_DIR: './data-measure',
  HOST: '127.0.0.1',
  PUBLIC_STATUS: '1',
  QUOTE_TIMEOUT_MS: '15000',
  SHADOW: '1',
  MAX_TRADE_USD: '1000',
  SIZE_LADDER: '1,0.5,0.25,0.1',
}
const env: NodeJS.ProcessEnv = { ...process.env }
for (const [key, value] of Object.entries(defaults)) {
  if (env[key] === undefined || env[key] === '') env[key] = value
}
if (env.MODE === 'live') {
  console.error('measure runs paper or dry-run only. Unset MODE=live.')
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const fromSource = import.meta.url.endsWith('.ts')
const args = fromSource
  ? ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(here, 'serve.ts')]
  : ['--disable-warning=ExperimentalWarning', join(here, 'serve.js')]
const logPath = join(env.DATA_DIR!, 'desk.log')
mkdirSync(env.DATA_DIR!, { recursive: true })

function note(line: string): void {
  const text = `${new Date().toISOString()} measure: ${line}\n`
  process.stdout.write(text)
  appendFileSync(logPath, text)
}

let stopping = false
let restarts = 0

function start(): void {
  const startedAt = Date.now()
  note(`starting desk (mode ${env.MODE}, shadow ${env.SHADOW}, sizes up to $${env.MAX_TRADE_USD}, data ${env.DATA_DIR})`)
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const tee = (chunk: Buffer) => {
    process.stdout.write(chunk)
    appendFileSync(logPath, chunk)
  }
  child.stdout.on('data', tee)
  child.stderr.on('data', tee)
  const forward = () => child.kill('SIGTERM')
  process.once('SIGINT', forward)
  process.once('SIGTERM', forward)
  child.on('exit', (code, signal) => {
    process.off('SIGINT', forward)
    process.off('SIGTERM', forward)
    if (stopping) return
    // A desk that ran for a while gets a quick restart; one that keeps dying at once backs off up to five minutes.
    restarts = Date.now() - startedAt > 120_000 ? 0 : restarts + 1
    const waitSec = Math.min(300, 15 * 2 ** restarts)
    note(`desk exited (code ${code ?? 'none'}, signal ${signal ?? 'none'}); restarting in ${waitSec}s`)
    setTimeout(start, waitSec * 1000)
  })
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopping = true
    note(`received ${signal}, stopping`)
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
start()
