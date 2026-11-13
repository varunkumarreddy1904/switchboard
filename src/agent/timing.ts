import { AsyncLocalStorage } from 'node:async_hooks'
import type { Sql } from '../shared/db'

export type InputKind = 'tap' | 'text' | 'voice' | 'photo' | 'location' | 'other'

/**
 * Stopwatch for one inbound message: from the moment Meta's webhook reached us to the moment our first
 * reply was accepted by Meta. Stages in between (queue wait, speech-to-text, deciding) are marked by the
 * code that runs them. It travels with the async work (AsyncLocalStorage), so sendDm can stop it without
 * every function passing it along.
 */
export class Stopwatch {
  readonly marks: Record<string, number> = {}
  private done = false
  constructor(
    private sql: Sql,
    readonly channelId: string,
    readonly personId: string,
    readonly kind: InputKind,
    readonly receivedAt: number,
  ) {}

  mark(stage: string) {
    if (!(stage in this.marks)) this.marks[stage] = Date.now() - this.receivedAt
  }

  /** The first reply was accepted by Meta: record the whole path once. */
  replied() {
    if (this.done) return
    this.done = true
    const total = Date.now() - this.receivedAt
    this.sql.run(
      'insert into timings(channel_id, person_id, kind, received_at, total_ms, marks, at) values(?,?,?,?,?,?,?)',
      this.channelId,
      this.personId,
      this.kind,
      this.receivedAt,
      total,
      JSON.stringify(this.marks),
      Date.now(),
    )
  }
}

export const TIMING_SCHEMA = `
create table if not exists timings(id integer primary key autoincrement, channel_id text, person_id text, kind text, received_at int, total_ms int, marks text, at int);
create index if not exists idx_timings_at on timings(at);
`

const als = new AsyncLocalStorage<Stopwatch>()

export const runTimed = <T>(sw: Stopwatch, fn: () => Promise<T>) => als.run(sw, fn)
export const currentStopwatch = () => als.getStore()

const pct = (xs: number[], p: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null)

/** p50 / p95 per input kind over the last `hours`, plus the most recent rows. */
export function timingReport(sql: Sql, hours = 24) {
  const rows = sql.all<{ id: number; channel_id: string; person_id: string; kind: string; total_ms: number; marks: string; at: number }>(
    'select * from timings where at > ? order by at desc limit 2000',
    Date.now() - hours * 3_600_000,
  )
  const kinds: Record<string, { n: number; p50: number | null; p95: number | null }> = {}
  for (const k of [...new Set(rows.map((r) => r.kind))]) {
    const xs = rows
      .filter((r) => r.kind === k)
      .map((r) => r.total_ms)
      .sort((a, b) => a - b)
    kinds[k] = { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95) }
  }
  return { kinds, recent: rows.slice(0, 60).map((r) => ({ ...r, marks: JSON.parse(r.marks || '{}') })) }
}
