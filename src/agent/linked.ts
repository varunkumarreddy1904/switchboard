import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  DisconnectReason,
  getContentType,
  normalizeMessageContent,
  proto,
  WAMessageStubType,
  type BaileysEventMap,
  type ConnectionState,
  type GroupMetadata,
  type WAMessage,
} from 'baileys'
import QRCode from 'qrcode'
import { statusCodeOf, type LinkedSocket, type LinkedSocketFactory } from '../shared/linkedSocket'
import type { Agent } from './agent'
import { SANDBOX_LINKED, type LinkedConfig } from './channels'
import { isPlaceholder } from './identity'
import { looksLikeInjection, redact } from './redact'
import type { ConversationRow } from './store'

export type RunnerStatus = 'disconnected' | 'connecting' | 'qr' | 'open' | 'logged_out' | 'error'

type Sock = LinkedSocket & { requestPairingCode?: (phone: string) => Promise<string> }

const META_TTL = 5 * 60 * 1000

const digitsOf = (jid?: string | null) => (jid ? jid.split('@')[0].split(':')[0] : undefined)

/**
 * Runs one linked-device channel. The same code drives the sandbox's fake socket and a real
 * Baileys socket: it only sees `LinkedSocket` (typed against Baileys v7).
 * Read-only by design: it never sends messages. (A linked device still emits delivery receipts.)
 */
export class LinkedRunner {
  status: RunnerStatus = 'disconnected'
  detail: string | null = null
  qrDataUrl?: string
  pairingCode?: string
  private sock?: Sock
  private handlers: Array<[keyof BaileysEventMap, (arg: any) => void]> = []
  private meta = new Map<string, { m: GroupMetadata; at: number }>()
  private stopped = false
  private retries = 0

  constructor(
    private agent: Agent,
    readonly channelId: string,
    private factory: () => Promise<Sock>,
    readonly live: boolean,
  ) {}

  private get store() {
    return this.agent.store
  }
  private get bus() {
    return this.agent.bus
  }

  private setStatus(s: RunnerStatus, detail: string | null = null) {
    this.status = s
    this.detail = detail
    if (s !== 'qr') this.qrDataUrl = undefined
    this.agent.channels.setStatus(this.channelId, s, detail)
    this.bus.log({ kind: 'socket.event', lane: 'B', live: this.live, title: `connection → ${s}`, detail: detail ?? undefined })
  }

  async connect() {
    this.stopped = false
    this.setStatus('connecting')
    try {
      const sock = await this.factory()
      this.attach(sock)
    } catch (e) {
      this.setStatus('error', (e as Error).message)
    }
  }

  async disconnect() {
    this.stopped = true
    const s = this.sock
    this.detach()
    this.sock = undefined
    await s?.end(undefined).catch(() => undefined)
    this.setStatus('disconnected')
  }

  /** Real Baileys only: link with an 8-character code instead of a QR. */
  async requestPairingCode(phone: string) {
    if (!this.sock?.requestPairingCode) throw new Error('Pairing codes need a live Baileys socket; the sandbox uses QR only.')
    const code = await this.sock.requestPairingCode(phone.replace(/\D/g, ''))
    this.pairingCode = code
    this.bus.change('channels')
    return code
  }

  cachedMeta(jid: string): GroupMetadata | undefined {
    return this.meta.get(jid)?.m
  }

  private on<T extends keyof BaileysEventMap>(event: T, fn: (arg: BaileysEventMap[T]) => void) {
    const wrapped = (arg: BaileysEventMap[T]) => {
      try {
        const r = fn(arg) as unknown
        if (r instanceof Promise) r.catch((e) => this.bus.log({ kind: 'agent', lane: 'B', title: `Handler error (${event})`, detail: (e as Error).message }))
      } catch (e) {
        this.bus.log({ kind: 'agent', lane: 'B', title: `Handler error (${event})`, detail: (e as Error).message })
      }
    }
    this.sock!.ev.on(event, wrapped)
    this.handlers.push([event, wrapped])
  }

  private detach() {
    if (this.sock) for (const [e, f] of this.handlers) this.sock.ev.off(e, f)
    this.handlers = []
  }

  private attach(sock: Sock) {
    this.detach()
    this.sock = sock
    this.on('connection.update', (u) => this.onConnection(u))
    this.on('messages.upsert', async ({ messages, type }) => {
      for (const m of messages) await this.onMessage(m, type)
    })
    this.on('messaging-history.set', async ({ messages, lidPnMappings }) => {
      this.bus.log({ kind: 'socket.event', lane: 'B', live: this.live, title: `messaging-history.set · ${messages.length} message(s)`, detail: 'backlog delivered as history (append)' })
      for (const map of lidPnMappings ?? []) this.agent.identity.linkLid(this.channelId, digitsOf(map.lid)!, digitsOf(map.pn)!, 'lidPnMapping')
      for (const m of messages) await this.onMessage(m, 'append')
    })
    this.on('lid-mapping.update', ({ lid, pn }) => {
      this.bus.log({ kind: 'socket.event', lane: 'B', live: this.live, title: 'lid-mapping.update', detail: this.live ? undefined : `${lid} → ${pn}` })
      this.agent.identity.linkLid(this.channelId, digitsOf(lid)!, digitsOf(pn)!, 'lid-mapping.update')
      this.bus.change('contacts')
    })
    this.on('groups.upsert', (list) => {
      for (const g of list) this.rememberGroup(g)
      this.bus.change('groups')
    })
    this.on('groups.update', (list) => {
      for (const g of list) if (g.id) this.meta.delete(g.id)
    })
    this.on('group-participants.update', (u) => {
      this.meta.delete(u.id)
      this.bus.log({ kind: 'socket.event', lane: 'B', live: this.live, title: `group-participants.update · ${u.action} ${u.participants.length}`, detail: this.live ? undefined : u.id })
    })
  }

  private onConnection(u: Partial<ConnectionState>) {
    if (u.qr) {
      QRCode.toDataURL(u.qr, { margin: 1, width: 280 }).then((d) => {
        this.qrDataUrl = d
        this.status = 'qr'
        this.agent.channels.setStatus(this.channelId, 'qr', this.live ? 'Scan with WhatsApp → Linked devices → Link a device' : 'Open the Simulator → Ops member number → Scan QR')
        this.bus.log({ kind: 'socket.event', lane: 'B', live: this.live, title: 'connection.update · qr', detail: 'QR ready to scan' })
      })
    }
    if (u.isNewLogin) this.bus.log({ kind: 'socket.event', lane: 'B', live: this.live, title: 'connection.update · isNewLogin', detail: 'paired; server will ask for a restart' })
    if (u.connection === 'open') {
      this.retries = 0
      this.pairingCode = undefined
      this.setStatus('open', 'Linked. Reading groups this number belongs to (read-only).')
      this.syncGroups().catch((e) => this.bus.log({ kind: 'agent', lane: 'B', title: 'Group sync failed', detail: (e as Error).message }))
    }
    if (u.connection === 'close') {
      const code = statusCodeOf(u.lastDisconnect?.error)
      this.detach()
      if (code === DisconnectReason.loggedOut) {
        this.setStatus('logged_out', 'Logged out (401). For a member number this usually means WhatsApp banned or unlinked it. Not reconnecting.')
        return
      }
      if (this.stopped) return
      const restart = code === DisconnectReason.restartRequired
      const delay = restart ? 0 : Math.min(30_000, 1000 * 2 ** this.retries++)
      this.setStatus('connecting', restart ? 'Restart required after pairing (515): reconnecting now' : `Closed (${code ?? 'no code'}); retrying in ${Math.round(delay / 1000)}s`)
      setTimeout(() => void this.connect(), delay)
    }
  }

  private kindOf(g: GroupMetadata): ConversationRow['kind'] {
    if (g.isCommunity) return 'community'
    if (g.isCommunityAnnounce) return 'community_announce'
    if (g.linkedParent) return 'community_sub'
    return 'group'
  }

  private rememberGroup(g: GroupMetadata) {
    this.meta.set(g.id, { m: g, at: Date.now() })
    return this.store.ensureConversation({
      channel_id: this.channelId,
      kind: this.kindOf(g),
      lane: 'B',
      external_id: g.id,
      title: g.subject,
      members: g.size ?? g.participants?.length,
      community_id: g.linkedParent ?? null,
    })
  }

  private async syncGroups() {
    const s = this.sock!
    const [groups, communities] = await Promise.all([s.groupFetchAllParticipating(), s.communityFetchAllParticipating().catch(() => ({}))])
    for (const g of [...Object.values(communities), ...Object.values(groups)]) this.rememberGroup(g)
    this.bus.log({ kind: 'agent', lane: 'B', live: this.live, title: `Group sync: ${Object.keys(groups).length} group(s), ${Object.keys(communities).length} community(ies)`, detail: 'ingestion stays blocked per group until an admin consent is recorded' })
    this.bus.change('groups')
  }

  private async metaFor(jid: string): Promise<GroupMetadata | undefined> {
    const c = this.meta.get(jid)
    if (c && Date.now() - c.at < META_TTL) return c.m
    try {
      const m = await this.sock!.groupMetadata(jid)
      this.meta.set(jid, { m, at: Date.now() })
      return m
    } catch {
      return c?.m
    }
  }

  private async onMessage(m: WAMessage, type: 'notify' | 'append') {
    const jid = m.key.remoteJid
    if (!jid || !jid.endsWith('@g.us')) return // groups lane only: DMs and status updates are ignored
    if (m.key.fromMe) return
    const id = m.key.id ?? ''
    if (this.store.seen(`${this.channelId}:linked:${jid}:${id}`)) return
    const meta = await this.metaFor(jid)
    const conv = meta ? this.rememberGroup(meta) : this.store.ensureConversation({ channel_id: this.channelId, kind: 'group', lane: 'B', external_id: jid, title: jid })

    if (!this.store.consent(conv.id)) {
      this.store.sql.run('update conversations set blocked=blocked+1 where id=?', conv.id)
      this.bus.log({ kind: 'agent', lane: 'B', live: this.live, title: `Consent gate: message dropped in "${conv.title}"`, detail: 'no admin consent recorded; content not stored' })
      this.bus.change('groups')
      return
    }

    // Sender identity: LID always, phone only when WhatsApp exposes it.
    const participant = m.key.participant ?? undefined
    const lid = participant?.endsWith('@lid') ? digitsOf(participant) : undefined
    let pn = m.key.participantAlt?.endsWith('@s.whatsapp.net') ? digitsOf(m.key.participantAlt) : participant?.endsWith('@s.whatsapp.net') ? digitsOf(participant) : undefined
    let source = 'participantAlt'
    if (!pn && participant) {
      const mapped = await this.sock!.signalRepository.lidMapping.getPNForLID(participant).catch(() => null)
      if (mapped) {
        pn = digitsOf(mapped)
        source = 'lidPnMapping'
      }
    }
    const personId = this.agent.identity.resolveLinked({ channelId: this.channelId, lid, pn, name: m.pushName ?? undefined, source })
    const stored = this.store.person(personId)?.display_name
    const senderLabel = stored && !isPlaceholder(stored) ? stored : (m.pushName ?? 'member')
    const at = Number(m.messageTimestamp ?? 0) * 1000 || Date.now()
    const base = { conversation_id: conv.id, sender_person_id: personId, sender_label: senderLabel, status: null, error: null, at }

    if (m.messageStubType) {
      if (m.messageStubType === WAMessageStubType.CIPHERTEXT) {
        this.store.bump(`${this.channelId}:undecryptable`)
        this.store.addMessage({ ...base, external_id: id, dir: 'system', type: 'ciphertext', text: '[1 message could not be decrypted; Baileys asks the sender to retry]', payload: null })
      } else if (m.messageStubType === WAMessageStubType.GROUP_PARTICIPANT_ADD || m.messageStubType === WAMessageStubType.GROUP_PARTICIPANT_LEAVE) {
        const joined = m.messageStubType === WAMessageStubType.GROUP_PARTICIPANT_ADD
        this.store.addMessage({ ...base, external_id: id, dir: 'system', type: 'system', text: `${senderLabel} ${joined ? 'joined' : 'left'}`, payload: null })
      }
      this.bus.change('conversations', { id: conv.id })
      return
    }

    const content = normalizeMessageContent(m.message)
    const ctype = content ? getContentType(content) : undefined
    if (!content || !ctype) return

    if (ctype === 'protocolMessage') {
      const pm = content.protocolMessage!
      const target = pm.key?.id ? this.store.sql.get<{ id: string }>('select id from messages where external_id=? and conversation_id=?', pm.key.id, conv.id) : undefined
      if (pm.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT && target) {
        const newText = pm.editedMessage?.conversation ?? pm.editedMessage?.extendedTextMessage?.text ?? ''
        const red = redact(newText)
        this.store.sql.run('update messages set text=?, edited=1, redactions=redactions+? where id=?', red.text, red.count, target.id)
        this.bus.log({ kind: 'agent', lane: 'B', live: this.live, title: 'Edit applied to stored message' })
      } else if (pm.type === proto.Message.ProtocolMessage.Type.REVOKE && target) {
        this.store.sql.run("update messages set text='', deleted=1 where id=?", target.id)
        this.bus.log({ kind: 'agent', lane: 'B', live: this.live, title: 'Delete-for-everyone applied: stored text erased' })
      }
      this.bus.change('conversations', { id: conv.id })
      return
    }

    if (ctype === 'reactionMessage') {
      const r = content.reactionMessage!
      const target = r.key?.id ? this.store.sql.get<{ id: string; reactions: string | null }>('select id, reactions from messages where external_id=? and conversation_id=?', r.key.id, conv.id) : undefined
      if (target) {
        const map: Record<string, string> = target.reactions ? JSON.parse(target.reactions) : {}
        if (r.text) map[personId] = r.text
        else delete map[personId]
        this.store.sql.run('update messages set reactions=? where id=?', JSON.stringify(map), target.id)
        this.bus.change('conversations', { id: conv.id })
      }
      return
    }

    const viewOnce = !!(m.message?.viewOnceMessage || m.message?.viewOnceMessageV2 || m.message?.viewOnceMessageV2Extension)
    const ephemeral = !!m.message?.ephemeralMessage
    let text =
      content.conversation ??
      content.extendedTextMessage?.text ??
      content.imageMessage?.caption ??
      content.videoMessage?.caption ??
      content.documentMessage?.caption ??
      undefined
    if (viewOnce) text = '[view-once media: content not stored]'
    if (text === undefined || text === null) text = `[${ctype.replace(/Message$/, '')}]`
    const injection = looksLikeInjection(text)
    const red = redact(text)
    this.store.addMessage({
      ...base,
      external_id: id,
      dir: 'in',
      type: ctype,
      text: red.text,
      payload: JSON.stringify({
        replyTo: content.extendedTextMessage?.contextInfo?.stanzaId ?? undefined,
        viewOnce: viewOnce || undefined,
        ephemeral: ephemeral || undefined,
        injection: injection || undefined,
        delivery: type,
      }),
      redactions: red.count,
    })
    if (injection) this.bus.log({ kind: 'agent', lane: 'B', live: this.live, title: 'Possible prompt injection flagged', detail: `in "${conv.title}"; treated as data, never as instructions` })
    this.bus.change('conversations', { id: conv.id })
  }
}

/** Real Baileys socket for a live number (ban risk). */
function liveFactory(authDir: string, runner: () => LinkedRunner | undefined): () => Promise<Sock> {
  return async () => {
    const baileys = await import('baileys')
    const { default: pino } = await import('pino')
    const { state, saveCreds } = await baileys.useMultiFileAuthState(authDir)
    let version: [number, number, number] | undefined
    try {
      version = (await baileys.fetchLatestBaileysVersion()).version
    } catch {
      version = undefined
    }
    const sock = baileys.default({
      auth: state,
      version,
      browser: baileys.Browsers.macOS('Desktop'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      logger: pino({ level: 'warn' }),
      cachedGroupMetadata: async (jid: string) => runner()?.cachedMeta(jid),
      getMessage: async () => undefined,
    })
    sock.ev.on('creds.update', saveCreds)
    return sock
  }
}

export class LinkedManager {
  runners = new Map<string, LinkedRunner>()

  constructor(
    private agent: Agent,
    private sandboxFactory: LinkedSocketFactory,
    private dataDir: string,
  ) {}

  authDir(channelId: string) {
    return join(this.dataDir, 'live-auth', channelId)
  }

  boot() {
    for (const ch of this.agent.channels.all()) {
      if (ch.kind !== 'linked') continue
      const r = this.ensure(ch.id)
      if (ch.mode === 'sandbox') void r.connect()
      else if (existsSync(join(this.authDir(ch.id), 'creds.json'))) void r.connect()
      else this.agent.channels.setStatus(ch.id, 'disconnected', 'Not linked yet')
    }
  }

  ensure(channelId: string): LinkedRunner {
    let r = this.runners.get(channelId)
    if (r) return r
    const ch = this.agent.channels.get(channelId)
    if (!ch || ch.kind !== 'linked') throw new Error(`No linked channel ${channelId}`)
    const cfg = ch.config as LinkedConfig
    const factory = cfg.source === 'sandbox' ? (this.sandboxFactory as () => Promise<Sock>) : liveFactory(this.authDir(channelId), () => this.runners.get(channelId))
    r = new LinkedRunner(this.agent, channelId, factory, ch.mode === 'live')
    this.runners.set(channelId, r)
    return r
  }

  view(channelId: string) {
    const r = this.runners.get(channelId)
    return r ? { status: r.status, detail: r.detail, qrDataUrl: r.qrDataUrl, pairingCode: r.pairingCode } : { status: 'disconnected' as const }
  }

  resetSandbox() {
    const r = this.runners.get(SANDBOX_LINKED)
    if (r) void r.connect()
  }

  async removeLive(channelId: string) {
    const r = this.runners.get(channelId)
    if (r) await r.disconnect()
    this.runners.delete(channelId)
    rmSync(this.authDir(channelId), { recursive: true, force: true })
  }
}
