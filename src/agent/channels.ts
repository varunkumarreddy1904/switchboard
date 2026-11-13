import type { Bus } from '../shared/bus'
import { randomToken } from '../shared/crypto'
import type { ChannelRow, Store } from './store'

export interface CloudConfig {
  graphBase: string
  graphVersion: string
  phoneNumberId: string
  wabaId: string
  accessToken: string
  appSecret: string
  verifyToken: string
  displayPhone?: string
  otpTemplate: string
  otpLanguage: string
  reengageTemplate?: string
  inviteTemplate?: string
  /** Lane A groups need an Official Business Account; informational for live numbers. */
  oba?: boolean
  /** When Meta says the access token expires (ms since epoch; 0 = never). Filled by Test connection; cleared when the token changes. */
  tokenExpiresAt?: number
}

export interface LinkedConfig {
  source: 'sandbox' | 'baileys'
  ackBanRisk?: boolean
  phone?: string
}

export interface Channel<C = CloudConfig | LinkedConfig> {
  id: string
  kind: 'cloud' | 'linked'
  mode: 'sandbox' | 'live'
  name: string
  config: C
  status: string
  statusDetail: string | null
  createdAt: number
}

export type CloudChannel = Channel<CloudConfig> & { kind: 'cloud' }
export type LinkedChannel = Channel<LinkedConfig> & { kind: 'linked' }

export const SANDBOX_CLOUD = 'sbx-cloud'
export const SANDBOX_LINKED = 'sbx-linked'

const SECRET_KEYS = ['accessToken', 'appSecret'] as const

export class Channels {
  constructor(
    private store: Store,
    private bus: Bus,
  ) {}

  private parse(r: ChannelRow): Channel {
    return { id: r.id, kind: r.kind, mode: r.mode, name: r.name, config: JSON.parse(r.config), status: r.status, statusDetail: r.status_detail, createdAt: r.created_at }
  }

  all(): Channel[] {
    return this.store.sql.all<ChannelRow>('select * from channels order by mode desc, created_at').map((r) => this.parse(r))
  }

  get(id: string): Channel | undefined {
    const r = this.store.sql.get<ChannelRow>('select * from channels where id=?', id)
    return r ? this.parse(r) : undefined
  }

  cloud(id: string): CloudChannel | undefined {
    const c = this.get(id)
    return c?.kind === 'cloud' ? (c as CloudChannel) : undefined
  }

  upsert(c: Omit<Channel, 'createdAt' | 'status' | 'statusDetail'> & Partial<Pick<Channel, 'status' | 'statusDetail'>>) {
    const existing = this.get(c.id)
    this.store.sql.run(
      `insert into channels(id, kind, mode, name, config, status, status_detail, created_at) values(?,?,?,?,?,?,?,?)
       on conflict(id) do update set name=excluded.name, config=excluded.config`,
      c.id,
      c.kind,
      c.mode,
      c.name,
      JSON.stringify(c.config),
      c.status ?? existing?.status ?? 'ready',
      c.statusDetail ?? existing?.statusDetail ?? null,
      existing?.createdAt ?? Date.now(),
    )
    this.bus.change('channels')
    return this.get(c.id)!
  }

  setStatus(id: string, status: string, detail: string | null = null) {
    this.store.sql.run('update channels set status=?, status_detail=? where id=?', status, detail, id)
    this.bus.change('channels', { id, status })
  }

  remove(id: string) {
    this.store.sql.run('delete from channels where id=?', id)
    this.bus.change('channels')
  }

  newId(prefix: 'live-cloud' | 'live-linked') {
    return `${prefix}-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`
  }

  /** Channel as shown to the console: secrets masked. */
  redacted(c: Channel) {
    const config = { ...(c.config as unknown as Record<string, unknown>) }
    for (const k of SECRET_KEYS) if (config[k]) config[k] = '••••' + String(config[k]).slice(-4)
    return { ...c, config }
  }
}
