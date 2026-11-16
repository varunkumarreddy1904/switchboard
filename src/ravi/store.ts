import { randomBytes } from 'node:crypto'
import type { Sql } from '../shared/db'
import type { HxMachine } from '../hykr/store'

/**
 * Ravi's own records for the PoC: rental requests, blocked dates and approvals waiting for a tap.
 * Machines and owners are HYKR's (hx_machines, hx_people); nothing here copies them.
 * Money is in paise and dates are YYYY-MM-DD in India time, as in the HYKR records.
 */
const SCHEMA = `
create table if not exists ravi_requests(id text primary key, owner_id text, machine_id text, builder text, site text, start_date text, days int,
  offered_day int, status text, quote_day int, demo int default 0, created_at int, updated_at int);
create table if not exists ravi_blocks(id text primary key, owner_id text, machine_id text, from_date text, to_date text, reason text, created_at int);
create table if not exists ravi_pending(id text primary key, actor_id text, owner_id text, channel_id text, kind text, args text, summary text,
  lang text, status text, created_at int);
create index if not exists idx_ravi_requests_owner on ravi_requests(owner_id);
create index if not exists idx_ravi_blocks_machine on ravi_blocks(machine_id);
create index if not exists idx_ravi_pending_actor on ravi_pending(actor_id, status);
`

export interface RaviRequest {
  id: string
  owner_id: string
  machine_id: string
  builder: string
  site: string
  start_date: string
  days: number
  /** The builder's own price per day. */
  offered_day: number
  status: 'pending' | 'quoted' | 'declined'
  quote_day: number | null
  demo: number
  created_at: number
  updated_at: number
}

export interface RaviBlock {
  id: string
  owner_id: string
  machine_id: string
  from_date: string
  to_date: string
  reason: string | null
  created_at: number
}

export type PendingKind = 'quote' | 'decline' | 'rate' | 'unblock'

export interface RaviPending {
  id: string
  actor_id: string
  owner_id: string
  channel_id: string
  kind: PendingKind
  args: Record<string, any>
  /** The exact words on the approval card: what a Yes will do. */
  summary: string
  lang: string
  status: 'waiting' | 'approved' | 'cancelled' | 'replaced'
  created_at: number
}

const DAY_MS = 86_400_000
const IST_MS = 5.5 * 3_600_000

/** Today in India, as YYYY-MM-DD. */
export const today = (now = Date.now()) => new Date(now + IST_MS).toISOString().slice(0, 10)
export const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)
export const isIsoDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

const newId = (prefix: string) => `${prefix}-${randomBytes(4).toString('hex')}`

export class RaviStore {
  constructor(readonly sql: Sql) {
    sql.exec(SCHEMA)
  }

  // ------------------------------------------------------------ rental requests
  request(id: string) {
    return this.sql.get<RaviRequest>('select * from ravi_requests where id=?', id)
  }
  requests(ownerId: string, status?: string) {
    return status
      ? this.sql.all<RaviRequest>('select * from ravi_requests where owner_id=? and status=? order by start_date, created_at', ownerId, status)
      : this.sql.all<RaviRequest>('select * from ravi_requests where owner_id=? order by start_date, created_at', ownerId)
  }
  addRequest(r: Pick<RaviRequest, 'owner_id' | 'machine_id' | 'builder' | 'site' | 'start_date' | 'days' | 'offered_day'> & { demo?: boolean }): RaviRequest {
    const id = newId('RQ')
    const now = Date.now()
    this.sql.run(
      "insert into ravi_requests(id, owner_id, machine_id, builder, site, start_date, days, offered_day, status, demo, created_at, updated_at) values(?,?,?,?,?,?,?,?, 'pending', ?,?,?)",
      id,
      r.owner_id,
      r.machine_id,
      r.builder,
      r.site,
      r.start_date,
      r.days,
      r.offered_day,
      r.demo ? 1 : 0,
      now,
      now,
    )
    return this.request(id)!
  }
  setRequest(id: string, status: RaviRequest['status'], quoteDay: number | null = null) {
    this.sql.run('update ravi_requests set status=?, quote_day=?, updated_at=? where id=?', status, quoteDay, Date.now(), id)
  }

  /**
   * Demo data: the PoC has no builders yet, so the first time an owner with a live machine talks to Ravi,
   * two requests arrive for it. Marked `demo` so they are easy to tell apart later.
   */
  seedDemoRequests(ownerId: string, machines: HxMachine[]) {
    if (this.sql.get('select 1 from ravi_requests where owner_id=? and demo=1 limit 1', ownerId)) return
    const live = machines.filter((m) => m.status === 'active')
    if (!live.length) return
    const rateOf = (m: HxMachine) => m.rate_day ?? (m.rate_hour ? m.rate_hour * 8 : 700_000)
    const round = (paise: number) => Math.round(paise / 10_000) * 10_000 // to the nearest ₹100
    const t = today()
    const first = live[0]
    const second = live[1] ?? live[0]
    this.addRequest({ owner_id: ownerId, machine_id: first.id, builder: 'Zeno Constructions', site: 'Hanamkonda', start_date: addDays(t, 3), days: 5, offered_day: round(rateOf(first) * 0.9), demo: true })
    this.addRequest({ owner_id: ownerId, machine_id: second.id, builder: 'Sri Balaji Infra', site: 'Warangal', start_date: addDays(t, 10), days: 2, offered_day: round(rateOf(second)), demo: true })
  }

  // ------------------------------------------------------------ blocked dates
  block(id: string) {
    return this.sql.get<RaviBlock>('select * from ravi_blocks where id=?', id)
  }
  blocks(ownerId: string, machineId?: string) {
    const from = today()
    return machineId
      ? this.sql.all<RaviBlock>('select * from ravi_blocks where owner_id=? and machine_id=? and to_date>=? order by from_date', ownerId, machineId, from)
      : this.sql.all<RaviBlock>('select * from ravi_blocks where owner_id=? and to_date>=? order by from_date', ownerId, from)
  }
  addBlock(ownerId: string, machineId: string, from: string, to: string, reason: string | null): RaviBlock {
    const id = newId('BL')
    this.sql.run('insert into ravi_blocks(id, owner_id, machine_id, from_date, to_date, reason, created_at) values(?,?,?,?,?,?,?)', id, ownerId, machineId, from, to, reason, Date.now())
    return this.block(id)!
  }
  removeBlock(id: string) {
    this.sql.run('delete from ravi_blocks where id=?', id)
  }

  // ------------------------------------------------------------ approvals waiting for a tap
  pending(id: string): RaviPending | undefined {
    const r = this.sql.get<any>('select * from ravi_pending where id=?', id)
    return r ? { ...r, args: JSON.parse(r.args || '{}') } : undefined
  }
  waiting(actorId: string): RaviPending | undefined {
    const r = this.sql.get<any>("select * from ravi_pending where actor_id=? and status='waiting' order by created_at desc, rowid desc limit 1", actorId)
    return r ? { ...r, args: JSON.parse(r.args || '{}') } : undefined
  }
  /** One approval at a time per person: a new one replaces the card still waiting. */
  park(p: Pick<RaviPending, 'actor_id' | 'owner_id' | 'channel_id' | 'kind' | 'args' | 'summary' | 'lang'>): RaviPending {
    this.sql.run("update ravi_pending set status='replaced' where actor_id=? and status='waiting'", p.actor_id)
    const id = newId('AP')
    this.sql.run(
      "insert into ravi_pending(id, actor_id, owner_id, channel_id, kind, args, summary, lang, status, created_at) values(?,?,?,?,?,?,?,?, 'waiting', ?)",
      id,
      p.actor_id,
      p.owner_id,
      p.channel_id,
      p.kind,
      JSON.stringify(p.args),
      p.summary,
      p.lang,
      Date.now(),
    )
    return this.pending(id)!
  }
  settle(id: string, status: 'approved' | 'cancelled') {
    this.sql.run('update ravi_pending set status=? where id=?', status, id)
  }

  /** Removes records of owners HYKR no longer has (the simulated world is reset on each start). */
  purgeMissing() {
    for (const t of ['ravi_requests', 'ravi_blocks', 'ravi_pending']) this.sql.run(`delete from ${t} where owner_id not in (select id from hx_people)`)
  }
}
