import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'
import type { Agent } from '../agent/agent'
import type { InboundDm } from '../agent/inbound'
import type { ConverseMessage, ConverseTools } from '../agent/llm'
import { redact } from '../agent/redact'
import { LANG_NAME } from '../agent/voice/engines'
import { matchCommand, matchYesNo } from '../agent/voice/match'
import type { Hykr } from '../hykr/brain'
import { classLabel } from '../hykr/parse'
import type { HxMachine, HxPerson } from '../hykr/store'
import { GST_PERCENT, LINES, OFFLINE, RAVI_SYSTEM, SPOKEN_NOTE, langOf, type RaviLang } from './copy'
import { RaviStore, isIsoDate, today, type RaviPending, type RaviRequest } from './store'

/** Steps of the registration conversation where it is at rest, so free messages are Ravi's to answer. */
const AT_REST = ['registered', 'more']
/** At "Anything else?" these words answer the registration's own buttons (another machine, a manager, done). */
const MORE_WORDS = /\b(manager|another|add|more|done|finish|that'?s all)\b/i
const MACHINE_STATUS: Record<string, string> = {
  draft: 'not submitted yet',
  pending: 'being checked by our team',
  needs_info: 'our team asked for one more paper',
  active: 'live',
  rejected: 'not approved',
  paused: 'paused',
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MAX_RATE_RUPEES = 1_000_000
const HISTORY = 14
/**
 * Ravi's model: Haiku, because an owner is waiting on WhatsApp and each turn is two or three round trips
 * (look up, act, answer). Change it with the `raviModel` setting or RAVI_MODEL; the other AI features
 * (reading papers, digests) keep the model chosen in Settings.
 */
export const RAVI_MODEL = 'claude-haiku-5-5'

/** 2026-11-16 → "16 Nov". */
export const sayDate = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`
const rupees = (paise: number | null | undefined) => (paise == null ? null : Math.round(paise / 100))
const inr = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Messages the registration flow owns at any step (see Hykr.command): Ravi leaves them alone. */
export function isRegistrationCommand(text: string, voice: boolean): boolean {
  const t = text.trim()
  if (/^START\b/i.test(t)) return true
  if (['STOP', 'UNSUBSCRIBE', 'HELP', 'STATUS', 'PAPERS'].includes(t.toUpperCase())) return true
  if (voice && matchCommand(t)) return true
  return (
    /\b(talk to (a |some)?(person|human|someone|agent)|human please|call me|customer care)\b/i.test(t) ||
    /\b(add|new|another|register (a |another )?)\s*(a |another )?machine\b/i.test(t) ||
    /\badd (a |my )?manager\b/i.test(t) ||
    /\b(add|change|new) (a |my |the )?(driver|operator)\b/i.test(t)
  )
}

/** A typed or spoken yes / no to an approval card, in English, Hindi or Telugu. */
export function yesNo(text: string): 'yes' | 'no' | null {
  const t = text.trim()
  if (/^(avunu|sare|అవును|సరే)(\W|$)/i.test(t)) return 'yes'
  if (/^(vaddu|voddu|kaadu|వద్దు|కాదు)(\W|$)/i.test(t)) return 'no'
  return matchYesNo(t)
}

interface Turn {
  m: InboundDm
  ch: string
  actor: string
  owner: HxPerson
  text: string
  lang: RaviLang
}

type Parked = { ok: true; pending: RaviPending; facts: Record<string, unknown> } | { ok: false; error: string }

/**
 * Ravi: the supplier assistant, answering a registered owner's free messages on WhatsApp.
 * It sits in front of the registration flow as an interceptor and takes a message only when that flow is
 * at rest, so every registration step, card and command works as before. Anything that changes a record
 * for a builder to see (a quote, a decline) or a price waits for a tap on an approval card.
 * With an API key Claude holds the conversation and calls the tools below; without one a small scripted
 * engine answers the common asks, and everything else goes on to the registration flow.
 */
export class Ravi {
  readonly store: RaviStore
  /** People whose current message Ravi is handing to the registration flow itself. */
  private handingOver = new Set<string>()

  constructor(
    private agent: Agent,
    private hykr: Hykr,
  ) {
    this.store = new RaviStore(agent.store.sql)
    hykr.interceptors.push((m) => this.intercept(m))
    agent.onSandboxCleared.push(() => this.store.purgeMissing())
  }

  private get bus() {
    return this.agent.bus
  }

  // ================================================================== entry point

  /** True when Ravi answered the message; false passes it on to the registration flow. */
  async intercept(m: InboundDm): Promise<boolean> {
    if (this.handingOver.has(m.personId)) return false
    const flow = this.hykr.store.flow(m.personId)
    if (!flow || flow.role !== 'owner' || !flow.owner_id) return false
    const owner = this.hykr.store.person(flow.owner_id)
    if (!owner || owner.status !== 'active') return false
    const text = m.text.trim()
    const t: Turn = { m, ch: m.channelId, actor: m.personId, owner, text, lang: langOf(text) }

    // A tap on one of Ravi's own cards, wherever the conversation is now.
    if (m.replyId?.startsWith('ravi:')) {
      await this.tap(t, m.replyId)
      return true
    }
    if (m.replyId || !AT_REST.includes(flow.step)) return false
    const voice = m.type === 'voice'
    if (!(m.type === 'text' || voice) || !text) return false
    if (isRegistrationCommand(text, voice)) return false

    const waiting = this.store.waiting(t.actor)
    const answer = waiting ? yesNo(text) : null
    if (waiting && answer) {
      await (answer === 'yes' ? this.approve(t, waiting) : this.cancel(t, waiting))
      return true
    }
    if (flow.step === 'more' && (MORE_WORDS.test(text) || matchYesNo(text) === 'no')) return false

    this.store.seedDemoRequests(owner.id, this.hykr.store.machines(owner.id))
    if (this.agent.llm.engine === 'claude') {
      try {
        await this.converse(t)
        return true
      } catch (e) {
        this.bus.log({ kind: 'agent', lane: 'A', title: 'Ravi: falling back to the scripted engine', detail: (e as Error).message })
      }
    }
    return this.scripted(t)
  }

  // ================================================================== records

  private machines(t: Turn): HxMachine[] {
    return this.hykr.store.machines(t.owner.id).filter((m) => m.class || m.status !== 'draft')
  }

  private ownMachine(t: Turn, id: string): HxMachine | undefined {
    const m = this.hykr.store.machine(id)
    return m && m.owner_id === t.owner.id ? m : undefined
  }

  private ownRequest(t: Turn, id: string): RaviRequest | undefined {
    const r = this.store.request(id)
    return r && r.owner_id === t.owner.id ? r : undefined
  }

  private label(m: HxMachine | undefined): string {
    if (!m) return 'machine'
    return [m.make, m.model].filter(Boolean).join(' ') || cap(classLabel(m.class, m.class_other))
  }

  // ================================================================== approvals

  private parkQuote(t: Turn, requestId: string, price: 'builder' | 'listed' | 'stated', statedRupees?: number): Parked {
    const r = this.ownRequest(t, requestId)
    if (!r) return { ok: false, error: 'No such rental request for this owner. List the requests and use an id from that list.' }
    if (r.status !== 'pending') return { ok: false, error: `This request is already ${r.status}; nothing was sent.` }
    const m = this.ownMachine(t, r.machine_id)
    let rate: number
    if (price === 'builder') rate = r.offered_day
    else if (price === 'listed') {
      if (m?.rate_day == null) return { ok: false, error: 'This machine has no daily rate listed. Ask the owner what daily rate to quote.' }
      rate = m.rate_day
    } else {
      if (!statedRupees || !Number.isInteger(statedRupees) || statedRupees <= 0 || statedRupees > MAX_RATE_RUPEES) return { ok: false, error: 'A stated price needs daily_rate_rupees: the whole-rupee daily rate the owner said.' }
      rate = statedRupees * 100
    }
    const rent = rate * r.days
    const gst = Math.round((rent * GST_PERCENT) / 100)
    const total = rent + gst
    const summary = LINES[t.lang].quote({ builder: r.builder, machine: this.label(m), days: r.days, from: sayDate(r.start_date), rate, rent, gst, total })
    const pending = this.store.park({ actor_id: t.actor, owner_id: t.owner.id, channel_id: t.ch, kind: 'quote', args: { requestId: r.id, rate, total }, summary, lang: t.lang })
    return { ok: true, pending, facts: { builder: r.builder, days: r.days, daily_rate_rupees: rupees(rate), rent_rupees: rupees(rent), gst_rupees: rupees(gst), total_rupees: rupees(total) } }
  }

  private parkDecline(t: Turn, requestId: string): Parked {
    const r = this.ownRequest(t, requestId)
    if (!r) return { ok: false, error: 'No such rental request for this owner. List the requests and use an id from that list.' }
    if (r.status !== 'pending') return { ok: false, error: `This request is already ${r.status}; nothing was changed.` }
    const summary = LINES[t.lang].decline(r.builder, this.label(this.ownMachine(t, r.machine_id)), sayDate(r.start_date))
    const pending = this.store.park({ actor_id: t.actor, owner_id: t.owner.id, channel_id: t.ch, kind: 'decline', args: { requestId: r.id }, summary, lang: t.lang })
    return { ok: true, pending, facts: { builder: r.builder } }
  }

  private parkRate(t: Turn, machineId: string, dayRupees?: number, hourRupees?: number): Parked {
    const m = this.ownMachine(t, machineId)
    if (!m) return { ok: false, error: 'No such machine for this owner. List the machines and use an id from that list.' }
    const valid = (n: number | undefined) => n == null || (Number.isInteger(n) && n > 0 && n <= MAX_RATE_RUPEES)
    if ((dayRupees == null && hourRupees == null) || !valid(dayRupees) || !valid(hourRupees)) return { ok: false, error: 'Give daily_rate_rupees or hourly_rate_rupees (or both): whole rupees, as the owner said them.' }
    const day = dayRupees != null ? dayRupees * 100 : null
    const hour = hourRupees != null ? hourRupees * 100 : null
    const summary = LINES[t.lang].rate(this.label(m), day, hour)
    const pending = this.store.park({ actor_id: t.actor, owner_id: t.owner.id, channel_id: t.ch, kind: 'rate', args: { machineId: m.id, day, hour }, summary, lang: t.lang })
    return { ok: true, pending, facts: { machine: this.label(m) } }
  }

  private parkUnblock(t: Turn, blockId: string): Parked {
    const b = this.store.block(blockId)
    if (!b || b.owner_id !== t.owner.id) return { ok: false, error: 'No such blocked dates for this owner. List the blocked dates and use an id from that list.' }
    const summary = LINES[t.lang].unblock(this.label(this.ownMachine(t, b.machine_id)), sayDate(b.from_date), sayDate(b.to_date))
    const pending = this.store.park({ actor_id: t.actor, owner_id: t.owner.id, channel_id: t.ch, kind: 'unblock', args: { blockId: b.id }, summary, lang: t.lang })
    return { ok: true, pending, facts: {} }
  }

  /** The approval card: the summary is the question, the buttons are the answer. */
  private sendCard(t: Turn, p: RaviPending) {
    const l = LINES[(p.lang as RaviLang) in LINES ? (p.lang as RaviLang) : 'en']
    return this.agent.buttons(t.ch, t.actor, p.summary, [
      { id: `ravi:y:${p.id}`, title: l.yes },
      { id: `ravi:n:${p.id}`, title: l.no },
    ])
  }

  private async tap(t: Turn, replyId: string): Promise<void> {
    const [, kind, ref] = replyId.split(':')
    if (kind === 'y' || kind === 'n') {
      const p = this.store.pending(ref ?? '')
      if (!p || p.actor_id !== t.actor || p.status !== 'waiting') {
        await this.agent.text(t.ch, t.actor, LINES[t.lang].stale)
        return
      }
      await (kind === 'y' ? this.approve(t, p) : this.cancel(t, p))
      return
    }
    // The scripted engine's request cards: each button leads to the same approval card a typed ask would.
    const parked = kind === 'q' ? this.parkQuote(t, ref ?? '', 'builder') : kind === 'd' ? this.parkDecline(t, ref ?? '') : null
    if (parked?.ok) await this.sendCard(t, parked.pending)
    else await this.agent.text(t.ch, t.actor, LINES[t.lang].stale)
  }

  /** Does exactly what the card said, after checking the record is still as it was when the card was made. */
  private async approve(t: Turn, p: RaviPending): Promise<void> {
    const l = LINES[(p.lang as RaviLang) in LINES ? (p.lang as RaviLang) : 'en']
    const hx = this.hykr.store
    let said: string | null = null
    if (p.kind === 'quote' || p.kind === 'decline') {
      const r = this.ownRequest(t, p.args.requestId)
      if (r?.status === 'pending') {
        if (p.kind === 'quote') {
          this.store.setRequest(r.id, 'quoted', p.args.rate)
          hx.emit('ravi.quote_sent', { actor: 'owner', personId: t.owner.id, machineId: r.machine_id, payload: { request_id: r.id, builder: r.builder, day_rate: p.args.rate, total: p.args.total } })
          said = l.quoteSent(r.builder, p.args.total)
        } else {
          this.store.setRequest(r.id, 'declined')
          hx.emit('ravi.request_declined', { actor: 'owner', personId: t.owner.id, machineId: r.machine_id, payload: { request_id: r.id, builder: r.builder } })
          said = l.declined(r.builder)
        }
      }
    } else if (p.kind === 'rate') {
      const m = this.ownMachine(t, p.args.machineId)
      if (m) {
        hx.updateMachine(m.id, { ...(p.args.day != null ? { rate_day: p.args.day } : {}), ...(p.args.hour != null ? { rate_hour: p.args.hour } : {}) })
        hx.emit('ravi.rate_changed', { actor: 'owner', personId: t.owner.id, machineId: m.id, payload: { rate_day: p.args.day, rate_hour: p.args.hour } })
        said = l.rateSaved(this.label(m))
      }
    } else if (p.kind === 'unblock') {
      const b = this.store.block(p.args.blockId)
      if (b && b.owner_id === t.owner.id) {
        this.store.removeBlock(b.id)
        hx.emit('ravi.dates_unblocked', { actor: 'owner', personId: t.owner.id, machineId: b.machine_id, payload: { from: b.from_date, to: b.to_date } })
        said = l.unblocked(this.label(this.ownMachine(t, b.machine_id)))
      }
    }
    this.store.settle(p.id, said ? 'approved' : 'cancelled')
    this.bus.log({ kind: 'agent', lane: 'A', title: said ? `Ravi: approved (${p.kind})` : `Ravi: approval could not run (${p.kind})`, detail: p.summary.slice(0, 120) })
    await this.agent.text(t.ch, t.actor, said ?? l.failed)
  }

  private async cancel(t: Turn, p: RaviPending): Promise<void> {
    this.store.settle(p.id, 'cancelled')
    const l = LINES[(p.lang as RaviLang) in LINES ? (p.lang as RaviLang) : 'en']
    await this.agent.text(t.ch, t.actor, l.cancelled)
  }

  // ================================================================== Claude

  private machineView(t: Turn, m: HxMachine) {
    return {
      id: m.id,
      name: this.label(m),
      type: classLabel(m.class, m.class_other),
      registration: m.reg_no,
      status: MACHINE_STATUS[m.status] ?? m.status,
      daily_rate_rupees: rupees(m.rate_day),
      hourly_rate_rupees: rupees(m.rate_hour),
      kept_at: m.base_label,
      blocked_dates: this.store.blocks(t.owner.id, m.id).map((b) => ({ id: b.id, from: b.from_date, to: b.to_date, reason: b.reason })),
    }
  }

  private requestView(t: Turn, r: RaviRequest) {
    const end = new Date(Date.parse(`${r.start_date}T00:00:00Z`) + (r.days - 1) * 86_400_000).toISOString().slice(0, 10)
    return {
      id: r.id,
      builder: r.builder,
      site: r.site,
      machine_id: r.machine_id,
      machine: this.label(this.ownMachine(t, r.machine_id)),
      start_date: r.start_date,
      days: r.days,
      builder_price_per_day_rupees: rupees(r.offered_day),
      status: r.status,
      quoted_per_day_rupees: rupees(r.quote_day),
      machine_blocked_on_these_dates: this.store.blocks(t.owner.id, r.machine_id).some((b) => b.from_date <= end && b.to_date >= r.start_date),
    }
  }

  /** The tools Claude may call this turn. Every one works only on this owner's records. */
  private tools(t: Turn, state: { parked: RaviPending[]; handover: boolean }): ConverseTools {
    const json = (v: unknown) => JSON.stringify(v)
    const parked = (p: Parked) => {
      if (!p.ok) return json({ ok: false, error: p.error })
      state.parked.push(p.pending)
      return json({ ok: true, status: 'waiting_for_approval', note: 'A card with Yes and No buttons goes under your reply. Nothing has been done yet.', card_says: p.pending.summary, ...p.facts })
    }
    return [
      betaZodTool({
        name: 'list_machines',
        description: "The owner's machines as they are right now: name, type, registration, status, rates and blocked dates.",
        inputSchema: z.object({}),
        run: async () => json({ machines: this.machines(t).map((m) => this.machineView(t, m)) }),
      }),
      betaZodTool({
        name: 'list_requests',
        description: "Builders' rental requests for the owner's machines. Call it before answering about requests or acting on one.",
        inputSchema: z.object({ status: z.enum(['pending', 'quoted', 'declined', 'all']).optional().describe('Which requests; pending (still to answer) when left out.') }),
        run: async ({ status }) => {
          const rows = this.store.requests(t.owner.id, status === 'all' ? undefined : (status ?? 'pending'))
          const live = this.machines(t).some((m) => m.status === 'active')
          return json({ requests: rows.map((r) => this.requestView(t, r)), ...(live ? {} : { note: 'None of the machines is live yet; builders can only ask for a machine once the team has verified it.' }) })
        },
      }),
      betaZodTool({
        name: 'list_blocked_dates',
        description: 'Dates on which a machine is blocked (out of service, not for rent), from today on.',
        inputSchema: z.object({ machine_id: z.string().optional().describe('One machine; every machine when left out.') }),
        run: async ({ machine_id }) => {
          if (machine_id && !this.ownMachine(t, machine_id)) return json({ ok: false, error: 'No such machine for this owner.' })
          return json({ blocked: this.store.blocks(t.owner.id, machine_id).map((b) => ({ id: b.id, machine: this.label(this.ownMachine(t, b.machine_id)), from: b.from_date, to: b.to_date, reason: b.reason })) })
        },
      }),
      betaZodTool({
        name: 'block_dates',
        description: 'Takes a machine out of service for a range of days (repairs, own work). Happens at once; no approval needed.',
        inputSchema: z.object({
          machine_id: z.string().describe('An id from list_machines.'),
          from_date: z.string().describe('First blocked day, YYYY-MM-DD.'),
          to_date: z.string().describe('Last blocked day, YYYY-MM-DD; the same as from_date for a single day.'),
          reason: z.string().optional().describe('Why, in the owner’s words, if they said.'),
        }),
        run: async ({ machine_id, from_date, to_date, reason }) => {
          const m = this.ownMachine(t, machine_id)
          if (!m) return json({ ok: false, error: 'No such machine for this owner. List the machines and use an id from that list.' })
          if (!isIsoDate(from_date) || !isIsoDate(to_date) || from_date > to_date) return json({ ok: false, error: 'Dates must be YYYY-MM-DD, with from_date on or before to_date.' })
          if (to_date < today()) return json({ ok: false, error: 'Those dates are in the past.' })
          const b = this.store.addBlock(t.owner.id, m.id, from_date, to_date, reason?.slice(0, 200) ?? null)
          this.hykr.store.emit('ravi.dates_blocked', { actor: 'owner', personId: t.owner.id, machineId: m.id, payload: { from: from_date, to: to_date, reason: b.reason } })
          const clash = this.store
            .requests(t.owner.id)
            .filter((r) => r.machine_id === m.id && r.status !== 'declined')
            .map((r) => this.requestView(t, r))
            .filter((r) => r.machine_blocked_on_these_dates)
          return json({ ok: true, blocked: { id: b.id, machine: this.label(m), from: from_date, to: to_date }, requests_on_these_dates: clash })
        },
      }),
      betaZodTool({
        name: 'unblock_dates',
        description: 'Lifts blocked dates so the machine can be rented on them again. Waits for the owner’s tap on an approval card.',
        inputSchema: z.object({ block_id: z.string().describe('An id from list_blocked_dates.') }),
        run: async ({ block_id }) => parked(this.parkUnblock(t, block_id)),
      }),
      betaZodTool({
        name: 'set_rate',
        description: 'Changes a machine’s daily and/or hourly rate to the figure the owner said. Waits for the owner’s tap on an approval card.',
        inputSchema: z.object({
          machine_id: z.string().describe('An id from list_machines.'),
          daily_rate_rupees: z.number().int().positive().optional().describe('The daily rate the owner said, in whole rupees.'),
          hourly_rate_rupees: z.number().int().positive().optional().describe('The hourly rate the owner said, in whole rupees.'),
        }),
        run: async ({ machine_id, daily_rate_rupees, hourly_rate_rupees }) => parked(this.parkRate(t, machine_id, daily_rate_rupees, hourly_rate_rupees)),
      }),
      betaZodTool({
        name: 'send_quote',
        description: 'Answers a pending rental request with a quote. The quote prices itself (rent for the days, plus GST). Waits for the owner’s tap on an approval card.',
        inputSchema: z.object({
          request_id: z.string().describe('An id from list_requests.'),
          price: z.enum(['builder', 'listed', 'stated']).describe("builder: the builder's own price. listed: the machine's listed daily rate. stated: a daily rate the owner said in this conversation."),
          daily_rate_rupees: z.number().int().positive().optional().describe('Only with price "stated": the daily rate the owner said, in whole rupees.'),
        }),
        run: async ({ request_id, price, daily_rate_rupees }) => parked(this.parkQuote(t, request_id, price, daily_rate_rupees)),
      }),
      betaZodTool({
        name: 'decline_request',
        description: 'Turns down a pending rental request. Waits for the owner’s tap on an approval card.',
        inputSchema: z.object({ request_id: z.string().describe('An id from list_requests.') }),
        run: async ({ request_id }) => parked(this.parkDecline(t, request_id)),
      }),
      betaZodTool({
        name: 'add_machine',
        description: 'Starts the step-by-step registration of another machine (type, photos, papers, rates). Call it when the owner wants to add a machine; the registration asks its own questions, so write nothing after it.',
        inputSchema: z.object({}),
        run: async () => {
          state.handover = true
          return json({ ok: true, note: 'The registration is starting and will ask the owner its first question. End your turn without writing anything.' })
        },
      }),
    ]
  }

  /** Earlier messages of this chat as conversation turns, oldest first (the current message is left out). */
  private history(t: Turn): ConverseMessage[] {
    const conv = this.agent.dmConversation(t.ch, t.actor)
    const rows = this.agent.store.sql
      .all<{ id: string; dir: string; type: string; text: string }>("select id, dir, type, text from messages where conversation_id=? and dir in ('in','out') and deleted=0 order by at desc, rowid desc limit ?", conv.id, HISTORY + 1)
      .reverse()
      .filter((r) => r.id !== t.m.messageId && r.text?.trim())
    while (rows.length && rows[0].dir !== 'in') rows.shift()
    // As elsewhere, a voice note's words go to the model with phone numbers and emails masked.
    return rows.map((r) => ({ role: r.dir === 'in' ? ('user' as const) : ('assistant' as const), content: (r.dir === 'in' && r.type === 'audio' ? redact(r.text).text : r.text).slice(0, 800) }))
  }

  private async converse(t: Turn): Promise<void> {
    const state = { parked: [] as RaviPending[], handover: false }
    const now = new Date(Date.now() + 5.5 * 3_600_000)
    const waiting = this.store.waiting(t.actor)
    const spoken = this.agent.voice.wantsVoice(t.ch, t.actor)
    // What changes from turn to turn rides with the message, so the instructions stay byte-for-byte the same.
    const context = [
      `Today is ${WEEKDAYS[now.getUTCDay()]} ${sayDate(today())} ${now.getUTCFullYear()} (${today()}), India time.`,
      `The owner: ${t.owner.name ?? 'name not known'}${t.owner.village ? `, ${t.owner.village}` : ''}.`,
      waiting ? `An approval card is still waiting for their tap. It says: "${waiting.summary}"` : '',
      t.m.type === 'voice' ? `Their message below is a voice note, spoken in ${LANG_NAME[this.agent.convLang(this.agent.dmConversation(t.ch, t.actor).id)]} and turned into text; it may contain mistakes.` : '',
      spoken ? SPOKEN_NOTE : '',
    ]
      .filter(Boolean)
      .join('\n')
    let reply: { text: string; engine: string }
    try {
      reply = await this.agent.llm.converse({
        system: RAVI_SYSTEM,
        messages: [...this.history(t), { role: 'user', content: `<context>\n${context}\n</context>\n\n${t.m.type === 'voice' ? redact(t.text).text : t.text}` }],
        tools: this.tools(t, state),
        model: this.agent.store.setting('raviModel') || process.env.RAVI_MODEL || RAVI_MODEL,
      })
    } catch (e) {
      // Cards are sent only after a reply: an approval parked by a turn that failed must not stay answerable.
      for (const p of state.parked) this.store.settle(p.id, 'cancelled')
      throw e
    }
    if (state.handover) {
      this.bus.log({ kind: 'agent', lane: 'A', title: 'Ravi: handed over to machine registration', detail: reply.engine })
      this.handingOver.add(t.actor)
      try {
        await this.hykr.handle({ ...t.m, type: 'text', text: 'add machine', replyId: undefined })
      } finally {
        this.handingOver.delete(t.actor)
      }
      return
    }
    const card = state.parked.map((p) => this.store.pending(p.id)).find((p) => p?.status === 'waiting')
    if (!reply.text && !card) throw new Error('Ravi had nothing to say')
    if (reply.text) await this.agent.text(t.ch, t.actor, reply.text)
    if (card) await this.sendCard(t, card)
    this.bus.log({ kind: 'agent', lane: 'A', title: `Ravi answered${card ? ` and asked for approval (${card.kind})` : ''}`, detail: reply.engine })
  }

  // ================================================================== scripted engine (no API key)

  /** Answers the common asks from the records, without a model. False = not one of them. */
  private async scripted(t: Turn): Promise<boolean> {
    const say = (body: string) => this.agent.text(t.ch, t.actor, body)
    const text = t.text
    if (/\b(requests?|enquir(y|ies)|bookings?|orders?)\b/i.test(text)) {
      const pending = this.store.requests(t.owner.id, 'pending')
      if (!pending.length) {
        await say(this.machines(t).some((m) => m.status === 'active') ? OFFLINE.noRequests : OFFLINE.notLiveYet)
      } else {
        await say(OFFLINE.requestsHead(pending.length))
        // One card per request (WhatsApp allows three buttons a card); a tap leads to the approval card.
        for (const r of pending.slice(0, 3)) {
          const body = `${r.builder}: your ${this.label(this.ownMachine(t, r.machine_id))} for ${r.days} ${r.days === 1 ? 'day' : 'days'} from ${sayDate(r.start_date)}, at ${r.site}. They offer ${inr(r.offered_day)} a day.`
          await this.agent.buttons(t.ch, t.actor, body, [
            { id: `ravi:q:${r.id}`, title: OFFLINE.quoteButton(r.offered_day) },
            { id: `ravi:d:${r.id}`, title: OFFLINE.declineButton },
          ])
        }
      }
    } else if (/\bblocked\b|\bblock(ed)? dates\b/i.test(text)) {
      const blocks = this.store.blocks(t.owner.id)
      await say(blocks.length ? [OFFLINE.blockedHead, ...blocks.map((b) => `• ${this.label(this.ownMachine(t, b.machine_id))}: ${b.from_date === b.to_date ? sayDate(b.from_date) : `${sayDate(b.from_date)} to ${sayDate(b.to_date)}`}`)].join('\n') : OFFLINE.noBlocks)
    } else if (/\b(my|show|list|see)\b.*\bmachines?\b|\bfleet\b/i.test(text)) {
      const ms = this.machines(t)
      await say(ms.length ? [OFFLINE.machinesHead, ...ms.map((m) => `• ${this.label(m)}: ${MACHINE_STATUS[m.status] ?? m.status}${m.rate_day != null ? `, ${inr(m.rate_day)} a day` : ''}`)].join('\n') : OFFLINE.noMachines)
    } else {
      return false
    }
    this.bus.log({ kind: 'agent', lane: 'A', title: 'Ravi answered', detail: 'scripted engine (no API key)' })
    return true
  }
}
