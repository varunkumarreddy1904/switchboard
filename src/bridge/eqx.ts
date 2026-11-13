import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Agent } from '../agent/agent'
import { SANDBOX_CLOUD } from '../agent/channels'
import type { InboundDm } from '../agent/inbound'
import type { Hykr } from '../hykr/brain'

/**
 * Bridge to the EquipXchange app (the system of record): Switchboard stays the WhatsApp layer.
 *
 *  App → Switchboard (signed):  POST /bridge/eqx/send             a message (text or reply buttons)
 *                               POST /bridge/eqx/otp              a sign-in code (`otp_login` template)
 *                               POST /bridge/eqx/machine-status   the desk's decision on a WhatsApp-onboarded machine
 *                               GET  /bridge/eqx/evidence/:id     a photo or paper the owner sent
 *  Switchboard → App (signed):  POST /integrations/switchboard/inbound    taps on `eqx:` buttons
 *                               POST /integrations/switchboard/onboarded  an owner who finished registration
 *
 * Both directions sign `<timestamp>.<raw body>` (GET: `GET <path>`) with HMAC-SHA256 and a shared
 * secret; requests older than five minutes are refused. Outside the 24-hour window a message can't
 * be free text, so the `eqx_update` template goes out and the message waits until the person replies.
 */

export const SIGNATURE_HEADER = 'x-eqx-signature'
export const TIMESTAMP_HEADER = 'x-eqx-timestamp'
export const EQX_TEMPLATE = 'eqx_update'
export const SEE_DETAILS = 'See details'
const MAX_SKEW_MS = 5 * 60_000
const WINDOW_MS = 24 * 60 * 60 * 1000
const RETRY_MS = 30_000
const MAX_SYNC_ATTEMPTS = 10

export function sign(secret: string, timestamp: string, raw: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex')
}

export function verify(secret: string, timestamp: string | undefined, raw: string, signature: string | undefined, now = Date.now()): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false
  if (Math.abs(now - Number(timestamp)) > MAX_SKEW_MS) return false
  const want = Buffer.from(sign(secret, timestamp, raw), 'hex')
  const got = Buffer.from(signature, 'hex')
  return want.length === got.length && timingSafeEqual(want, got)
}

const CLASS: Record<string, string> = { backhoe_loader: 'BACKHOE_LOADER', excavator: 'EXCAVATOR', breaker: 'BREAKER', tipper: 'TIPPER' }
const OTHER_CLASS: [RegExp, string][] = [
  [/roller/i, 'ROLLER'],
  [/crane/i, 'CRANE'],
]
const EVIDENCE_KIND: Record<string, string> = { machine: 'MACHINE_PHOTO', rc: 'RC', invoice: 'INVOICE', insurance: 'INSURANCE', pin_plate: 'PIN_PLATE', hour_meter: 'HOUR_METER', other: 'OTHER' }
/** What the app's desk asked for (`need`), as HYKR's kind for the owner's next reply (D79). */
const NEED_KIND: Record<string, string> = {
  MACHINE_PHOTO: 'machine',
  RC: 'rc',
  INVOICE: 'invoice',
  INSURANCE: 'insurance',
  PIN_PLATE: 'pin_plate',
  HOUR_METER: 'hour_meter',
  DRIVER: 'driver',
  OTHER: 'other',
}
/** HYKR's flags in the desk's words; they travel with the machine so nothing found on WhatsApp is lost. */
const FLAG_NOTE: Record<string, string> = {
  rc_in_family_name: 'RC is in a family member’s name',
  rc_other_person: 'RC is in someone else’s name',
  relationship_proof_later: 'Proof of relationship to the RC holder still to come',
  insurance_expired: 'Insurance has expired',
  insurance_later: 'Insurance paper still to come',
  no_papers: 'No RC or invoice (second-hand, unregistered)',
  no_papers_consent: 'Owner said no to sharing papers',
  pin_plate_missing: 'No PIN plate photo',
  owner_denied_mitra: 'Owner said the Mitra’s paper form was wrong',
}
const STATUS: Record<string, 'active' | 'needs_info' | 'rejected' | 'paused'> = { ACTIVE: 'active', PENDING: 'needs_info', REJECTED: 'rejected', PAUSED: 'paused' }

/** A message to deliver: text, up to 3 reply buttons, or a list (WhatsApp limits). */
interface Reply {
  text: string
  buttons?: { id: string; title: string }[]
  list?: { button: string; rows: { id: string; title: string; description?: string }[] }
}

interface SendBody extends Reply {
  id: string
  phone: string
  name?: string
  title: string
}

/** The app's answer to a forwarded message. `handled: false` hands it back to the registration chat. */
interface ChatAnswer {
  handled?: boolean
  known?: boolean
  replies?: Reply[]
  reply?: string
}

export interface EqxBridgeOptions {
  apiUrl: string
  secret: string
  /** The Cloud API channel to send from (default: the sandbox number, or the `eqxChannelId` setting). */
  channelId?: string
  /** Where photos forwarded to the app are kept (default `data`). */
  dataDir?: string
}

export class EqxBridge {
  private timer: NodeJS.Timeout | null = null
  /** People whose next message must reach the registration chat untouched (they chose "List my machine"). */
  private readonly passThrough = new Set<string>()
  private readonly mediaDir: string

  constructor(
    private readonly agent: Agent,
    private readonly hykr: Hykr,
    readonly opts: EqxBridgeOptions,
  ) {
    agent.store.sql.exec(`
      create table if not exists eqx_seen(id text primary key, at int);
      create table if not exists eqx_pending(id text primary key, person_id text, channel_id text, body text, created_at int, sent_at int);
      create table if not exists eqx_sync(machine_id text primary key, status text, attempts int default 0, last_error text, eqx_machine_id text, eqx_code text, updated_at int);
      create table if not exists eqx_routes(person_id text primary key, role text, at int);
      create table if not exists eqx_media(id text primary key, person_id text, path text, mime text, sha256 text, created_at int);
    `)
    this.mediaDir = resolve(opts.dataDir ?? 'data', 'eqx-media')
    mkdirSync(this.mediaDir, { recursive: true })
    hykr.interceptors.push((m) => this.intercept(m))
    hykr.onSubmitted.push((id) => void this.pushOnboarded(id))
    // A paper or driver sent after the desk asked: the machine goes to the app again (it keeps only what is new).
    hykr.onPaperAdded.push((id) => void this.pushOnboarded(id))
    // Machines sent to the app are decided there, not on the console's Verification page (D76).
    hykr.externalDesk = (id) => {
      const row = agent.store.sql.get<{ eqx_code: string | null }>('select eqx_code from eqx_sync where machine_id=?', id)
      return row ? { code: row.eqx_code } : null
    }
  }

  /** Reads `EQX_API_URL` and `EQX_BRIDGE_SECRET` (32+ characters); null when the bridge is off. */
  static fromEnv(agent: Agent, hykr: Hykr, dataDir?: string): EqxBridge | null {
    const apiUrl = process.env.EQX_API_URL?.replace(/\/$/, '')
    const secret = process.env.EQX_BRIDGE_SECRET
    if (!apiUrl || !secret) return null
    if (secret.length < 32) throw new Error('EQX_BRIDGE_SECRET needs at least 32 characters')
    return new EqxBridge(agent, hykr, { apiUrl, secret, channelId: process.env.EQX_CHANNEL_ID, dataDir })
  }

  get channelId(): string {
    return this.opts.channelId || this.agent.store.setting('eqxChannelId') || SANDBOX_CLOUD
  }

  start() {
    this.timer = setInterval(() => void this.retrySync(), RETRY_MS)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  // ================================================================== app → WhatsApp

  /** The Switchboard person for a phone number, created (with the number linked) if new. */
  personFor(phone: string, name?: string): string {
    const digits = phone.replace(/\D/g, '')
    const known = this.agent.store.findByLink('pn', digits)
    if (known) return known
    const p = this.agent.store.createPerson(name || `+${digits}`)
    return this.agent.identity.attachPhone(p.id, digits, 'eqx', this.channelId)
  }

  /**
   * The channel to reach this person on: the live number if they have written to it (real phones),
   * else the default (the sandbox). One person never gets the same message on two numbers.
   */
  channelFor(personId: string): string {
    const live = this.agent.store.sql.get<{ channel_id: string }>(
      "select c.channel_id from conversations c join channels ch on ch.id = c.channel_id where c.person_id=? and c.kind='dm' and ch.kind='cloud' and ch.mode='live' and c.last_inbound_at is not null order by c.last_inbound_at desc limit 1",
      personId,
    )
    return live?.channel_id ?? this.channelId
  }

  private windowOpen(channelId: string, personId: string): boolean {
    const conv = this.agent.dmConversation(channelId, personId)
    return !!conv.last_inbound_at && Date.now() - conv.last_inbound_at < WINDOW_MS
  }

  /** Where the pay page is served: this server's public address (the tunnel), else locally. */
  publicBase(): string {
    return (this.agent.store.setting('publicBaseUrl') || process.env.PUBLIC_BASE_URL || this.agent.internalBase || 'http://localhost:4000').replace(/\/$/, '')
  }

  /** `[[pay:/pay/<id>?t=…]]` from the app becomes a link to the pay page on the public address. */
  links(text: string): string {
    return text.replace(/\[\[pay:(\/pay\/[^\]\s]+)\]\]/g, (_m, path: string) => `${this.publicBase()}${path}`)
  }

  private async deliver(channelId: string, personId: string, r: Reply) {
    const body = this.links(r.text)
    if (r.list?.rows.length) return this.agent.list(channelId, personId, body, r.list.button, r.list.rows)
    if (r.buttons?.length) return this.agent.buttons(channelId, personId, body, r.buttons)
    return this.agent.text(channelId, personId, body)
  }

  /** Sends now inside the 24-hour window; otherwise the template goes out and the message waits. */
  async send(b: SendBody): Promise<{ ok: boolean; mode: 'text' | 'buttons' | 'list' | 'template' | 'queued' | 'duplicate'; error?: string }> {
    if (!this.firstTime(b.id)) return { ok: true, mode: 'duplicate' }
    const pid = this.personFor(b.phone, b.name)
    const ch = this.channelFor(pid)
    if (this.windowOpen(ch, pid)) {
      const res = await this.deliver(ch, pid, b)
      return { ok: res.ok, mode: b.list?.rows.length ? 'list' : b.buttons?.length ? 'buttons' : 'text', error: 'error' in res ? (res.error as string | undefined) : undefined }
    }
    // One template per batch: if one went out in the last day and they haven't replied, just add to the queue.
    const waiting = this.agent.store.sql.get<{ n: number }>('select count(*) as n from eqx_pending where person_id=? and sent_at is null and created_at > ?', pid, Date.now() - WINDOW_MS)!.n
    this.agent.store.sql.run('insert or ignore into eqx_pending(id, person_id, channel_id, body, created_at) values(?,?,?,?,?)', b.id, pid, ch, JSON.stringify(b), Date.now())
    if (waiting > 0) return { ok: true, mode: 'queued' }
    const first = (b.name ?? '').split(' ')[0] || 'there'
    const res = await this.agent.template(ch, pid, EQX_TEMPLATE, 'en_US', [first, b.title], `Template "${EQX_TEMPLATE}": ${b.title}`)
    this.agent.bus.log({ kind: 'agent', lane: 'A', title: 'EquipXchange message waits for a reply (outside the 24-hour window)', detail: b.title })
    return { ok: res.ok, mode: 'template', error: res.error }
  }

  /** Sends what was waiting for this person; returns how many went out. */
  async flushPending(channelId: string, personId: string): Promise<number> {
    const rows = this.agent.store.sql.all<{ id: string; body: string }>('select id, body from eqx_pending where person_id=? and sent_at is null order by created_at', personId)
    for (const r of rows) {
      await this.deliver(channelId, personId, JSON.parse(r.body) as SendBody)
      this.agent.store.sql.run('update eqx_pending set sent_at=? where id=?', Date.now(), r.id)
    }
    return rows.length
  }

  private firstTime(id: string): boolean {
    return this.agent.store.sql.run('insert or ignore into eqx_seen(id, at) values(?,?)', id, Date.now()).changes > 0
  }

  // ================================================================== WhatsApp → app

  /**
   * Runs before the registration chat (DECISIONS D66). In order:
   * 1. waiting app messages go out;
   * 2. "Hire / List" choices and `eqx:` taps go to the app;
   * 3. someone in the middle of registering stays with the registration chat;
   * 4. everything else goes to the app first; what it doesn't take goes back to the registration chat.
   * A new number on the live line is asked whether they want to hire a machine or list one.
   * Returns true when handled here.
   */
  async intercept(m: InboundDm): Promise<boolean> {
    if (this.passThrough.delete(m.personId)) return false
    const flushed = await this.flushPending(m.channelId, m.personId)
    const tapped = m.type === 'button' || m.type === 'button_reply' || m.type === 'list_reply'
    if (flushed > 0 && tapped && m.text.trim() === SEE_DETAILS) return true
    if (m.replyId === 'eqx:role:list') {
      this.setRoute(m.personId, 'owner')
      this.passThrough.add(m.personId)
      await this.hykr.handle({ ...m, type: 'text', text: 'hi', replyId: undefined })
      return true
    }
    if (m.replyId === 'eqx:role:hire') {
      this.setRoute(m.personId, 'contractor')
      await this.forward(m, { start: 'hire' })
      return true
    }
    if (m.replyId?.startsWith('eqx:')) {
      await this.forward(m)
      return true
    }
    if (this.hykr.busy(m.personId)) return false
    // Asked for a paper (by either desk): the next photo is that paper, kept by registration (D79).
    if (m.media && this.hykr.awaitingPaper(m.personId)) return false
    const answer = await this.forward(m)
    if (!answer) return false
    if (answer.handled) return true
    const live = this.agent.channels.get(m.channelId)?.mode === 'live'
    if (live && !answer.known && !this.route(m.personId) && !this.hykr.store.personBySwitchboard(m.personId)) {
      await this.agent.buttons(m.channelId, m.personId, 'Welcome to EquipXchange! Do you want to hire a machine, or list your machine to get jobs?', [
        { id: 'eqx:role:hire', title: 'Hire a machine' },
        { id: 'eqx:role:list', title: 'List my machine' },
      ])
      return true
    }
    return false
  }

  private route(personId: string): string | undefined {
    return this.agent.store.sql.get<{ role: string }>('select role from eqx_routes where person_id=?', personId)?.role
  }

  private setRoute(personId: string, role: 'owner' | 'contractor') {
    this.agent.store.sql.run('insert into eqx_routes(person_id, role, at) values(?,?,?) on conflict(person_id) do update set role=excluded.role, at=excluded.at', personId, role, Date.now())
  }

  /** Sends one message to the app and delivers its replies. Null when the app could not be reached. */
  private async forward(m: InboundDm, extra: Record<string, unknown> = {}): Promise<ChatAnswer | null> {
    const phone = this.agent.store.address(m.personId, m.channelId)
    const payload: Record<string, unknown> = {
      phone: phone ? `+${phone.replace(/\D/g, '')}` : '',
      name: this.agent.store.person(m.personId)?.display_name,
      type: m.type,
      ...(m.text ? { text: m.text } : {}),
      ...(m.replyId ? { replyId: m.replyId } : {}),
      ...(m.location ? { location: { lat: m.location.lat, lng: m.location.lng, ...(m.location.name ? { name: m.location.name } : {}), ...(m.location.address ? { address: m.location.address } : {}) } } : {}),
      ...extra,
    }
    if (m.media && m.type === 'image') {
      const media = await this.stashMedia(m)
      if (media) payload.media = media
    }
    const res = await this.post<ChatAnswer>('/integrations/switchboard/inbound', payload)
    if (!res.ok) {
      this.agent.bus.log({ kind: 'agent', lane: 'A', title: 'EquipXchange did not take the message', detail: res.error })
      if (m.replyId?.startsWith('eqx:')) await this.agent.text(m.channelId, m.personId, 'Sorry, something went wrong on our side. Please tap again in a minute.')
      return null
    }
    const replies = res.body?.replies ?? (res.body?.reply ? [{ text: res.body.reply }] : [])
    for (const r of replies) await this.deliver(m.channelId, m.personId, r)
    return res.body ?? { handled: false }
  }

  /**
   * Keeps a photo for the app (it fetches it with a signed GET) and reads the hour meter from it, so
   * the driver only confirms the number. Reading waits at most 8 seconds.
   */
  private async stashMedia(m: InboundDm): Promise<{ ref: string; mime: string; sha256: string; reading: string | null; kind: string | null } | null> {
    try {
      const client = this.agent.client(m.channelId)
      const info = await client.mediaInfo(m.media!.id)
      if (!info.ok || !info.json?.url) return null
      const dl = await client.downloadMedia(String(info.json.url))
      if (!dl.ok) return null
      const mime = String(info.json.mime_type ?? m.media!.mime ?? dl.mime).split(';')[0]
      const id = `EM-${randomUUID().slice(0, 12)}`
      const path = join(this.mediaDir, `${id}.${/png/.test(mime) ? 'png' : /webp/.test(mime) ? 'webp' : 'jpg'}`)
      writeFileSync(path, dl.bytes)
      const sha256 = createHash('sha256').update(dl.bytes).digest('hex')
      this.agent.store.sql.run('insert into eqx_media(id, person_id, path, mime, sha256, created_at) values(?,?,?,?,?,?)', id, m.personId, path, mime, sha256, Date.now())
      let reading: string | null = null
      let kind: string | null = null
      const sandbox = this.agent.channels.get(m.channelId)?.mode === 'sandbox'
      const read = await Promise.race([this.hykr.reader.read({ path, mime }, m.media!.id, sandbox).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 8000))])
      if (read) {
        kind = read.kind
        reading = read.fields.hour_reading ?? null
      }
      return { ref: id, mime, sha256, reading, kind }
    } catch (e) {
      this.agent.bus.log({ kind: 'agent', lane: 'A', title: 'Photo for EquipXchange not kept', detail: (e as Error).message })
      return null
    }
  }

  /** Sends an owner and machine who finished registration to the app. Retried until it lands. */
  async pushOnboarded(machineId: string): Promise<boolean> {
    const payload = this.onboardedPayload(machineId)
    const now = Date.now()
    if ('skip' in payload) {
      this.agent.bus.log({ kind: 'agent', lane: 'A', title: `Not sent to EquipXchange (${machineId})`, detail: String(payload.skip) })
      return false
    }
    this.agent.store.sql.run("insert into eqx_sync(machine_id, status, attempts, updated_at) values(?, 'pending', 0, ?) on conflict(machine_id) do update set status='pending', updated_at=excluded.updated_at", machineId, now)
    const res = await this.post<{ machineId?: string; code?: string; created?: boolean; evidenceSaved?: number }>('/integrations/switchboard/onboarded', payload)
    if (res.ok) {
      this.agent.store.sql.run("update eqx_sync set status='done', attempts=attempts+1, last_error=null, eqx_machine_id=?, eqx_code=?, updated_at=? where machine_id=?", res.body?.machineId ?? null, res.body?.code ?? null, Date.now(), machineId)
      this.agent.bus.log({ kind: 'agent', lane: 'A', title: `Sent to EquipXchange for the desk (${machineId} → ${res.body?.code ?? '?'})`, detail: `${res.body?.evidenceSaved ?? 0} papers saved` })
      return true
    }
    this.agent.store.sql.run("update eqx_sync set attempts=attempts+1, last_error=?, status=case when attempts+1 >= ? then 'failed' else 'pending' end, updated_at=? where machine_id=?", res.error ?? 'failed', MAX_SYNC_ATTEMPTS, Date.now(), machineId)
    this.agent.bus.log({ kind: 'agent', lane: 'A', title: `EquipXchange not reached; will retry (${machineId})`, detail: res.error })
    return false
  }

  async retrySync() {
    const rows = this.agent.store.sql.all<{ machine_id: string }>("select machine_id from eqx_sync where status='pending'")
    for (const r of rows) await this.pushOnboarded(r.machine_id)
  }

  onboardedPayload(machineId: string): Record<string, unknown> | { skip: string } {
    const { store } = this.hykr
    const m = store.machine(machineId)
    if (!m) return { skip: 'machine not found' }
    const owner = store.person(m.owner_id)
    if (!owner?.phone) return { skip: 'owner has no phone number' }
    if (!store.consent(owner.id, 'C1')) return { skip: 'no basic-profile consent (C1)' }
    if (m.base_lat == null && !m.base_label && !owner.village) return { skip: 'no location for the machine base' }
    if (!m.rate_hour) return { skip: 'no hourly rate' }
    const machineClass = (m.class && CLASS[m.class]) || OTHER_CLASS.find(([re]) => re.test(m.class_other ?? ''))?.[1] || 'OTHER'
    const evidence = store
      .evidenceFor(m.id)
      .filter((e) => EVIDENCE_KIND[e.kind] && e.mime && !e.mime.startsWith('video/'))
      .map((e) => ({ id: e.id, kind: EVIDENCE_KIND[e.kind], mime: e.mime, ...(e.sha256 ? { sha256: e.sha256 } : {}) }))
    const date = /^\d{4}-\d{2}-\d{2}$/.test(m.insurance_expiry ?? '') ? m.insurance_expiry : null
    const driver = store.driver(owner.id)
    return {
      ref: m.id,
      owner: {
        phone: `+${owner.phone.replace(/\D/g, '')}`,
        name: owner.name ?? 'Owner',
        village: owner.village,
        drives: owner.owner_operator === 1,
        consents: { basicProfile: true, machinePapers: !!store.consent(owner.id, 'C2') },
      },
      // The driver the owner named (D80); the app links them and sends them the job cards.
      ...(owner.owner_operator !== 1 && driver ? { operator: { phone: `+${driver.phone}`, name: driver.name } } : {}),
      machine: {
        machineClass,
        make: m.make,
        model: m.model,
        year: m.year,
        regNo: m.reg_no,
        pin: m.pin,
        regStatus: m.reg_status === 'unregistered' ? 'UNREGISTERED' : 'REGISTERED',
        insuranceExpiry: date,
        // A pin when the owner sent one; a typed place is matched by the app (and flagged for the desk).
        base: { place: (m.base_label || owner.village || 'Machine base').slice(0, 200), ...(m.base_lat != null && m.base_lng != null ? { lat: m.base_lat, lng: m.base_lng } : {}) },
        radiusKm: Math.min(300, Math.max(1, m.radius_km ?? 25)),
        rateHour: m.rate_hour / 100,
        rateDay: m.rate_day ? m.rate_day / 100 : null,
        dieselIncluded: m.diesel !== 'customer',
      },
      evidence,
      deskNotes: [
        ...store.flags(m).map((f) => FLAG_NOTE[f] ?? f.replace(/_/g, ' ')),
        ...(m.rc_owner_name ? [`Name on the RC: ${m.rc_owner_name}${m.relationship ? ` (${m.relationship})` : ''}`] : []),
      ],
    }
  }

  /** The desk's decision in the app, mirrored so STATUS on WhatsApp says the same. The app sends the message itself. */
  machineStatus(b: { id: string; ref: string; status: string; note?: string | null; need?: string | null }) {
    if (!this.firstTime(b.id)) return { ok: true, duplicate: true }
    const m = this.hykr.store.machine(b.ref)
    const status = STATUS[b.status]
    if (!m || !status) return { ok: false, error: 'unknown machine or status' }
    if (status === 'needs_info') {
      // The app's desk asked for something (it sends the message itself): the owner's next reply here is
      // taken as that paper, or as the driver's contact, and goes back to the app (D79).
      this.hykr.awaitFromOwner(m.id, NEED_KIND[b.need ?? ''] ?? 'other', b.note || 'one more photo', 'eqx-desk')
      return { ok: true }
    }
    this.hykr.store.updateMachine(m.id, { status, desk_note: b.note ?? null, ...(status === 'active' ? { verified_at: Date.now() } : {}) })
    if (status === 'active') {
      this.hykr.store.updatePerson(m.owner_id, { kyc_level: 'T1' })
      this.hykr.store.reached(m.owner_id, 'verified')
    }
    this.hykr.store.emit(`machine.${status === 'active' ? 'verified' : status}`, { actor: 'eqx-desk', personId: m.owner_id, machineId: m.id, payload: { note: b.note ?? null } })
    this.agent.bus.change('hykr')
    return { ok: true }
  }

  // ================================================================== HTTP

  async post<T>(path: string, body: unknown): Promise<{ ok: boolean; body: T | null; error?: string }> {
    const raw = JSON.stringify(body)
    const ts = String(Date.now())
    try {
      const res = await fetch(`${this.opts.apiUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: sign(this.opts.secret, ts, raw) },
        body: raw,
        signal: AbortSignal.timeout(15_000),
      })
      const text = await res.text()
      const json = text ? (JSON.parse(text) as T & { message?: string }) : null
      return { ok: res.ok, body: json, error: res.ok ? undefined : (json?.message ?? `HTTP ${res.status}`) }
    } catch (e) {
      return { ok: false, body: null, error: (e as Error).message }
    }
  }

  routes(): FastifyPluginAsync {
    return async (app) => {
      // Signatures cover the exact bytes, so bodies stay raw until checked.
      app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body))
      const checked = (req: FastifyRequest, reply: FastifyReply, signed: string): boolean => {
        const h = (n: string) => req.headers[n] as string | undefined
        if (verify(this.opts.secret, h(TIMESTAMP_HEADER), signed, h(SIGNATURE_HEADER))) return true
        void reply.code(401).send({ error: 'signature check failed' })
        return false
      }
      const json = <T>(req: FastifyRequest) => JSON.parse(String(req.body ?? '{}')) as T

      app.post('/send', async (req, reply) => {
        if (!checked(req, reply, String(req.body ?? ''))) return
        const b = json<SendBody>(req)
        if (!b.id || !b.phone || !b.text) return reply.code(400).send({ error: 'id, phone and text are required' })
        return this.send(b)
      })
      app.post('/otp', async (req, reply) => {
        if (!checked(req, reply, String(req.body ?? ''))) return
        const b = json<{ phone: string; code: string }>(req)
        const digits = String(b.phone ?? '').replace(/\D/g, '')
        if (!/^\d{6}$/.test(String(b.code)) || digits.length < 8) return reply.code(400).send({ error: 'phone and a 6-digit code are required' })
        const res = await this.agent.client(this.channelFor(this.personFor(digits))).sendOtp(digits, b.code)
        this.agent.bus.log({ kind: 'agent', lane: 'A', title: res.ok ? 'EquipXchange sign-in code sent (authentication template)' : 'EquipXchange sign-in code not sent', detail: res.ok ? `to +${digits}` : res.error?.message })
        return { ok: res.ok, error: res.ok ? undefined : res.error?.message }
      })
      app.post('/machine-status', async (req, reply) => {
        if (!checked(req, reply, String(req.body ?? ''))) return
        return this.machineStatus(json(req))
      })
      app.get<{ Params: { id: string } }>('/media/:id', async (req, reply) => {
        if (!checked(req, reply, `GET ${req.url}`)) return
        const f = this.agent.store.sql.get<{ path: string; mime: string }>('select path, mime from eqx_media where id=?', req.params.id)
        if (!f || !existsSync(f.path)) return reply.code(404).send({ error: 'not found' })
        return reply.type(f.mime).send(readFileSync(f.path))
      })
      app.get<{ Params: { id: string } }>('/evidence/:id', async (req, reply) => {
        if (!checked(req, reply, `GET ${req.url}`)) return
        const e = this.hykr.store.evidence(req.params.id)
        if (!e?.path || !existsSync(e.path)) return reply.code(404).send({ error: 'not found' })
        return reply.type(e.mime ?? 'application/octet-stream').send(readFileSync(e.path))
      })
    }
  }

  // ================================================================== the pay page (public)

  /**
   * The test payment page a pay link opens on the phone (stands in for the payment partner's hosted
   * page). Served on this server's public address; it only relays to the app's token-checked
   * `/pay/:id` endpoints, so nothing else of the app is exposed.
   */
  payRoutes(): FastifyPluginAsync {
    return async (app) => {
      app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => done(null, body))
      const ok = (id: string, t?: string) => /^[0-9a-f-]{36}$/.test(id) && !!t && /^[\w-]{10,64}$/.test(t)
      const call = async (method: 'GET' | 'POST', path: string) => {
        try {
          const res = await fetch(`${this.opts.apiUrl}${path}`, { method, signal: AbortSignal.timeout(15_000) })
          return { status: res.status, body: (await res.json().catch(() => null)) as PayPage | null }
        } catch {
          return { status: 0, body: null }
        }
      }
      app.get<{ Params: { id: string }; Querystring: { t?: string } }>('/pay/:id', async (req, reply) => {
        const { id } = req.params
        const { t } = req.query
        if (!ok(id, t)) return reply.code(404).type('text/html').send(payHtml(null, '', '', 'This payment link is not valid.'))
        const r = await call('GET', `/pay/${id}?t=${encodeURIComponent(t!)}`)
        return reply.type('text/html').send(payHtml(r.status === 200 ? r.body : null, id, t!, r.status === 200 ? null : 'This payment link was not found or has closed.'))
      })
      app.post<{ Params: { id: string }; Querystring: { t?: string } }>('/pay/:id', async (req, reply) => {
        const { id } = req.params
        const { t } = req.query
        if (!ok(id, t)) return reply.code(404).type('text/html').send(payHtml(null, '', '', 'This payment link is not valid.'))
        const r = await call('POST', `/pay/${id}/pay?t=${encodeURIComponent(t!)}`)
        const msg = r.status === 200 ? null : ((r.body as unknown as { message?: string } | null)?.message ?? 'The payment did not go through. Please try again.')
        const page = r.status === 200 ? r.body : (await call('GET', `/pay/${id}?t=${encodeURIComponent(t!)}`)).body
        return reply.type('text/html').send(payHtml(page, id, t!, msg))
      })
    }
  }
}

interface PayPage {
  link: { amount: number; kind: string; status: string }
  bookingCode: string
  sitePlace: string
  startAt: string
  machineClass: string
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/** A small, phone-first page: amount, what it is for, one button. Clearly marked as a test. */
function payHtml(p: PayPage | null, id: string, t: string, error: string | null): string {
  const when = p ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(p.startAt)) : ''
  const kind = p ? (p.link.kind === 'ADVANCE' ? 'Advance' : p.link.kind === 'BALANCE' ? 'Balance' : 'Charge') : ''
  const machine = p ? p.machineClass.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()) : ''
  const paid = p?.link.status === 'PAID'
  const closed = p?.link.status === 'CANCELLED'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>EquipXchange · Pay</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--text:#1d1b18;--muted:#6b665e;--accent:#e0761a;--accentText:#fff;--ok:#1b6b32;--okBg:#dcf2e1;--bad:#c62828;--line:#e3dfd8}
@media (prefers-color-scheme:dark){:root{--bg:#111315;--card:#1b1e21;--text:#f1efe9;--muted:#a7a29a;--accent:#f08a2e;--accentText:#1d1b18;--ok:#8fd6a3;--okBg:#173323;--bad:#ef5350;--line:#2c3035}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:440px;margin:0 auto;padding:20px 16px 40px}.test{background:var(--card);border:1px dashed var(--line);border-radius:10px;padding:8px 12px;font-size:13px;color:var(--muted)}
h1{font-size:30px;margin:18px 0 4px}.sub{color:var(--muted);margin:0 0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:6px 14px}
.row{display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}.row:last-child{border-bottom:0}.row span:first-child{color:var(--muted)}
button{width:100%;min-height:52px;margin-top:18px;border:0;border-radius:10px;background:var(--accent);color:var(--accentText);font-size:18px;font-weight:600}
.ok{background:var(--okBg);color:var(--ok);border-radius:10px;padding:14px;margin-top:18px;font-weight:600}.err{color:var(--bad);margin-top:14px}.brand{font-weight:700;color:var(--accent)}
</style></head><body><main>
<div class="test">Test payment page: no money moves. The payment partner's page replaces this one.</div>
${p ? `<h1>${paid ? 'Paid. Thank you.' : esc(`Pay ${inr(p.link.amount)}`)}</h1><p class="sub">${esc(kind)} for booking ${esc(p.bookingCode)} · <span class="brand">EquipXchange</span></p>
<div class="card"><div class="row"><span>Machine</span><span>${esc(machine)}</span></div><div class="row"><span>Site</span><span>${esc(p.sitePlace)}</span></div><div class="row"><span>When</span><span>${esc(when)}</span></div><div class="row"><span>Amount</span><span>${esc(inr(p.link.amount))}</span></div></div>
${paid ? '<div class="ok">Payment received. The confirmation is on WhatsApp. You can close this page.</div>' : closed ? '<p class="err">This payment link has closed. Ask for a new one on WhatsApp.</p>' : `<form method="post" action="/pay/${esc(id)}?t=${esc(t)}"><button type="submit">Pay ${esc(inr(p.link.amount))} by UPI</button></form>`}` : '<h1>Payment</h1>'}
${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
</main></body></html>`
}

