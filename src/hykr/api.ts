import { createReadStream, existsSync } from 'node:fs'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import QRCode from 'qrcode'
import type { Agent } from '../agent/agent'
import { SANDBOX_CLOUD } from '../agent/channels'
import { signToken } from '../shared/crypto'
import { timingReport } from '../agent/timing'
import type { SandboxWorld } from '../sandbox/world'
import { FUNNEL, type Hykr } from './brain'
import { classLabel } from './parse'
import type { HxMachine } from './store'

const bad = (reply: FastifyReply, error: string, code = 400) => reply.code(code).send({ ok: false, error })

const STATUS_LABEL: Record<string, string> = { draft: 'Draft', pending: 'Under review', needs_info: 'Needs one more thing', active: 'Live', rejected: 'Not approved', paused: 'Paused' }

/** Plain-language "what happens next" for the owner's current step (shown in the app). */
const NEXT: Record<string, string> = {
  c1: 'Agree to share your basic details on WhatsApp',
  name: 'Send your full name on WhatsApp',
  name_confirm: 'Confirm your name on WhatsApp',
  village: 'Send your village or town on WhatsApp',
  village_confirm: 'Confirm your village on WhatsApp',
  role: 'Tell us if you drive the machine yourself',
  c2: 'Agree to share your machine papers',
  c2_declined: 'Send PAPERS on WhatsApp when you are ready to share your papers',
  class: 'Choose your machine type',
  class_other: 'Tell us what kind of machine it is',
  photo_machine: 'Send a photo of your machine',
  rc: 'Send a photo of the RC',
  invoice: 'Send a photo of the purchase invoice',
  insurance: 'Send a photo of the insurance',
  pin_plate: 'Send a photo of the PIN plate',
  hour_meter: 'Send a photo of the hour meter',
  location: 'Share where the machine is parked',
  video: 'Optional: send a short walkaround video',
  details: 'Check the details we read from your papers',
  relationship: 'Tell us whose name is on the RC',
  rel_proof: 'Send a document showing the relationship',
  rate_hour: 'Send your lowest rate per hour',
  rate_hour_confirm: 'Confirm your hourly rate',
  rate_day: 'Send your lowest rate per day',
  diesel: 'Tell us who provides the diesel',
  radius: 'Tell us how far you will travel',
  summary: 'Check the summary and submit',
  edit: 'Choose what to change',
  more: 'Add another machine, or say you are done',
  manager: 'Send your manager’s number',
  needs_info: 'Send the extra photo our team asked for',
  registered: 'All done: we will message you when your machines are verified',
  paused: 'Messages are stopped: send START on WhatsApp to come back',
  confirm_mitra: 'Confirm your registration on WhatsApp',
}

function machineView(hykr: Hykr, m: HxMachine, evidenceUrl: (id: string) => string) {
  return {
    ...m,
    label: [classLabel(m.class, m.class_other), [m.make, m.model].filter(Boolean).join(' ')].filter(Boolean).join(' · '),
    classLabel: classLabel(m.class, m.class_other),
    statusLabel: STATUS_LABEL[m.status] ?? m.status,
    // Sent to the EquipXchange app: its desk decides, this page only shows the result (D76).
    decidedIn: (() => {
      const ext = hykr.externalDesk?.(m.id)
      return ext ? { app: 'EquipXchange', code: ext.code, url: process.env.EQX_WEB_URL || 'http://localhost:8081' } : null
    })(),
    driver: hykr.store.driver(m.owner_id) ?? null,
    flags: hykr.store.flags(m),
    evidence: hykr.store.evidenceFor(m.id).map((e) => ({ id: e.id, kind: e.kind, mime: e.mime, bytes: e.bytes, sha256: e.sha256, read: e.read ? JSON.parse(e.read) : null, readEngine: e.read_engine, created_at: e.created_at, url: evidenceUrl(e.id) })),
  }
}

/** Desk console API (localhost only: the tunnel guard blocks /api/* except /api/app/*). */
export function hykrConsoleApi(agent: Agent, hykr: Hykr): FastifyPluginAsync {
  const store = hykr.store
  const url = (id: string) => `/api/hx/evidence/${id}`
  return async (app) => {
    app.get<{ Querystring: { q?: string } }>('/owners', async (req) => {
      const q = `%${(req.query.q ?? '').trim()}%`
      const rows = store.sql.all<any>(
        `select p.*, f.step as flow_step, f.updated_at as flow_at from hx_people p left join hx_flow f on f.actor_id = p.person_id
         where (p.name like ? or p.phone like ? or p.id like ? or p.village like ?) order by p.created_at desc limit 300`,
        q,
        q,
        q,
        q,
      )
      return rows.map((p) => {
        const ms = store.machines(p.id)
        return { ...p, roles: JSON.parse(p.roles || '[]'), machines: ms.length, live: ms.filter((m) => m.status === 'active').length, pending: ms.filter((m) => m.status === 'pending' || m.status === 'needs_info').length, next: NEXT[p.flow_step] ?? p.flow_step }
      })
    })
    app.get<{ Params: { id: string } }>('/owners/:id', async (req, reply) => {
      const p = store.person(req.params.id)
      if (!p) return bad(reply, 'not found', 404)
      const flow = store.flow(p.person_id)
      const conv = agent.store.sql.get<{ id: string }>("select id from conversations where person_id=? and kind='dm' order by last_message_at desc limit 1", p.person_id)
      return {
        person: { ...p, roles: JSON.parse(p.roles || '[]') },
        flow: flow ? { step: flow.step, next: NEXT[flow.step] ?? flow.step, role: flow.role, updated_at: flow.updated_at, reminders: flow.reminders } : null,
        consents: store.consents(p.id),
        machines: store.machines(p.id).map((m) => machineView(hykr, m, url)),
        delegates: store.sql.all<any>('select * from hx_delegates where owner_id=?', p.id),
        events: store.events(p.id),
        conversationId: conv?.id ?? null,
      }
    })
    app.get<{ Querystring: { status?: string } }>('/machines', async (req) => {
      const status = req.query.status ?? 'queue'
      const where = status === 'queue' ? "m.status in ('pending','needs_info')" : status === 'all' ? '1=1' : 'm.status=?'
      const rows = store.sql.all<any>(
        `select m.*, p.name as owner_name, p.phone as owner_phone, p.village as owner_village from hx_machines m left join hx_people p on p.id=m.owner_id where ${where} and (m.class is not null or m.status != 'draft') order by coalesce(m.submitted_at, m.created_at)`,
        ...(status === 'queue' || status === 'all' ? [] : [status]),
      )
      return rows.map((r) => ({ ...machineView(hykr, r, url), owner: { id: r.owner_id, name: r.owner_name, phone: r.owner_phone, village: r.owner_village } }))
    })
    app.get<{ Params: { id: string } }>('/evidence/:id', async (req, reply) => {
      const e = store.evidence(req.params.id)
      if (!e || !existsSync(e.path)) return bad(reply, 'not found', 404)
      return reply.type(e.mime).header('cache-control', 'no-store').send(createReadStream(e.path))
    })
    // A refused decision (a machine the app decides) is a 409, so the console shows why instead of "done".
    const decided = (reply: FastifyReply, r: { ok: boolean; error?: string }) => (r.ok ? r : bad(reply, r.error ?? 'refused', 409))
    app.post<{ Params: { id: string }; Body: { by?: string } }>('/machines/:id/approve', async (req, reply) => decided(reply, await hykr.deskApprove(req.params.id, req.body?.by || 'desk')))
    app.post<{ Params: { id: string }; Body: { kind?: string; note?: string; by?: string } }>('/machines/:id/ask', async (req, reply) =>
      decided(reply, await hykr.deskAsk(req.params.id, req.body?.kind || 'other', (req.body?.note ?? '').trim(), req.body?.by || 'desk')),
    )
    app.post<{ Params: { id: string }; Body: { reason?: string; by?: string } }>('/machines/:id/reject', async (req, reply) => {
      const reason = (req.body?.reason ?? '').trim()
      if (!reason) return bad(reply, 'A reason is required: the owner is told why')
      return decided(reply, await hykr.deskReject(req.params.id, reason, req.body?.by || 'desk'))
    })
    app.get('/funnel', async () => ({ ...hykr.funnel(), order: [...FUNNEL, 'submitted', 'verified'] }))
    app.get<{ Querystring: { hours?: string } }>('/speed', async (req) => timingReport(agent.store.sql, Number(req.query.hours ?? 24)))
    app.get('/mitras', async () => store.sql.all('select * from hx_mitras order by added_at'))
    app.post<{ Body: { phone?: string; name?: string } }>('/mitras', async (req, reply) => {
      const phone = String(req.body?.phone ?? '').replace(/\D/g, '')
      if (phone.length < 10) return bad(reply, 'Enter the Mitra’s WhatsApp number with country code')
      store.sql.run('insert or replace into hx_mitras(phone, name, added_at) values(?,?,?)', phone.length === 10 ? `91${phone}` : phone, (req.body?.name ?? '').trim() || 'Mitra', Date.now())
      agent.bus.change('hykr')
      return { ok: true }
    })
    app.delete<{ Params: { phone: string } }>('/mitras/:phone', async (req) => {
      store.sql.run('delete from hx_mitras where phone=?', req.params.phone)
      agent.bus.change('hykr')
      return { ok: true }
    })
    app.get('/settings', async () => ({ claudeInSandbox: hykr.reader.claudeInSandbox }))
    app.post<{ Body: { claudeInSandbox?: boolean } }>('/settings', async (req) => {
      if (req.body?.claudeInSandbox !== undefined) {
        hykr.reader.claudeInSandbox = !!req.body.claudeInSandbox
        agent.store.setSetting('hxClaudeInSandbox', req.body.claudeInSandbox ? '1' : null)
      }
      return { ok: true, claudeInSandbox: hykr.reader.claudeInSandbox }
    })
  }
}

/**
 * The HYKR app's API: sign-in (Continue on WhatsApp, or a code on WhatsApp) and the owner's own view of
 * their registration. Served on the main port under /api/app (reachable through the tunnel, so sign-in
 * links work on a phone) and on the app's own port.
 */
export function appApi(agent: Agent, hykr: Hykr, world?: SandboxWorld): FastifyPluginAsync {
  const store = hykr.store
  const sessionOf = (req: FastifyRequest) => String((req.headers['x-app-session'] as string | undefined) ?? (req.query as any)?.s ?? '') || undefined
  return async (app) => {
    app.get('/channels', async () => agent.channels.all().filter((c) => c.kind === 'cloud').map((c) => ({ id: c.id, name: c.name, mode: c.mode, phone: (c.config as any).displayPhone ?? null })))
    app.post<{ Body: { channelId?: string } }>('/session', async (req) => {
      const s = agent.onboarding.createSession(req.body?.channelId ?? SANDBOX_CLOUD)
      const qr = await QRCode.toDataURL(s.waLink, { margin: 1, width: 220 })
      return { ...s, qr }
    })
    app.get<{ Params: { id: string } }>('/session/:id', async (req, reply) => agent.onboarding.session(req.params.id) ?? bad(reply, 'not found', 404))
    app.post<{ Body: { sessionId: string; phone: string } }>('/otp/start', async (req) => agent.onboarding.startOtp(req.body.sessionId, req.body.phone))
    app.get<{ Params: { id: string } }>('/otp/:id', async (req, reply) => agent.onboarding.otpStatus(req.params.id) ?? bad(reply, 'not found', 404))
    app.post<{ Body: { otpId: string; code: string } }>('/otp/verify', async (req) => agent.onboarding.verifyOtp(req.body.otpId, req.body.code))
    app.post<{ Body: { token: string } }>('/magic', async (req) => agent.onboarding.redeemMagic(req.body.token))
    app.post('/logout', async (req) => {
      const s = sessionOf(req)
      if (s) agent.onboarding.signOut(s)
      return { ok: true }
    })

    /** Everything the signed-in owner can see about their own registration. */
    app.get('/me', async (req, reply) => {
      const sid = sessionOf(req)
      const personId = agent.onboarding.signedInPerson(sid)
      if (!personId) return bad(reply, 'not signed in', 401)
      const sess = agent.store.sql.get<{ channel_id: string }>('select channel_id from app_sessions where id=?', sid)!
      const ch = agent.channels.get(sess.channel_id)
      const phone = String((ch?.config as any)?.displayPhone ?? '').replace(/\D/g, '')
      const sb = agent.store.person(personId)
      const p = store.personBySwitchboard(personId)
      const flow = store.flow(personId)
      // A manager sees the owner they manage.
      const ownerId = p?.id ?? (flow?.role === 'delegate' ? flow.owner_id : null)
      const owner = ownerId ? store.person(ownerId) : undefined
      const evidenceUrl = (id: string) => `/api/app/evidence/${id}?s=${encodeURIComponent(sid!)}`
      return {
        signedIn: true,
        channel: { id: sess.channel_id, mode: ch?.mode ?? 'sandbox', phone },
        waLink: phone ? `https://wa.me/${phone}?text=${encodeURIComponent('Hi')}` : null,
        person: owner ? { ...owner, roles: JSON.parse(owner.roles || '[]') } : { name: sb?.display_name ?? null, phone: agent.store.links(personId).find((l) => l.kind === 'pn')?.value ?? null },
        registered: !!owner,
        role: flow?.role ?? 'owner',
        step: flow?.step ?? null,
        next: flow ? (NEXT[flow.step] ?? null) : 'Continue on WhatsApp to register your machine',
        consents: owner ? store.consents(owner.id) : [],
        machines: owner ? store.machines(owner.id).filter((m) => m.class || m.status !== 'draft').map((m) => machineView(hykr, m, evidenceUrl)) : [],
      }
    })
    app.get<{ Params: { id: string } }>('/evidence/:id', async (req, reply) => {
      const personId = agent.onboarding.signedInPerson(sessionOf(req))
      const e = store.evidence(req.params.id)
      const owner = personId ? store.personBySwitchboard(personId) : undefined
      const flow = personId ? store.flow(personId) : undefined
      const allowed = !!e && (e.owner_id === owner?.id || (flow?.role === 'delegate' && e.owner_id === flow.owner_id))
      if (!allowed || !existsSync(e!.path)) return bad(reply, 'not found', 404)
      return reply.type(e!.mime).header('cache-control', 'private, max-age=300').send(createReadStream(e!.path))
    })

    /** Sandbox only: play the owner's phone from the app (a simulated persona sends START <this session's token>). */
    app.post<{ Body: { sessionId?: string; persona?: string } }>('/sandbox-start', async (req, reply) => {
      const s = agent.store.sql.get<{ id: string; channel_id: string; nonce_used: number }>('select id, channel_id, nonce_used from app_sessions where id=?', req.body?.sessionId ?? '')
      if (!world || !s || agent.channels.get(s.channel_id)?.mode !== 'sandbox') return bad(reply, 'Only for sandbox sessions')
      if (s.nonce_used) return bad(reply, 'This sign-in was already used')
      return world.personaSend(req.body?.persona ?? 'ravi', 'dm', `START ${signToken(agent.secret, s.id, 10 * 60 * 1000)}`)
    })
  }
}
