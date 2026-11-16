import type { Bus } from '../shared/bus'
import { randomToken } from '../shared/crypto'
import type { Sql } from '../shared/db'
import type { LinkedSocketFactory } from '../shared/linkedSocket'
import { BUSINESS } from '../sandbox/seed'
import { Channels, SANDBOX_CLOUD, SANDBOX_LINKED, type CloudChannel, type CloudConfig } from './channels'
import { CloudClient, type GraphResponse } from './cloudClient'
import { Groups } from './groups'
import { Identity } from './identity'
import { LinkedManager } from './linked'
import { Llm } from './llm'
import { Onboarding } from './onboarding'
import { Store, type ConversationRow, type MessageRow } from './store'
import { KeyedQueue } from '../shared/queue'
import { t, youCanSay } from './i18n'
import type { Lang } from './voice/engines'
import { hasDevanagari, hasTelugu, scriptLang, spokenText } from './voice/match'
import { Voice } from './voice/service'
import type { Brain } from './inbound'
import { currentStopwatch } from './timing'

const RANK: Record<string, number> = { accepted: 0, sent: 1, delivered: 2, read: 3 }

export interface AgentOptions {
  sql: Sql
  bus: Bus
  dataDir: string
  sandboxLinkedFactory: LinkedSocketFactory
}

/** The agent: one brain consuming both lanes. Knows nothing about the sandbox beyond its channels. */
export class Agent {
  readonly store: Store
  readonly channels: Channels
  readonly identity: Identity
  readonly llm: Llm
  readonly onboarding: Onboarding
  readonly groups: Groups
  readonly linked: LinkedManager
  readonly voice: Voice
  /** Onboarding funnel for the dashboard, supplied by the app plugged in (HYKR). */
  dashboardFunnel: () => unknown = () => null
  /** The business logic answering 1:1 messages (EquipXchange onboarding for PoC #12). Set by the app. */
  brain: Brain = { handle: async (m) => void this.bus.log({ kind: 'agent', lane: 'A', title: 'No brain configured: message stored only', detail: m.text.slice(0, 80) }) }
  /** Handles each person's messages one at a time, in order (a voice note can take seconds to transcribe). */
  readonly serial = new KeyedQueue()
  readonly secret: string
  failNextWebhooks = 0
  internalBase = ''

  constructor(readonly opts: AgentOptions) {
    const { sql, bus } = opts
    this.store = new Store(sql)
    this.channels = new Channels(this.store, bus)
    this.identity = new Identity(this.store, bus)
    this.llm = new Llm(
      bus,
      () => this.store.setting('anthropicApiKey') || process.env.ANTHROPIC_API_KEY || undefined,
      () => this.store.setting('anthropicModel') || process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
    )
    let secret = this.store.setting('agentSecret')
    if (!secret) {
      secret = randomToken(32)
      this.store.setSetting('agentSecret', secret)
    }
    this.secret = secret
    this.onboarding = new Onboarding(this)
    this.groups = new Groups(this)
    this.linked = new LinkedManager(this, opts.sandboxLinkedFactory, opts.dataDir)
    this.voice = new Voice(this, opts.dataDir)
  }

  /**
   * The language to answer in: Hindi or Telugu if the person's latest message (or voice note) was in it, else English.
   * Button taps carry the tapped title, so a Hindi button keeps the conversation in Hindi.
   */
  convLang(conversationId: string): Lang {
    const rows = this.store.sql.all<{ type: string; text: string; payload: string | null }>(
      "select type, text, payload from messages where conversation_id=? and dir='in' order by at desc, rowid desc limit 6",
      conversationId,
    )
    for (const r of rows) {
      if (r.type === 'audio') {
        const lang = r.payload ? JSON.parse(r.payload).lang : undefined
        if (lang) return lang === 'hi' || lang === 'te' ? lang : 'en'
        continue
      }
      if (!r.text || r.text.startsWith('[')) continue
      if (hasTelugu(r.text)) return 'te'
      if (hasDevanagari(r.text)) return 'hi'
      if (/[a-z]{2}/i.test(r.text)) return 'en'
    }
    return 'en'
  }

  get bus() {
    return this.opts.bus
  }

  /** Called once the HTTP server knows its address. */
  init(internalBase: string) {
    this.internalBase = internalBase
    const cfg: CloudConfig = {
      graphBase: `${internalBase}/graph`,
      graphVersion: 'v24.0',
      phoneNumberId: BUSINESS.phoneNumberId,
      wabaId: BUSINESS.wabaId,
      accessToken: BUSINESS.accessToken,
      appSecret: BUSINESS.appSecret,
      verifyToken: BUSINESS.verifyToken,
      displayPhone: BUSINESS.displayPhone,
      otpTemplate: 'otp_login',
      otpLanguage: 'en_US',
      reengageTemplate: 'welcome_back',
      inviteTemplate: 'group_invite',
      oba: true,
    }
    this.channels.upsert({ id: SANDBOX_CLOUD, kind: 'cloud', mode: 'sandbox', name: 'EquipXchange · official (sandbox)', config: cfg, status: 'ready' })
    this.channels.upsert({ id: SANDBOX_LINKED, kind: 'linked', mode: 'sandbox', name: 'Ops member number (sandbox)', config: { source: 'sandbox' } })
    this.linked.boot()
  }

  publicBase() {
    return (this.store.setting('publicBaseUrl') || process.env.PUBLIC_BASE_URL || this.internalBase).replace(/\/$/, '')
  }

  client(channelId: string): CloudClient {
    const ch = this.channels.cloud(channelId)
    if (!ch) throw new Error(`No Cloud API channel ${channelId}`)
    // A live number whose token Meta rejects is shown as broken on the Live lab card, not left looking "ready".
    return new CloudClient(ch, this.bus, ch.mode === 'live' ? (detail) => this.channels.setStatus(ch.id, 'error', detail) : undefined)
  }

  cloudChannel(channelId: string): CloudChannel {
    const ch = this.channels.cloud(channelId)
    if (!ch) throw new Error(`No Cloud API channel ${channelId}`)
    return ch
  }

  dmConversation(channelId: string, personId: string): ConversationRow {
    const existing = this.store.sql.get<ConversationRow>("select * from conversations where channel_id=? and kind='dm' and person_id=? limit 1", channelId, personId)
    if (existing) return existing
    const p = this.store.person(personId)
    return this.store.ensureConversation({ channel_id: channelId, kind: 'dm', lane: 'A', external_id: `dm:${personId}`, title: p?.display_name ?? 'Contact', person_id: personId })
  }

  /** Sends through the Cloud API and records the outbound message with its wamid and sync result. */
  async sendDm(
    channelId: string,
    personId: string,
    send: (c: CloudClient, to: string) => Promise<GraphResponse>,
    record: { type: string; text: string; payload?: unknown },
  ): Promise<{ ok: boolean; message?: MessageRow; error?: string }> {
    const to = this.store.address(personId, channelId)
    const conv = this.dmConversation(channelId, personId)
    if (!to) {
      const m = this.store.addMessage({ conversation_id: conv.id, external_id: null, dir: 'out', sender_person_id: null, sender_label: 'agent', type: record.type, text: record.text, payload: record.payload ? JSON.stringify(record.payload) : null, status: 'failed', error: JSON.stringify({ message: 'No address for this contact on this channel' }), at: Date.now() })
      return { ok: false, message: m, error: 'no address' }
    }
    const res = await send(this.client(channelId), to)
    const wamid: string | undefined = res.json?.messages?.[0]?.id
    const m = this.store.addMessage({
      conversation_id: conv.id,
      external_id: wamid ?? null,
      dir: 'out',
      sender_person_id: null,
      sender_label: 'agent',
      type: record.type,
      text: record.text,
      payload: record.payload ? JSON.stringify(record.payload) : null,
      status: res.ok ? 'accepted' : 'failed',
      error: res.ok ? null : JSON.stringify(res.error),
      at: Date.now(),
    })
    this.bus.change('conversations', { id: conv.id })
    // First reply accepted by Meta: stop the stopwatch for the message being answered (if any).
    if (res.ok) currentStopwatch()?.replied()
    return { ok: res.ok, message: m, error: res.ok ? undefined : res.error?.message }
  }

  /**
   * Bot text reply. In voice mode it is spoken as a voice note instead; text containing a link is
   * spoken without the link and also sent as text, because a link can't be tapped in audio.
   * `voice: false` always sends text (messages a person types in the console).
   */
  async text(channelId: string, personId: string, body: string, opts: { voice?: boolean } = {}) {
    if (opts.voice !== false && this.voice.wantsVoice(channelId, personId)) {
      const { speech, hadLink } = spokenText(body)
      const lang: Lang = scriptLang(body)
      const spoken = speech ? await this.voice.speak(channelId, personId, hadLink ? `${speech} ${t(lang, 'linkAlsoSent')}` : speech, lang) : { ok: false }
      if (spoken.ok && !hadLink) return spoken
    }
    return this.sendDm(channelId, personId, (c, to) => c.sendText(to, body), { type: 'text', text: body })
  }

  /** Buttons can't ride on a voice note: in voice mode the question is spoken first, then the buttons follow. */
  async buttons(channelId: string, personId: string, body: string, buttons: { id: string; title: string }[], opts: { voice?: boolean } = {}) {
    if (opts.voice !== false) await this.speakChoices(channelId, personId, body, buttons.map((b) => b.title))
    return this.sendDm(channelId, personId, (c, to) => c.sendButtons(to, body, buttons), { type: 'interactive', text: body, payload: { buttons } })
  }

  async list(channelId: string, personId: string, body: string, button: string, rows: { id: string; title: string; description?: string }[]) {
    await this.speakChoices(channelId, personId, body, rows.map((r) => r.title))
    return this.sendDm(channelId, personId, (c, to) => c.sendList(to, body, button, rows), { type: 'interactive', text: body, payload: { list: { button, rows } } })
  }

  private async speakChoices(channelId: string, personId: string, body: string, options: string[]) {
    if (!this.voice.wantsVoice(channelId, personId)) return
    const lang: Lang = scriptLang(body)
    await this.voice.speak(channelId, personId, `${spokenText(body).speech} ${youCanSay(lang, options)}`, lang)
  }

  template(channelId: string, personId: string, name: string, language: string, params: string[], label?: string) {
    const components = params.length ? [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] : []
    return this.sendDm(channelId, personId, (c, to) => c.sendTemplate(to, name, language, components), { type: 'template', text: label ?? `Template "${name}" (${params.join(', ')})`, payload: { template: name, params } })
  }

  /** Applies a status webhook with precedence: never downgrade read → delivered when statuses arrive out of order. */
  applyStatus(wamid: string, status: string, error?: unknown): MessageRow | undefined {
    const m = this.store.messageByExternal(wamid)
    if (!m) return undefined
    if (status === 'failed') {
      this.store.sql.run('update messages set status=?, error=? where id=?', 'failed', JSON.stringify(error ?? {}), m.id)
    } else if ((RANK[status] ?? -1) > (RANK[m.status ?? 'accepted'] ?? -1) && m.status !== 'failed') {
      this.store.sql.run('update messages set status=? where id=?', status, m.id)
    }
    this.bus.change('conversations', { id: m.conversation_id })
    return this.store.sql.get<MessageRow>('select * from messages where id=?', m.id)
  }

  /** Callbacks after sandbox data is cleared (the app plugged in removes its own records for those people). */
  readonly onSandboxCleared: (() => void)[] = []

  resetSandboxData() {
    this.store.clearChannelData([SANDBOX_CLOUD, SANDBOX_LINKED])
    for (const f of this.onSandboxCleared) f()
    this.linked.resetSandbox()
    this.bus.change('conversations')
    this.bus.change('contacts')
    this.bus.change('groups')
  }
}
