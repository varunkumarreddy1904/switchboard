import type { FastifyInstance, FastifyPluginAsync } from 'fastify'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Agent } from '../agent/agent'
import { STUB_OGG } from '../agent/voice/ogg'
import { playChatter, type ChatterResult } from './chatter'
import { runScene, SCENES, type SceneResult } from './scenes'
import type { LinkedMsgKind } from './types'
import type { SandboxWorld } from './world'

const FIXTURES = resolve('fixtures/synthetic')
let fixtures: { file: string; kind: string; fields: Record<string, string> }[] | null = null
export function loadFixtures() {
  if (!fixtures) fixtures = existsSync(join(FIXTURES, 'index.json')) ? JSON.parse(readFileSync(join(FIXTURES, 'index.json'), 'utf8')) : []
  return fixtures!
}

/** Control surface for the simulator UI: act as personas, inject faults, run scenes. */
export function sandboxApi(world: SandboxWorld, agent: Agent, root: () => FastifyInstance): FastifyPluginAsync {
  const sceneResults = new Map<number, SceneResult>()
  let chatterRunning = false
  let sceneRunning: number | null = null

  return async (app) => {
    app.get('/state', async () => ({ ...world.stateView(), chatterRunning, sceneRunning }))

    app.get<{ Params: { id: string } }>('/personas/:id', async (req, reply) => world.personaView(req.params.id) ?? reply.code(404).send({ error: 'not found' }))

    app.post<{ Params: { id: string }; Body: { chatId: string; text: string } }>('/personas/:id/send', async (req) => world.personaSend(req.params.id, req.body.chatId ?? 'dm', req.body.text ?? ''))

    // A persona records a voice note: the words are spoken with the agent's voice engine (or a stub clip in tests).
    app.post<{ Params: { id: string }; Body: { chatId?: string; text?: string; lang?: string } }>('/personas/:id/voice', async (req) => {
      const text = String(req.body?.text ?? '').trim()
      const lang = req.body?.lang === 'hi' ? 'hi' : 'en'
      if (!text) return { ok: false, error: 'Type what the persona says' }
      let bytes: Buffer
      try {
        bytes = await agent.voice.synthesize(text, lang)
      } catch {
        bytes = STUB_OGG // no speech engine on this machine: the note still works, it just plays a tone
      }
      return world.personaVoice(req.params.id, req.body?.chatId ?? 'dm', bytes, { text, lang })
    })
    // Synthetic photos (RC, PIN plate, hour meter …) personas can send: fixtures/synthetic/index.json.
    app.get('/fixtures', async () => loadFixtures().map(({ file, kind, fields }) => ({ file, kind, fields })))
    app.get<{ Params: { file: string } }>('/fixtures/:file', async (req, reply) => {
      const f = loadFixtures().find((x) => x.file === req.params.file)
      return f ? reply.type('image/jpeg').send(readFileSync(join(FIXTURES, f.file))) : reply.code(404).send({ error: 'not found' })
    })
    app.post<{ Params: { id: string }; Body: { file?: string; caption?: string } }>('/personas/:id/media', async (req) => {
      const f = loadFixtures().find((x) => x.file === req.body?.file)
      if (!f) return { ok: false, error: 'unknown fixture' }
      return world.personaImage(req.params.id, { name: f.file, bytes: readFileSync(join(FIXTURES, f.file)), mime: 'image/jpeg', doc: { kind: f.kind, fields: f.fields } }, req.body?.caption)
    })
    app.post<{ Params: { id: string }; Body: { lat?: number; lng?: number; name?: string; address?: string } }>('/personas/:id/location', async (req) =>
      world.personaLocation(req.params.id, { lat: Number(req.body?.lat ?? 17.997), lng: Number(req.body?.lng ?? 79.585), name: req.body?.name ?? 'Kazipet', address: req.body?.address }),
    )
    app.post<{ Params: { id: string }; Body: { name?: string; phone?: string } }>('/personas/:id/contact', async (req) =>
      world.personaContact(req.params.id, { name: req.body?.name ?? 'Contact', phone: req.body?.phone ?? '' }),
    )
    app.get<{ Params: { id: string } }>('/media/:id', async (req, reply) => {
      const m = world.mediaBytes(req.params.id)
      return m ? reply.type(m.mime).send(m.bytes) : reply.code(404).send({ error: 'not found' })
    })
    app.post<{ Params: { id: string }; Body: { chatId: string; messageId: string; buttonId: string } }>('/personas/:id/tap', async (req) =>
      world.personaTap(req.params.id, req.body.chatId ?? 'dm', req.body.messageId, req.body.buttonId),
    )

    app.post<{ Params: { id: string }; Body: { link: string } }>('/personas/:id/join', async (req) => world.personaJoin(req.params.id, req.body.link ?? ''))
    app.post<{ Params: { id: string }; Body: { groupId: string } }>('/personas/:id/leave', async (req) => world.personaLeave(req.params.id, req.body.groupId))

    app.post<{ Params: { id: string }; Body: { jid: string; kind: LinkedMsgKind; text?: string; targetId?: string } }>('/personas/:id/linked', async (req) =>
      world.personaLinked(req.params.id, req.body.jid, req.body.kind, req.body.text ?? '', req.body.targetId),
    )

    app.post<{ Params: { id: string } }>('/personas/:id/expire-window', async (req) => {
      world.expireWindow(req.params.id)
      return { ok: true }
    })
    app.post<{ Params: { id: string } }>('/personas/:id/reveal-lid', async (req) => {
      world.revealLidMapping(req.params.id)
      return { ok: true }
    })

    app.post<{ Body: { on: boolean } }>('/business/oba', async (req) => {
      world.setOba(!!req.body?.on)
      return { ok: true }
    })
    app.post<{ Body: { duplicateRate?: number; outOfOrder?: boolean; autoRead?: boolean } }>('/faults', async (req) => {
      const b = req.body ?? {}
      if (b.duplicateRate !== undefined) world.faults.duplicateRate = Math.max(0, Math.min(1, Number(b.duplicateRate)))
      if (b.outOfOrder !== undefined) world.faults.outOfOrder = !!b.outOfOrder
      if (b.autoRead !== undefined) world.autoRead = !!b.autoRead
      agent.bus.log({ kind: 'sandbox', lane: 'A', title: 'Faults updated', detail: `duplicates ${Math.round(world.faults.duplicateRate * 100)}% · out-of-order ${world.faults.outOfOrder ? 'on' : 'off'} · auto-read ${world.autoRead ? 'on' : 'off'}` })
      agent.bus.change('sandbox')
      return { ok: true, faults: world.faults }
    })

    app.post('/device/scan', async () => world.scanQr())
    app.post('/device/ban', async () => world.ban())
    app.post<{ Body: { jid: string } }>('/member/join', async (req) => world.memberJoin(req.body.jid))

    app.post('/chatter/play', async (req, reply) => {
      if (chatterRunning) return reply.code(409).send({ ok: false, error: 'already playing' })
      chatterRunning = true
      agent.bus.change('sandbox')
      const results: ChatterResult[] = []
      playChatter(world, 350, (r) => {
        results.push(r)
        if (!r.ok) agent.bus.log({ kind: 'sandbox', lane: 'B', title: `Chatter step ${r.step} rejected`, detail: `${r.label}: ${r.error}` })
      }).finally(() => {
        chatterRunning = false
        agent.bus.change('sandbox')
      })
      return { ok: true, steps: 40 }
    })

    app.post('/reset', async () => {
      world.reset()
      agent.resetSandboxData()
      sceneResults.clear()
      agent.bus.clear()
      agent.bus.log({ kind: 'sandbox', lane: '-', title: 'Sandbox reset', detail: 'world re-seeded, sandbox channel data cleared; live channels untouched' })
      return { ok: true }
    })

    app.get('/scenes', async () => SCENES.map((s) => ({ id: s.id, title: s.title, shows: s.shows, result: sceneResults.get(s.id) ?? null, running: sceneRunning === s.id })))

    app.post<{ Params: { id: string } }>('/scenes/:id/run', async (req, reply) => {
      if (sceneRunning !== null) return reply.code(409).send({ ok: false, error: `scene ${sceneRunning} is running` })
      const id = Number(req.params.id)
      sceneRunning = id
      agent.bus.change('scenes')
      try {
        const r = await runScene(root(), world, agent, id)
        sceneResults.set(id, r)
        return r
      } finally {
        sceneRunning = null
        agent.bus.change('scenes')
        agent.bus.change('sandbox')
      }
    })
  }
}
