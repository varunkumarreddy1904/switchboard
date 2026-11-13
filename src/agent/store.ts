import { Sql } from '../shared/db'
import { uid } from '../shared/ids'
import { TIMING_SCHEMA } from './timing'

export interface ChannelRow {
  id: string
  kind: 'cloud' | 'linked'
  mode: 'sandbox' | 'live'
  name: string
  config: string
  status: string
  status_detail: string | null
  created_at: number
}

export interface PersonRow {
  id: string
  display_name: string
  created_at: number
  account_status: 'none' | 'onboarding' | 'active' | 'declined'
  opted_out: number
  role: string | null
  cadence: string | null
}

export interface LinkRow {
  kind: 'pn' | 'bsuid' | 'lid'
  value: string
  person_id: string
  source: string
  channel_id: string
  created_at: number
}

export interface ConversationRow {
  id: string
  channel_id: string
  kind: 'dm' | 'group' | 'community_sub' | 'community_announce' | 'community'
  lane: 'A' | 'B'
  external_id: string
  title: string
  person_id: string | null
  community_id: string | null
  last_inbound_at: number | null
  last_message_at: number | null
  unread: number
  status: 'open' | 'resolved'
  assignee: string | null
  members: number | null
  blocked: number
}

export interface MessageRow {
  id: string
  conversation_id: string
  external_id: string | null
  dir: 'in' | 'out' | 'system'
  sender_person_id: string | null
  sender_label: string | null
  type: string
  text: string
  payload: string | null
  status: string | null
  error: string | null
  at: number
  edited: number
  deleted: number
  reactions: string | null
  redactions: number
}

const SCHEMA = `
create table if not exists settings(key text primary key, value text);
create table if not exists channels(id text primary key, kind text, mode text, name text, config text, status text, status_detail text, created_at int);
create table if not exists inbox(id integer primary key autoincrement, channel_id text, received_at int, body text, processed int default 0, error text);
create table if not exists dedupe(key text primary key, at int);
create table if not exists persons(id text primary key, display_name text, created_at int, account_status text default 'none', opted_out int default 0, role text, cadence text);
create table if not exists identity_links(kind text, value text, person_id text, source text, channel_id text, created_at int, primary key(kind, value, channel_id));
create index if not exists idx_links_person on identity_links(person_id);
create table if not exists conversations(id text primary key, channel_id text, kind text, lane text, external_id text, title text, person_id text, community_id text,
  last_inbound_at int, last_message_at int, unread int default 0, status text default 'open', assignee text, members int, blocked int default 0, unique(channel_id, external_id));
create table if not exists messages(id text primary key, conversation_id text, external_id text, dir text, sender_person_id text, sender_label text, type text, text text,
  payload text, status text, error text, at int, edited int default 0, deleted int default 0, reactions text, redactions int default 0);
create index if not exists idx_msg_conv on messages(conversation_id, at);
create index if not exists idx_msg_ext on messages(external_id);
create table if not exists onboarding(person_id text, channel_id text, step text, data text, session_id text, updated_at int, primary key(person_id, channel_id));
create table if not exists app_sessions(id text primary key, channel_id text, created_at int, person_id text, status text, nonce_used int default 0, magic_token text, method text);
create table if not exists otps(id text primary key, session_id text, channel_id text, phone text, code_hash text, expires_at int, attempts int default 0, status text, wamid text, error text);
create table if not exists consent(conversation_id text primary key, granted_by text, granted_at int, scope text);
create table if not exists group_requests(request_id text primary key, channel_id text, subject text, created_at int, status text, group_id text, error text);
create table if not exists api_groups(group_id text primary key, channel_id text, subject text, invite_link text, created_at int, participants text);
create table if not exists digests(id text primary key, conversation_id text, created_at int, engine text, kind text, question text, content text);
create table if not exists counters(key text primary key, value int);
create table if not exists broadcasts(id text primary key, channel_id text, created_at int, template text, recipients int, accepted int, failed int, results text);
create table if not exists media(id text primary key, conversation_id text, message_id text, dir text, path text, mime text, bytes int, duration_ms int, created_at int, deleted_at int);
create index if not exists idx_media_created on media(created_at);
`

export class Store {
  constructor(readonly sql: Sql) {
    sql.exec(SCHEMA)
    sql.exec(TIMING_SCHEMA)
  }

  // -- settings
  setting(key: string): string | undefined {
    return this.sql.get<{ value: string }>('select value from settings where key=?', key)?.value
  }
  setSetting(key: string, value: string | null) {
    if (value === null) this.sql.run('delete from settings where key=?', key)
    else this.sql.run('insert into settings(key,value) values(?,?) on conflict(key) do update set value=excluded.value', key, value)
  }

  // -- dedupe: key = field:id:status so statuses sharing a wamid are not collapsed
  seen(key: string): boolean {
    const r = this.sql.run('insert or ignore into dedupe(key, at) values(?, ?)', key, Date.now())
    return Number(r.changes) === 0
  }

  bump(key: string, by = 1) {
    this.sql.run('insert into counters(key,value) values(?,?) on conflict(key) do update set value=value+excluded.value', key, by)
  }
  counter(key: string) {
    return this.sql.get<{ value: number }>('select value from counters where key=?', key)?.value ?? 0
  }

  // -- persons + identity
  person(id: string) {
    return this.sql.get<PersonRow>('select * from persons where id=?', id)
  }
  createPerson(name: string): PersonRow {
    const p: PersonRow = { id: uid('per'), display_name: name, created_at: Date.now(), account_status: 'none', opted_out: 0, role: null, cadence: null }
    this.sql.run('insert into persons(id, display_name, created_at, account_status) values(?,?,?,?)', p.id, p.display_name, p.created_at, p.account_status)
    return p
  }
  findByLink(kind: LinkRow['kind'], value: string, channelId?: string): string | undefined {
    const row = channelId
      ? this.sql.get<{ person_id: string }>('select person_id from identity_links where kind=? and value=? and channel_id=?', kind, value, channelId)
      : this.sql.get<{ person_id: string }>('select person_id from identity_links where kind=? and value=? order by created_at limit 1', kind, value)
    return row?.person_id
  }
  addLink(personId: string, kind: LinkRow['kind'], value: string, source: string, channelId: string) {
    this.sql.run(
      'insert or ignore into identity_links(kind, value, person_id, source, channel_id, created_at) values(?,?,?,?,?,?)',
      kind,
      value,
      personId,
      source,
      channelId,
      Date.now(),
    )
  }
  links(personId: string) {
    return this.sql.all<LinkRow>('select * from identity_links where person_id=? order by created_at', personId)
  }
  address(personId: string, channelId: string): string | undefined {
    // Prefer the phone number (works everywhere); fall back to this business's BSUID.
    const pn = this.sql.get<{ value: string }>("select value from identity_links where person_id=? and kind='pn' order by created_at limit 1", personId)
    if (pn) return pn.value
    return this.sql.get<{ value: string }>("select value from identity_links where person_id=? and kind='bsuid' and channel_id=?", personId, channelId)?.value
  }
  /** Moves everything from `drop` onto `keep`. Used when a phone number proves two records are one person. */
  merge(keep: string, drop: string) {
    if (keep === drop) return
    this.sql.tx(() => {
      this.sql.run('update or ignore identity_links set person_id=? where person_id=?', keep, drop)
      this.sql.run('delete from identity_links where person_id=?', drop)
      this.sql.run('update messages set sender_person_id=? where sender_person_id=?', keep, drop)
      this.sql.run('update conversations set person_id=? where person_id=?', keep, drop)
      this.sql.run('update or ignore onboarding set person_id=? where person_id=?', keep, drop)
      this.sql.run('delete from onboarding where person_id=?', drop)
      this.sql.run('update app_sessions set person_id=? where person_id=?', keep, drop)
      const d = this.person(drop)
      const k = this.person(keep)
      if (d && k && k.account_status === 'none' && d.account_status !== 'none') {
        this.sql.run('update persons set account_status=?, role=?, cadence=? where id=?', d.account_status, d.role, d.cadence, keep)
      }
      this.sql.run('delete from persons where id=?', drop)
    })
  }

  // -- conversations + messages
  conversation(id: string) {
    return this.sql.get<ConversationRow>('select * from conversations where id=?', id)
  }
  conversationByExternal(channelId: string, externalId: string) {
    return this.sql.get<ConversationRow>('select * from conversations where channel_id=? and external_id=?', channelId, externalId)
  }
  ensureConversation(c: Pick<ConversationRow, 'channel_id' | 'kind' | 'lane' | 'external_id' | 'title'> & Partial<ConversationRow>): ConversationRow {
    const existing = this.conversationByExternal(c.channel_id, c.external_id)
    if (existing) {
      if ((c.title && c.title !== existing.title) || (c.members && c.members !== existing.members) || (c.kind && c.kind !== existing.kind)) {
        this.sql.run('update conversations set title=?, members=coalesce(?, members), kind=? where id=?', c.title || existing.title, c.members, c.kind, existing.id)
      }
      return this.conversation(existing.id)!
    }
    const id = uid('conv')
    this.sql.run(
      `insert into conversations(id, channel_id, kind, lane, external_id, title, person_id, community_id, members, status, unread, blocked)
       values(?,?,?,?,?,?,?,?,?, 'open', 0, 0)`,
      id,
      c.channel_id,
      c.kind,
      c.lane,
      c.external_id,
      c.title,
      c.person_id ?? null,
      c.community_id ?? null,
      c.members ?? null,
    )
    return this.conversation(id)!
  }
  addMessage(m: Omit<MessageRow, 'id' | 'edited' | 'deleted' | 'reactions' | 'redactions'> & Partial<Pick<MessageRow, 'redactions'>>): MessageRow {
    const id = uid('msg')
    this.sql.run(
      `insert into messages(id, conversation_id, external_id, dir, sender_person_id, sender_label, type, text, payload, status, error, at, redactions)
       values(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      m.conversation_id,
      m.external_id,
      m.dir,
      m.sender_person_id,
      m.sender_label,
      m.type,
      m.text,
      m.payload,
      m.status,
      m.error,
      m.at,
      m.redactions ?? 0,
    )
    const inbound = m.dir === 'in'
    this.sql.run(
      `update conversations set last_message_at=max(coalesce(last_message_at,0), ?), unread=unread+?, status=case when ? then 'open' else status end ${inbound ? ', last_inbound_at=?' : ''} where id=?`,
      ...(inbound ? [m.at, 1, 1, m.at, m.conversation_id] : [m.at, 0, 0, m.conversation_id]),
    )
    return this.sql.get<MessageRow>('select * from messages where id=?', id)!
  }
  /** Updates a stored message's text and payload (used when a voice note's transcript arrives). */
  setMessageContent(id: string, text: string, payload: unknown) {
    this.sql.run('update messages set text=?, payload=? where id=?', text, payload === null ? null : JSON.stringify(payload), id)
  }
  messageByExternal(externalId: string) {
    return this.sql.get<MessageRow>('select * from messages where external_id=?', externalId)
  }
  messages(conversationId: string, limit = 200) {
    return this.sql
      .all<MessageRow>('select * from messages where conversation_id=? order by at desc, rowid desc limit ?', conversationId, limit)
      .reverse()
  }

  // -- consent
  consent(conversationId: string) {
    return this.sql.get<{ conversation_id: string; granted_by: string; granted_at: number; scope: string }>('select * from consent where conversation_id=?', conversationId)
  }

  clearChannelData(channelIds: string[]) {
    if (!channelIds.length) return
    const q = channelIds.map(() => '?').join(',')
    this.sql.tx(() => {
      const convs = this.sql.all<{ id: string }>(`select id from conversations where channel_id in (${q})`, ...channelIds).map((c) => c.id)
      if (convs.length) {
        const cq = convs.map(() => '?').join(',')
        this.sql.run(`delete from messages where conversation_id in (${cq})`, ...convs)
        this.sql.run(`delete from consent where conversation_id in (${cq})`, ...convs)
        this.sql.run(`delete from digests where conversation_id in (${cq})`, ...convs)
        // The audio files themselves are removed by the voice sweeper once their rows are gone.
        this.sql.run(`delete from media where conversation_id in (${cq})`, ...convs)
      }
      this.sql.run(`delete from conversations where channel_id in (${q})`, ...channelIds)
      this.sql.run(`delete from onboarding where channel_id in (${q})`, ...channelIds)
      this.sql.run(`delete from app_sessions where channel_id in (${q})`, ...channelIds)
      this.sql.run(`delete from otps where channel_id in (${q})`, ...channelIds)
      this.sql.run(`delete from group_requests where channel_id in (${q})`, ...channelIds)
      this.sql.run(`delete from api_groups where channel_id in (${q})`, ...channelIds)
      this.sql.run(`delete from broadcasts where channel_id in (${q})`, ...channelIds)
      this.sql.run(`delete from inbox where channel_id in (${q})`, ...channelIds)
      this.sql.run(`delete from identity_links where channel_id in (${q})`, ...channelIds)
      this.sql.run('delete from persons where id not in (select person_id from identity_links)')
      for (const ch of channelIds) {
        // dedupe + counter keys are prefixed with the channel id
        this.sql.run('delete from counters where key like ?', `${ch}:%`)
        this.sql.run('delete from dedupe where key like ?', `${ch}:%`)
      }
    })
  }
}
