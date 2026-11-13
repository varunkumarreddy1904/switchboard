import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { existsSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { Agent } from './agent/agent'
import { consoleApi } from './agent/api'
import { SANDBOX_CLOUD, SANDBOX_LINKED } from './agent/channels'
import { cloudWebhook, drainInbox, settleReplies } from './agent/cloud'
import { sandboxApi } from './sandbox/api'
import { graphRoutes } from './sandbox/graph'
import { BUSINESS } from './sandbox/seed'
import { SandboxWorld } from './sandbox/world'
import { SANDBOX_MITRAS } from './sandbox/seed'
import { appApi, hykrConsoleApi } from './hykr/api'
import { EqxBridge, type EqxBridgeOptions } from './bridge/eqx'
import { Hykr } from './hykr/brain'
import { Bus } from './shared/bus'
import { randomToken } from './shared/crypto'
import { Sql } from './shared/db'

export interface AppOptions {
  port?: number
  host?: string
  dataDir?: string
  memory?: boolean
  web?: boolean
  /** Tests: speak with a fixed short clip instead of the machine's voices. */
  voiceStub?: boolean
  /** Port for the HYKR app (owner-facing). 0 = don't start it. Default 5175 when the web build exists. */
  appPort?: number
  /** Bridge to the EquipXchange app; defaults to `EQX_API_URL` + `EQX_BRIDGE_SECRET` from the environment. */
  eqx?: EqxBridgeOptions
}

/**
 * One process, clear boundaries:
 *  /graph/*        sandbox: Graph-API-compatible facade (stands in for graph.facebook.com)
 *  /sandbox/api/*  sandbox: persona phones, faults, scenes
 *  /webhook/:id    agent:   Cloud API webhook receiver (sandbox or live channels)
 *  /api/*          agent:   console API (inbox, contacts, templates, groups, live lab)
 * The Cloud lane goes over real HTTP even locally, so signatures, raw bodies and retries are real.
 */
export async function createApp(opts: AppOptions = {}) {
  const host = opts.host ?? process.env.HOST ?? '127.0.0.1'
  const port = opts.port ?? Number(process.env.PORT ?? 4000)
  const dataDir = resolve(opts.dataDir ?? process.env.DATA_DIR ?? 'data')
  const bus = new Bus()
  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 })
  const sql = new Sql(opts.memory ? ':memory:' : join(dataDir, 'agent.db'))
  const world = new SandboxWorld(bus, '')
  const agent = new Agent({
    sql,
    bus,
    dataDir,
    sandboxLinkedFactory: async () => {
      world.onSocketConnect()
      return world.socket
    },
  })

  // Sandbox voice notes: the persona's words are the transcript (Whisper is for live numbers).
  agent.voice.scripted = (mediaId) => {
    const s = world.mediaScript(mediaId)
    return s?.text ? { text: s.text, lang: s.lang ?? 'en' } : undefined
  }
  agent.voice.stubSpeech = !!opts.voiceStub || process.env.VOICE_STUB === '1'

  // PoC #12: EquipXchange (HYKR) owner onboarding is the brain behind the WhatsApp number.
  const hykr = new Hykr(agent, dataDir)
  hykr.reader.scripted = (mediaId) => world.mediaScript(mediaId)?.doc
  hykr.reader.claudeInSandbox = agent.store.setting('hxClaudeInSandbox') === '1'
  hykr.sandboxMitras = SANDBOX_MITRAS

  // EquipXchange app bridge: offers, prices and job cards out; button taps and finished registrations in.
  const eqx = opts.eqx ? new EqxBridge(agent, hykr, { dataDir, ...opts.eqx }) : EqxBridge.fromEnv(agent, hykr, dataDir)

  // The console has no login. When this server is reached through a public tunnel (cloudflared,
  // ngrok), expose only what Meta and the end user's phone need: webhooks and the app stub.
  app.addHook('onRequest', async (req, reply) => {
    if (isLocalRequest(req.headers)) return
    const path = req.url.split('?')[0]
    // /pay/ is the EquipXchange test pay page (it only relays to the app's token-checked endpoints).
    const allowed = path.startsWith('/webhook/') || path === '/app' || path.startsWith('/app/') || path.startsWith('/api/app/') || path.startsWith('/assets/') || (!!eqx && path.startsWith('/pay/'))
    if (!allowed) return reply.code(403).send({ error: 'The console is only available on localhost. Public URLs expose /webhook and /app only.' })
  })

  await app.register(graphRoutes(world), { prefix: '/graph' })
  await app.register(cloudWebhook(agent))
  await app.register(consoleApi(agent), { prefix: '/api' })
  await app.register(hykrConsoleApi(agent, hykr), { prefix: '/api/hx' })
  await app.register(appApi(agent, hykr, world), { prefix: '/api/app' })
  await app.register(sandboxApi(world, agent, () => app), { prefix: '/sandbox/api' })
  // Local only (the tunnel guard above refuses /bridge from outside): the app calls it on this machine.
  if (eqx) await app.register(eqx.routes(), { prefix: '/bridge/eqx' })
  if (eqx) await app.register(eqx.payRoutes())

  const webRoot = resolve('dist/web')
  const serveWeb = opts.web !== false && existsSync(join(webRoot, 'index.html'))
  if (serveWeb) {
    await app.register(fastifyStatic, { root: webRoot, prefix: '/', wildcard: true })
  }
  app.setNotFoundHandler((req, reply) => {
    const apiish = /^\/(api|graph|sandbox|webhook|pay|bridge)\b/.test(req.url)
    // /app and /app/magic/<token> are the HYKR app (sign-in links sent on WhatsApp open here).
    if (serveWeb && req.method === 'GET' && /^\/app(\/|$|\?)/.test(req.url)) return reply.type('text/html').sendFile('app.html')
    if (serveWeb && req.method === 'GET' && !apiish) return reply.type('text/html').sendFile('index.html')
    return reply.code(404).send({ error: 'not found', path: req.url })
  })

  // The HYKR app on its own port too (localhost), so it can be opened next to the console.
  let site: FastifyInstance | null = null
  const appPort = opts.appPort ?? Number(process.env.APP_PORT ?? 5175)
  if (serveWeb && appPort && existsSync(join(webRoot, 'app.html'))) {
    site = Fastify({ logger: false }) as unknown as FastifyInstance
    await site.register(appApi(agent, hykr, world), { prefix: '/api/app' })
    await site.register(fastifyStatic, { root: webRoot, prefix: '/', index: 'app.html', wildcard: true })
    site.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) =>
      req.method === 'GET' && !req.url.startsWith('/api/') ? reply.type('text/html').sendFile('app.html') : reply.code(404).send({ error: 'not found' }),
    )
    try {
      await site.listen({ port: appPort, host })
    } catch (e) {
      bus.log({ kind: 'agent', lane: '-', title: `HYKR app could not start on port ${appPort}`, detail: (e as Error).message })
      site = null
    }
  }

  await app.listen({ port, host })
  const addr = app.server.address() as AddressInfo
  const base = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${addr.port}`
  world.business.webhookUrl = `${base}/webhook/${SANDBOX_CLOUD}`
  // The simulated world lives in memory, so sandbox-channel data from a previous run would point
  // at phones that no longer remember it. Start both sides fresh; live channels are untouched.
  agent.store.clearChannelData([SANDBOX_CLOUD, SANDBOX_LINKED])
  hykr.purgeMissing()
  agent.init(base)
  agent.voice.start()
  hykr.start()
  eqx?.start()
  if (eqx) bus.log({ kind: 'agent', lane: 'A', title: 'EquipXchange bridge on', detail: `${eqx.opts.apiUrl} via channel ${eqx.channelId}` })
  await drainInbox(agent)

  // Same handshake Meta performs when you save a webhook URL in the app dashboard.
  const challenge = randomToken(8)
  try {
    const r = await fetch(`${world.business.webhookUrl}?hub.mode=subscribe&hub.verify_token=${BUSINESS.verifyToken}&hub.challenge=${challenge}`)
    const echoed = (await r.text()) === challenge
    bus.log({ kind: 'webhook.out', lane: 'A', title: 'GET webhook verify handshake', status: r.status, detail: echoed ? 'hub.challenge echoed: webhook verified' : 'verification failed' })
  } catch (e) {
    bus.log({ kind: 'webhook.out', lane: 'A', title: 'GET webhook verify handshake failed', detail: (e as Error).message })
  }

  return {
    app,
    world,
    agent,
    bus,
    base,
    serveWeb,
    hykr,
    eqx,
    appUrl: site ? `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${appPort}` : null,
    async close() {
      world.stop()
      agent.voice.stop()
      hykr.stop()
      eqx?.stop()
      await site?.close()
      for (const r of agent.linked.runners.values()) await r.disconnect().catch(() => undefined)
      await app.close()
      await settleReplies()
      sql.close()
    },
  }
}

/** True for requests made on this machine (not forwarded by a tunnel or proxy). */
export function isLocalRequest(h: Record<string, string | string[] | undefined>) {
  if (h['cf-connecting-ip'] || h['x-forwarded-for'] || h['x-forwarded-host'] || h['forwarded']) return false
  const host = String(h.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
  return ['localhost', '127.0.0.1', '::1'].includes(host)
}
