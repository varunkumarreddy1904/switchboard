import { randomBytes } from 'node:crypto'
import type { Sql } from '../shared/db'

/**
 * HYKR records, in the shared kit's field-dictionary format: IDs P- (person), M- (machine), E- (evidence),
 * C- (consent); phones E.164; money in paise; times as epoch ms (shown in India time).
 * Kept in Switchboard's database for the PoC. `hx_events` is the internal history in the kit's event
 * envelope, so joining the shared event log later is just forwarding these rows.
 */
const SCHEMA = `
create table if not exists hx_people(id text primary key, person_id text unique, name text, phone text, village text, roles text, language text,
  kyc_level text, status text, owner_operator int, created_by text, created_at int, updated_at int);
create table if not exists hx_machines(id text primary key, owner_id text, status text, class text, class_other text, make text, model text, year int,
  reg_no text, reg_status text, pin text, engine_no text, rc_owner_name text, relationship text, base_lat real, base_lng real, base_label text,
  rate_hour int, rate_day int, diesel text, radius_km int, flags text, insurance_expiry text, hour_reading text, desk_note text, created_by text,
  created_at int, submitted_at int, verified_at int, updated_at int);
create table if not exists hx_evidence(id text primary key, owner_id text, machine_id text, kind text, mime text, path text, bytes int, sha256 text,
  captured_at int, captured_where text, consent_id text, message_id text, read text, read_engine text, created_at int);
create table if not exists hx_consents(id text primary key, person_id text, purpose text, channel text, language text, wording_version text,
  given_at int, withdrawn_at int, answer text, evidence_id text);
create table if not exists hx_flow(actor_id text primary key, channel_id text, owner_id text, role text, step text, machine_id text, data text,
  last_prompt_at int, reminders int default 0, started_at int, updated_at int);
create table if not exists hx_delegates(phone text primary key, owner_id text, role text, name text, added_at int);
create table if not exists hx_drivers(owner_id text primary key, phone text, name text, added_at int);
create table if not exists hx_mitras(phone text primary key, name text, added_at int);
create table if not exists hx_funnel(owner_id text, step text, first_at int, primary key(owner_id, step));
create table if not exists hx_events(id text primary key, type text, version int, occurred_at int, actor text, person_id text, machine_id text,
  payload text, rules_version text, trace_id text, idempotency_key text unique);
create index if not exists idx_hx_machines_owner on hx_machines(owner_id);
create index if not exists idx_hx_evidence_machine on hx_evidence(machine_id);
create index if not exists idx_hx_events_person on hx_events(person_id, occurred_at);
`

export interface HxPerson {
  id: string
  person_id: string
  name: string | null
  phone: string | null
  village: string | null
  roles: string
  language: string
  kyc_level: string
  status: string
  owner_operator: number | null
  created_by: string | null
  created_at: number
  updated_at: number
}

export interface HxMachine {
  id: string
  owner_id: string
  status: 'draft' | 'pending' | 'needs_info' | 'active' | 'rejected' | 'paused'
  class: string | null
  class_other: string | null
  make: string | null
  model: string | null
  year: number | null
  reg_no: string | null
  reg_status: string | null
  pin: string | null
  engine_no: string | null
  rc_owner_name: string | null
  relationship: string | null
  base_lat: number | null
  base_lng: number | null
  base_label: string | null
  rate_hour: number | null
  rate_day: number | null
  diesel: string | null
  radius_km: number | null
  flags: string | null
  insurance_expiry: string | null
  hour_reading: string | null
  desk_note: string | null
  created_by: string | null
  created_at: number
  submitted_at: number | null
  verified_at: number | null
  updated_at: number
}

export interface HxEvidence {
  id: string
  owner_id: string
  machine_id: string | null
  kind: string
  mime: string
  path: string
  bytes: number
  sha256: string
  captured_at: number
  captured_where: string | null
  consent_id: string | null
  message_id: string | null
  read: string | null
  read_engine: string | null
  created_at: number
}

export interface HxFlow {
  actor_id: string
  channel_id: string
  owner_id: string | null
  role: 'owner' | 'delegate' | 'mitra'
  step: string
  machine_id: string | null
  data: Record<string, any>
  last_prompt_at: number | null
  reminders: number
  started_at: number
  updated_at: number
}

export const RULES_VERSION = 'POC12-2026-11-v1'

export class HxStore {
  constructor(readonly sql: Sql) {
    sql.exec(SCHEMA)
  }

  /** Field-dictionary IDs: P-000001, M-000001 … (sequential per prefix). */
  nextId(prefix: 'P' | 'M' | 'E' | 'C') {
    this.sql.run("insert into counters(key,value) values(?,1) on conflict(key) do update set value=value+1", `hx:${prefix}`)
    const n = this.sql.get<{ value: number }>('select value from counters where key=?', `hx:${prefix}`)!.value
    return `${prefix}-${String(n).padStart(6, '0')}`
  }

  // ------------------------------------------------------------ people
  personBySwitchboard(personId: string) {
    return this.sql.get<HxPerson>('select * from hx_people where person_id=?', personId)
  }
  person(id: string) {
    return this.sql.get<HxPerson>('select * from hx_people where id=?', id)
  }
  ensurePerson(personId: string, phone: string | null, createdBy = 'whatsapp'): HxPerson {
    const p = this.personBySwitchboard(personId)
    if (p) return p
    const id = this.nextId('P')
    const now = Date.now()
    this.sql.run(
      "insert into hx_people(id, person_id, phone, roles, language, kyc_level, status, created_by, created_at, updated_at) values(?,?,?,'[\"owner\"]','en','T0','onboarding',?,?,?)",
      id,
      personId,
      phone,
      createdBy,
      now,
      now,
    )
    return this.person(id)!
  }
  updatePerson(id: string, fields: Partial<HxPerson>) {
    const keys = Object.keys(fields)
    if (!keys.length) return
    this.sql.run(`update hx_people set ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? where id=?`, ...keys.map((k) => (fields as any)[k]), Date.now(), id)
  }

  // ------------------------------------------------------------ machines
  machine(id: string) {
    return this.sql.get<HxMachine>('select * from hx_machines where id=?', id)
  }
  machines(ownerId: string) {
    return this.sql.all<HxMachine>('select * from hx_machines where owner_id=? order by created_at', ownerId)
  }
  createMachine(ownerId: string, createdBy: string): HxMachine {
    const id = this.nextId('M')
    const now = Date.now()
    this.sql.run("insert into hx_machines(id, owner_id, status, flags, created_by, created_at, updated_at) values(?,?, 'draft', '[]', ?,?,?)", id, ownerId, createdBy, now, now)
    return this.machine(id)!
  }
  updateMachine(id: string, fields: Partial<HxMachine>) {
    const keys = Object.keys(fields)
    if (!keys.length) return
    this.sql.run(`update hx_machines set ${keys.map((k) => `${k}=?`).join(', ')}, updated_at=? where id=?`, ...keys.map((k) => (fields as any)[k]), Date.now(), id)
  }
  flags(m: HxMachine): string[] {
    return JSON.parse(m.flags || '[]')
  }
  addFlag(id: string, flag: string) {
    const m = this.machine(id)
    if (!m) return
    const f = new Set(this.flags(m))
    f.add(flag)
    this.updateMachine(id, { flags: JSON.stringify([...f]) })
  }

  // ------------------------------------------------------------ evidence
  evidence(id: string) {
    return this.sql.get<HxEvidence>('select * from hx_evidence where id=?', id)
  }
  evidenceFor(machineId: string) {
    return this.sql.all<HxEvidence>('select * from hx_evidence where machine_id=? order by created_at', machineId)
  }
  evidenceOfKind(machineId: string, kind: string) {
    return this.sql.get<HxEvidence>('select * from hx_evidence where machine_id=? and kind=? order by created_at desc limit 1', machineId, kind)
  }

  // ------------------------------------------------------------ drivers (an owner who does not drive)
  /** The person who drives an owner's machines. Kept apart from delegates: a driver cannot act for the owner. */
  driver(ownerId: string) {
    return this.sql.get<{ phone: string; name: string | null; added_at: number }>('select phone, name, added_at from hx_drivers where owner_id=?', ownerId)
  }

  setDriver(ownerId: string, phone: string, name: string | null) {
    this.sql.run('insert into hx_drivers(owner_id, phone, name, added_at) values(?,?,?,?) on conflict(owner_id) do update set phone=excluded.phone, name=excluded.name, added_at=excluded.added_at', ownerId, phone, name, Date.now())
  }

  // ------------------------------------------------------------ consents (one record per purpose)
  consent(personId: string, purpose: string) {
    return this.sql.get<{ id: string; given_at: number; withdrawn_at: number | null; channel: string }>(
      'select * from hx_consents where person_id=? and purpose=? and withdrawn_at is null order by given_at desc limit 1',
      personId,
      purpose,
    )
  }
  consents(personId: string) {
    return this.sql.all<any>('select * from hx_consents where person_id=? order by given_at', personId)
  }
  giveConsent(personId: string, purpose: 'C1' | 'C2', channel: 'whatsapp' | 'paper' | 'app', wordingVersion: string, answer: string, evidenceId: string | null = null) {
    const id = this.nextId('C')
    this.sql.run(
      "insert into hx_consents(id, person_id, purpose, channel, language, wording_version, given_at, answer, evidence_id) values(?,?,?,?, 'en', ?,?,?,?)",
      id,
      personId,
      purpose,
      channel,
      wordingVersion,
      Date.now(),
      answer.slice(0, 300),
      evidenceId,
    )
    return id
  }
  withdrawAll(personId: string) {
    const rows = this.sql.all<{ id: string; purpose: string }>('select id, purpose from hx_consents where person_id=? and withdrawn_at is null', personId)
    this.sql.run('update hx_consents set withdrawn_at=? where person_id=? and withdrawn_at is null', Date.now(), personId)
    return rows
  }

  // ------------------------------------------------------------ conversation state (one per person chatting)
  flow(actorId: string): HxFlow | undefined {
    const r = this.sql.get<any>('select * from hx_flow where actor_id=?', actorId)
    return r ? { ...r, data: JSON.parse(r.data || '{}') } : undefined
  }
  saveFlow(f: HxFlow) {
    this.sql.run(
      `insert into hx_flow(actor_id, channel_id, owner_id, role, step, machine_id, data, last_prompt_at, reminders, started_at, updated_at) values(?,?,?,?,?,?,?,?,?,?,?)
       on conflict(actor_id) do update set channel_id=excluded.channel_id, owner_id=excluded.owner_id, role=excluded.role, step=excluded.step, machine_id=excluded.machine_id,
       data=excluded.data, last_prompt_at=excluded.last_prompt_at, reminders=excluded.reminders, updated_at=excluded.updated_at`,
      f.actor_id,
      f.channel_id,
      f.owner_id,
      f.role,
      f.step,
      f.machine_id,
      JSON.stringify(f.data),
      f.last_prompt_at,
      f.reminders,
      f.started_at,
      Date.now(),
    )
  }

  /** First time an owner reached a step: the drop-off funnel. */
  reached(ownerId: string, step: string) {
    this.sql.run('insert or ignore into hx_funnel(owner_id, step, first_at) values(?,?,?)', ownerId, step, Date.now())
  }

  // ------------------------------------------------------------ events (kit envelope)
  emit(type: string, e: { actor: string; personId?: string | null; machineId?: string | null; payload?: Record<string, unknown>; key?: string }) {
    const id = `EV-${randomBytes(6).toString('hex')}`
    const trace = e.machineId ?? e.personId ?? id
    this.sql.run(
      'insert or ignore into hx_events(id, type, version, occurred_at, actor, person_id, machine_id, payload, rules_version, trace_id, idempotency_key) values(?,?,1,?,?,?,?,?,?,?,?)',
      id,
      type,
      Date.now(),
      e.actor,
      e.personId ?? null,
      e.machineId ?? null,
      JSON.stringify(e.payload ?? {}),
      RULES_VERSION,
      trace,
      e.key ?? id,
    )
  }
  events(personId: string, limit = 200) {
    return this.sql
      .all<any>('select * from hx_events where person_id=? order by occurred_at desc limit ?', personId, limit)
      .map((e) => ({ ...e, payload: JSON.parse(e.payload || '{}') }))
  }
}
