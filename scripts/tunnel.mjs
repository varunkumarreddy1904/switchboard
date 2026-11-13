#!/usr/bin/env node
/**
 * Keeps the Live lab reachable from Meta.
 *
 * A cloudflared "quick tunnel" (https://<random>.trycloudflare.com) needs no account, but it is
 * temporary: when the Mac sleeps or the network drops, Cloudflare deletes it and it never comes back
 * ("Unauthorized: Tunnel not found"). This script watches the tunnel and, when it dies:
 *   1. starts a new one,
 *   2. saves the new address as Settings → Public URL,
 *   3. re-points Meta's webhook for every live Cloud API channel (same as the Live lab button).
 * Meta retries undelivered webhooks, so messages sent while the tunnel was down arrive afterwards.
 *
 *   npm run tunnel              # start the Switchboard server first (npm start)
 *   npm run tunnel -- --awake   # also stop the Mac from idle-sleeping while this runs
 *
 * Nothing helps while the Mac is asleep or the lid is closed on battery: messages wait at Meta and
 * arrive after it wakes and the tunnel is replaced (usually within a minute).
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const PORT = Number(process.env.PORT ?? 4000)
const API = `http://127.0.0.1:${PORT}/api`
const CHECK_EVERY_MS = 30_000
const FAILS_BEFORE_RESTART = 2

const log = (msg) => console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${msg}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function which(name) {
  for (const d of [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (d && existsSync(join(d, name))) return join(d, name)
  }
  return null
}

const cloudflared = which('cloudflared')
if (!cloudflared) {
  console.error('cloudflared is not installed. Run: brew install cloudflared')
  process.exit(1)
}

if (process.argv.includes('--awake')) {
  const caffeinate = which('caffeinate')
  if (caffeinate) {
    // Holds an "no idle sleep" assertion only while this script runs (-w: until this process exits).
    spawn(caffeinate, ['-i', '-w', String(process.pid)], { stdio: 'ignore' }).unref()
    log('Keeping the Mac from idle-sleeping while the tunnel runs (closing the lid on battery still sleeps it).')
  }
}

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  })
  return res.json()
}

let child = null
let url = null
let generation = 0
let restarting = false
let stopping = false
let fails = 0

async function healthy(u = url) {
  if (!u) return false
  try {
    const r = await fetch(`${u}/app`, { signal: AbortSignal.timeout(10_000) })
    return r.ok
  } catch {
    return false
  }
}

/** Public URL → Settings, then Meta's webhook → this URL, for each live Cloud API channel. */
async function wire(u, gen) {
  // A brand-new trycloudflare hostname can take a few seconds to resolve.
  for (let i = 0; i < 20 && gen === generation && !(await healthy(u)); i++) await sleep(1500)
  if (gen !== generation) return
  for (;;) {
    try {
      await api('POST', '/settings', { publicBaseUrl: u })
      break
    } catch {
      log(`Waiting for the Switchboard server on port ${PORT} (start it with: npm start)…`)
      await sleep(5000)
      if (gen !== generation) return
    }
  }
  log(`Public URL set: ${u}`)
  const channels = await api('GET', '/channels')
  const live = channels.filter((c) => c.kind === 'cloud' && c.mode === 'live')
  if (!live.length) log('No live Cloud API channel yet: add one in Live lab, then restart this script or press "Point Meta\'s webhook here".')
  for (const c of live) {
    if (!c.hasAppSecret) {
      log(`Skipping "${c.name}": add its App secret in Live lab first.`)
      continue
    }
    const r = await api('POST', `/channels/${c.id}/point-webhook`)
    log(r.ok ? `Meta's webhook for "${c.name}" now points at ${r.callbackUrl}` : `Could not re-point "${c.name}": ${r.error}`)
  }
  fails = 0
}

function start() {
  const gen = ++generation
  url = null
  log('Starting a Cloudflare quick tunnel…')
  child = spawn(cloudflared, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], { stdio: ['ignore', 'pipe', 'pipe'] })
  const onOutput = (buf) => {
    if (gen !== generation) return
    const text = buf.toString()
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
    if (m && !url) url = m[0]
    if (/Registered tunnel connection/.test(text) && url && !child.wired) {
      child.wired = true
      wire(url, gen).catch((e) => log(`Wiring failed: ${e.message}`))
    }
    if (/Tunnel not found/.test(text)) restart('Cloudflare deleted this temporary tunnel')
  }
  child.stdout.on('data', onOutput)
  child.stderr.on('data', onOutput)
  child.on('exit', (code) => {
    if (gen === generation && !stopping) restart(`cloudflared stopped (exit ${code})`)
  })
}

async function restart(reason) {
  if (restarting || stopping) return
  restarting = true
  log(`Tunnel down: ${reason}. Replacing it…`)
  generation++
  child?.kill()
  await sleep(2000)
  start()
  restarting = false
}

// Health check: catches silent failures (e.g. after the Mac wakes from sleep).
setInterval(async () => {
  if (!url || restarting || !child?.wired) return
  if (await healthy()) fails = 0
  else if (++fails >= FAILS_BEFORE_RESTART) restart('the public URL stopped answering')
}, CHECK_EVERY_MS)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true
    child?.kill()
    process.exit(0)
  })
}

start()
