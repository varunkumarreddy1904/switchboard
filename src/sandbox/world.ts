import type { Bus } from '../shared/bus'
import { digits, mulberry32, uid, unix, wamid, waWebId } from '../shared/ids'
import { createHash, randomBytes } from 'node:crypto'
import { inspectOggOpus } from '../agent/voice/ogg'
import { FakeSocket } from './fakeSocket'
import { BUSINESS, HYKR_PERSONAS, LINKED_GROUPS, MEMBER_PERSONA, NAMED_PERSONAS, SYNTHETIC_PERSONAS, TEMPLATES, type Persona } from './seed'
import type {
  ApiGroup,
  Button,
  DmMessage,
  LinkedDeviceState,
  LinkedGroup,
  LinkedMsg,
  LinkedMsgKind,
  LinkedWorld,
  ListRow,
  Status,
} from './types'
import { WebhookDispatcher, type Faults } from './webhooks'

export interface GraphResult {
  status: number
  body: unknown
}

const DAY = 24 * 60 * 60 * 1000
const GROUP_CAP = 8 // participants incl. the business number

/** Graph-style error envelope. Codes marked (sandbox) are not confirmed against Meta. */
export function graphError(status: number, code: number, message: string, opts: { type?: string; subcode?: number; details?: string } = {}): GraphResult {
  return {
    status,
    body: {
      error: {
        message,
        type: opts.type ?? 'OAuthException',
        code,
        ...(opts.subcode ? { error_subcode: opts.subcode } : {}),
        ...(opts.details ? { error_data: { messaging_product: 'whatsapp', details: opts.details } } : {}),
        fbtrace_id: 'SBX' + randomBytes(8).toString('base64url'),
      },
    },
  }
}

const noObject = (id: string) =>
  graphError(400, 100, `Unsupported request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation.`, {
    type: 'GraphMethodException',
    subcode: 33,
  })

interface TemplateState {
  id: string
  name: string
  language: string
  category: 'AUTHENTICATION' | 'UTILITY' | 'MARKETING'
  status: 'APPROVED' | 'PENDING' | 'REJECTED'
  body: string
  footer?: string
  buttons: Array<{ type: string; text: string }>
}

/** Meta's media store, simulated: uploads from the business and voice notes recorded by personas. */
export interface SandboxMedia {
  id: string
  bytes: Buffer
  mime: string
  sha256: string
  at: number
  /** Persona voice notes: the words spoken (sandbox transcript). Photos: what the document says (sandbox read). */
  script?: { text?: string; lang?: string; doc?: { kind: string; fields: Record<string, string> } }
}

/** Meta's supported audio types (16 MB each). Ogg must be Opus; voice notes must also be mono. */
const AUDIO_TYPES = ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg']
const MEDIA_MAX = 16 * 1024 * 1024

interface SendCtx {
  freeForm: boolean
  category: 'service' | 'authentication' | 'utility' | 'marketing'
}

export class SandboxWorld implements LinkedWorld {
  business = { ...BUSINESS, oba: true, displayName: BUSINESS.verifiedName, webhookUrl: '' }
  personas = new Map<string, Persona>()
  private byPn = new Map<string, Persona>()
  private byBsuid = new Map<string, Persona>()
  private byLid = new Map<string, Persona>()
  dms = new Map<string, DmMessage[]>()
  windows = new Map<string, number>()
  apiGroups = new Map<string, ApiGroup>()
  media = new Map<string, SandboxMedia>()
  /** When the business last showed "typing…" to each persona (cleared by its next message). */
  typing = new Map<string, number>()
  linked = new Map<string, LinkedGroup>()
  templates: TemplateState[] = []
  device: { state: LinkedDeviceState; qr?: string; since: number } = { state: 'unlinked', since: Date.now() }
  private knownMappings = new Set<string>()
  private delivered = new Set<string>()
  autoRead = true
  faults: Faults = { duplicateRate: 0, outOfOrder: false }
  socket: FakeSocket
  dispatcher: WebhookDispatcher
  private rand = mulberry32(7)
  private qrTimer: NodeJS.Timeout | null = null

  constructor(
    private bus: Bus,
    webhookUrl: string,
  ) {
    this.business.webhookUrl = webhookUrl
    this.socket = new FakeSocket(this)
    this.dispatcher = new WebhookDispatcher(bus, () => this.business, this.faults)
    this.seed()
  }

  private seed() {
    for (const p of [...NAMED_PERSONAS, ...HYKR_PERSONAS, MEMBER_PERSONA, ...SYNTHETIC_PERSONAS]) {
      this.personas.set(p.id, p)
      this.byPn.set(p.pn, p)
      this.byBsuid.set(p.bsuid, p)
      this.byLid.set(p.lid, p)
    }
    this.templates = TEMPLATES.map((t, i) => ({
      id: String(900000000000001 + i),
      name: t.name,
      language: t.language,
      category: t.category,
      status: 'APPROVED',
      body: t.body,
      footer: t.footer,
      buttons: t.buttons ?? [],
    }))
    const t0 = Date.now() - 30 * DAY
    for (const s of LINKED_GROUPS) {
      this.linked.set(s.jid, {
        jid: s.jid,
        subject: s.subject,
        desc: s.desc,
        kind: s.kind,
        parent: s.parent,
        announce: s.announce,
        admins: s.admins,
        members: s.members,
        creation: t0,
        memberJoinedAt: s.memberJoined ? t0 : null,
        messages: [],
      })
    }
  }

  reset() {
    this.dms.clear()
    this.media.clear()
    this.windows.clear()
    this.apiGroups.clear()
    this.linked.clear()
    this.knownMappings.clear()
    this.delivered.clear()
    this.business.oba = true
    this.faults.duplicateRate = 0
    this.faults.outOfOrder = false
    const wasOpen = this.device.state === 'open'
    this.seed()
    if (wasOpen) this.socket.close(401, 'Sandbox reset: device logged out')
    this.device = { state: 'unlinked', since: Date.now() }
    this.changed()
  }

  // ---------------------------------------------------------------- lookups

  persona(id: string) {
    return this.personas.get(id)
  }
  personaByLid(lid: string) {
    return this.byLid.get(lid)
  }
  linkedGroup(jid: string) {
    return this.linked.get(jid)
  }
  linkedGroups() {
    return [...this.linked.values()]
  }
  knownPnForLid(lid: string): string | null {
    const p = this.byLid.get(lid)
    if (!p) return null
    return p.pnInGroups || this.knownMappings.has(lid) ? p.pn : null
  }

  private changed(personaId?: string) {
    this.bus.change('sandbox', { personaId })
  }

  private windowOpen(personaId: string) {
    const t = this.windows.get(personaId)
    return t !== undefined && Date.now() - t < DAY
  }

  // ---------------------------------------------------------------- webhook value builders

  private metadata() {
    return { display_phone_number: this.business.displayPhone, phone_number_id: this.business.phoneNumberId }
  }

  private contact(p: Persona) {
    return { profile: { name: p.name }, ...(p.hiddenNumber ? {} : { wa_id: p.pn }), user_id: p.bsuid }
  }

  private inbound(p: Persona, message: Record<string, unknown>, groupId?: string) {
    this.dispatcher.enqueue('messages', {
      messaging_product: 'whatsapp',
      metadata: this.metadata(),
      contacts: [this.contact(p)],
      messages: [
        {
          ...(p.hiddenNumber ? {} : { from: p.pn }),
          from_user_id: p.bsuid,
          ...(groupId ? { group_id: groupId } : {}),
          id: message.id,
          timestamp: unix(),
          ...message,
        },
      ],
    })
  }

  private status(
    id: string,
    status: Status,
    recipient: { persona?: Persona; to: string; groupId?: string; participant?: Persona },
    ctx: SendCtx,
    delayMs: number,
    error?: { code: number; title: string; details: string },
  ) {
    const billable = status !== 'failed' && ctx.category !== 'service' && !(ctx.category === 'utility' && recipient.persona && this.windowOpen(recipient.persona.id))
    const jitter = this.faults.outOfOrder ? Math.random() * 1500 : 0
    const p = recipient.persona
    this.dispatcher.enqueue(
      'messages',
      {
        messaging_product: 'whatsapp',
        metadata: this.metadata(),
        statuses: [
          {
            id,
            status,
            timestamp: unix(),
            ...(recipient.groupId
              ? {
                  recipient_id: recipient.groupId,
                  recipient_type: 'group',
                  ...(recipient.participant
                    ? {
                        ...(recipient.participant.hiddenNumber ? {} : { recipient_participant_id: recipient.participant.pn }),
                        recipient_participant_user_id: recipient.participant.bsuid,
                      }
                    : {}),
                }
              : {
                  ...(p && !p.hiddenNumber ? { recipient_id: p.pn } : p ? {} : { recipient_id: recipient.to }),
                  ...(p ? { recipient_user_id: p.bsuid } : {}),
                }),
            ...(status === 'failed'
              ? { errors: [{ code: error!.code, title: error!.title, message: error!.title, error_data: { details: error!.details } }] }
              : {
                  pricing: {
                    billable,
                    pricing_model: 'PMP',
                    category: recipient.groupId ? `group_${ctx.category === 'service' ? 'service' : ctx.category}` : ctx.category,
                    type: billable ? 'regular' : 'free_customer_service',
                  },
                }),
          },
        ],
      },
      delayMs + jitter,
    )
  }

  // ---------------------------------------------------------------- Graph: messages

  private resolveRecipient(to: string): Persona | undefined {
    const clean = to.replace(/[^\dA-Za-z.]/g, '')
    return this.byPn.get(clean.replace(/\D/g, '')) ?? this.byBsuid.get(to.trim())
  }

  private template(name: string, lang: string) {
    return this.templates.find((t) => t.name === name && t.language === lang)
  }

  graphSendMessage(phoneNumberId: string, body: any): GraphResult {
    if (phoneNumberId !== this.business.phoneNumberId) return noObject(phoneNumberId)
    if (body?.messaging_product !== 'whatsapp') return graphError(400, 100, '(#100) The parameter messaging_product is required.')
    // Read receipt (+ typing indicator) for a message the persona sent.
    if (body.status === 'read') {
      if (!body.message_id) return graphError(400, 100, '(#100) The parameter message_id is required.')
      const owner = [...this.dms.values()].flat().find((m) => m.id === body.message_id && m.from === 'persona')
      if (!owner) return graphError(400, 100, '(#100) Invalid parameter', { details: 'message_id must be a message the user sent you' })
      owner.readByBusiness = true
      if (body.typing_indicator) this.typing.set(owner.personaId, Date.now())
      this.changed(owner.personaId)
      return { status: 200, body: { success: true } }
    }
    if (body.recipient_type === 'group') return this.graphSendGroup(body)
    const to = String(body.to ?? body.recipient ?? '')
    if (!to) return graphError(400, 100, '(#100) The parameter to is required.')
    if (this.linked.has(to) || /@g\.us$/.test(to)) return noObject(to)
    const type = body.type ?? 'text'
    const built = this.buildOutbound(type, body)
    if ('status' in built) return built
    const p = this.resolveRecipient(to)
    const id = wamid()
    const ctx: SendCtx = built.ctx
    const recipient = { persona: p, to }
    if (!p) {
      this.status(id, 'failed', recipient, ctx, 300, {
        code: 131026,
        title: 'Message undeliverable',
        details: 'Unable to deliver message. The recipient may not be a WhatsApp user (sandbox: no persona with this number).',
      })
    } else if (ctx.freeForm && !this.windowOpen(p.id)) {
      this.status(id, 'failed', recipient, ctx, 300, {
        code: 131047,
        title: 'Re-engagement message',
        details: 'Message failed to send because more than 24 hours have passed since the customer last replied to this number.',
      })
    } else {
      const msg: DmMessage = { ...built.msg, id, personaId: p.id, from: 'business', at: Date.now(), status: 'accepted', pricing: built.pricing }
      this.typing.delete(p.id)
      if (!this.dms.has(p.id)) this.dms.set(p.id, [])
      this.dms.get(p.id)!.push(msg)
      this.progress(msg, recipient, ctx)
      this.changed(p.id)
    }
    return {
      status: 200,
      body: {
        messaging_product: 'whatsapp',
        contacts: [{ input: to, ...(p && !p.hiddenNumber ? { wa_id: p.pn } : {}) }],
        messages: [{ id, ...(type === 'template' ? { message_status: 'accepted' } : {}) }],
      },
    }
  }

  private progress(msg: DmMessage, recipient: { persona?: Persona; to: string; groupId?: string }, ctx: SendCtx) {
    const set = (s: Status) => () => {
      if (msg.status !== 'read') msg.status = s
      this.changed(recipient.persona?.id)
    }
    this.status(msg.id, 'sent', recipient, ctx, 150)
    setTimeout(set('sent'), 150)
    this.status(msg.id, 'delivered', recipient, ctx, 450)
    setTimeout(set('delivered'), 450)
    if (this.autoRead) {
      this.status(msg.id, 'read', recipient, ctx, 1300)
      setTimeout(set('read'), 1300)
    }
  }

  private buildOutbound(type: string, body: any): { msg: Omit<DmMessage, 'id' | 'personaId' | 'from' | 'at'>; ctx: SendCtx; pricing: string } | GraphResult {
    if (type === 'text') {
      const text = body.text?.body
      if (typeof text !== 'string' || !text) return graphError(400, 100, "(#100) Param text['body'] is required.")
      if (text.length > 4096) return graphError(400, 100, '(#100) Param text[body] must be at most 4096 characters long.')
      return { msg: { kind: 'text', text }, ctx: { freeForm: true, category: 'service' }, pricing: 'service · free in window' }
    }
    if (type === 'interactive') {
      const it = body.interactive
      const text = it?.body?.text
      if (!text) return graphError(400, 131009, '(#131009) Parameter value is not valid', { details: 'interactive.body.text is required' })
      if (it.type === 'button') {
        const buttons = it.action?.buttons ?? []
        if (!buttons.length || buttons.length > 3) return graphError(400, 131009, '(#131009) Parameter value is not valid', { details: 'Buttons count should be between 1 and 3' })
        for (const b of buttons) {
          if (!b.reply?.id || !b.reply?.title) return graphError(400, 131009, '(#131009) Parameter value is not valid', { details: 'Each button needs reply.id and reply.title' })
          if (b.reply.title.length > 20) return graphError(400, 131009, '(#131009) Parameter value is not valid', { details: 'Button title length is too long. Max length is 20' })
        }
        return {
          msg: {
            kind: 'interactive',
            text,
            header: it.header?.text,
            footer: it.footer?.text,
            buttons: buttons.map((b: any): Button => ({ id: b.reply.id, title: b.reply.title, kind: 'reply' })),
          },
          ctx: { freeForm: true, category: 'service' },
          pricing: 'service · free in window',
        }
      }
      if (it.type === 'list') {
        const sections = it.action?.sections ?? []
        const rows = sections.flatMap((s: any) => s.rows ?? [])
        if (!it.action?.button || it.action.button.length > 20) return graphError(400, 131009, '(#131009) Parameter value is not valid', { details: 'action.button is required (max 20 chars)' })
        if (!rows.length || rows.length > 10) return graphError(400, 131009, '(#131009) Parameter value is not valid', { details: 'Total row count must be between 1 and 10' })
        for (const r of rows) {
          if (!r.id || !r.title || r.title.length > 24) return graphError(400, 131009, '(#131009) Parameter value is not valid', { details: 'Row title is required and max 24 chars' })
          if (r.description && r.description.length > 72) return graphError(400, 131009, '(#131009) Parameter value is not valid', { details: 'Row description max 72 chars' })
        }
        return {
          msg: {
            kind: 'interactive',
            text,
            header: it.header?.text,
            footer: it.footer?.text,
            list: {
              button: it.action.button,
              sections: sections.map((s: any) => ({ title: s.title, rows: (s.rows ?? []).map((r: any): ListRow => ({ id: r.id, title: r.title, description: r.description })) })),
            },
          },
          ctx: { freeForm: true, category: 'service' },
          pricing: 'service · free in window',
        }
      }
      return graphError(400, 131009, '(#131009) Parameter value is not valid', { details: `Sandbox supports interactive types button and list (got ${it?.type})` })
    }
    if (type === 'template') {
      const name = body.template?.name
      const lang = body.template?.language?.code
      const t = name && lang ? this.template(name, lang) : undefined
      if (!t || t.status !== 'APPROVED') {
        return graphError(404, 132001, '(#132001) Template name does not exist in the translation', {
          details: `template name (${name}) does not exist in ${lang}${t ? ` (status ${t.status})` : ''}`,
        })
      }
      const comps: any[] = body.template.components ?? []
      const bodyParams = comps.find((c) => c.type === 'body')?.parameters ?? []
      const expected = (t.body.match(/\{\{\d+\}\}/g) ?? []).length
      if (bodyParams.length !== expected) {
        return graphError(400, 132000, '(#132000) Number of parameters does not match the expected number of params', {
          details: `body: number of localizable_params (${bodyParams.length}) does not match the expected number of params (${expected})`,
        })
      }
      let inviteCode: string | undefined
      const values = bodyParams.map((prm: any) => {
        if (prm.type === 'group_id') {
          const g = this.apiGroups.get(prm.group_id)
          inviteCode = g?.inviteCode
          return g ? `https://chat.whatsapp.com/${g.inviteCode}` : '(unknown group)'
        }
        return String(prm.text ?? '')
      })
      const text = t.body.replace(/\{\{(\d+)\}\}/g, (_, n) => values[Number(n) - 1] ?? '')
      const buttonParam = comps.find((c) => c.type === 'button')?.parameters?.[0]?.text
      const buttons: Button[] = t.buttons.map((b, i) => {
        if (b.type === 'OTP') return { id: `otp_${i}`, title: b.text, kind: 'copy_code', value: buttonParam ?? values[0] }
        if (b.type === 'GROUP_INVITE') return { id: `join_${i}`, title: b.text, kind: 'join_group', value: inviteCode }
        if (b.type === 'URL') return { id: `url_${i}`, title: b.text, kind: 'url' }
        return { id: `qr_${i}`, title: b.text, kind: 'quick_reply' }
      })
      const category = t.category.toLowerCase() as SendCtx['category']
      return {
        msg: { kind: 'template', text, footer: t.footer, buttons, templateName: t.name },
        ctx: { freeForm: false, category },
        pricing: category === 'utility' ? 'utility · free inside service window, else billed' : `${category} · billed`,
      }
    }
    if (type === 'audio') {
      const a = body.audio
      if (!a?.id && !a?.link) return graphError(400, 100, "(#100) Param audio['id'] or audio['link'] is required.")
      if (!a.id) return graphError(400, 131051, '(#131051) Unsupported message type', { details: 'Sandbox only sends audio by uploaded media id, not by link' })
      const m = this.media.get(String(a.id))
      if (!m) return graphError(400, 131053, '(#131053) Media upload error', { details: `Media id ${a.id} not found (upload it with POST /{phone-number-id}/media first)` })
      const info = inspectOggOpus(m.bytes)
      // Like WhatsApp: voice: true only shows as a voice note for mono Ogg/Opus; otherwise it arrives as a plain audio file.
      const voice = a.voice === true && info?.channels === 1
      return {
        msg: { kind: 'audio', text: '', audio: { mediaId: m.id, voice, seconds: info ? Math.round(info.durationSec * 10) / 10 : null } },
        ctx: { freeForm: true, category: 'service' },
        pricing: 'service · free in window',
      }
    }
    return graphError(400, 131051, '(#131051) Unsupported message type', { details: `Sandbox does not simulate type "${type}" (images, documents, location and reactions are out of scope)` })
  }

  private graphSendGroup(body: any): GraphResult {
    const to = String(body.to ?? '')
    const g = this.apiGroups.get(to)
    if (!g) return noObject(to) // app-created groups and Communities are not addressable by the Cloud API
    const type = body.type ?? 'text'
    if (type === 'interactive') {
      return graphError(400, 131009, '(#131009) Parameter value is not valid', { details: 'Interactive messages are not supported in groups (sandbox wording)' })
    }
    const built = this.buildOutbound(type, body)
    if ('status' in built) return built
    const id = wamid()
    const windowOpen = g.lastInboundAt !== null && Date.now() - g.lastInboundAt < DAY
    const ctx = built.ctx
    if (ctx.freeForm && !windowOpen) {
      this.status(id, 'failed', { to, groupId: g.id }, ctx, 300, {
        code: 131047,
        title: 'Re-engagement message',
        details: 'More than 24 hours have passed since a participant last messaged this group.',
      })
    } else {
      const msg: DmMessage = { ...built.msg, id, personaId: 'business', from: 'business', at: Date.now(), status: 'sent', pricing: built.pricing }
      g.messages.push(msg)
      this.status(id, 'sent', { to, groupId: g.id }, ctx, 150)
      g.participants.forEach((pid, i) => {
        this.status(id, 'delivered', { to, groupId: g.id, participant: this.personas.get(pid) }, ctx, 450 + i * 40)
      })
      setTimeout(() => {
        msg.status = 'delivered'
        this.changed()
      }, 500)
      this.changed()
    }
    return { status: 200, body: { messaging_product: 'whatsapp', contacts: [{ input: to }], messages: [{ id }] } }
  }

  // ---------------------------------------------------------------- Graph: groups

  graphCreateGroup(phoneNumberId: string, body: any): GraphResult {
    if (phoneNumberId !== this.business.phoneNumberId) return noObject(phoneNumberId)
    const subject = body?.subject
    if (typeof subject !== 'string' || !subject.trim()) return graphError(400, 100, '(#100) The parameter subject is required.')
    if (subject.length > 128) return graphError(400, 100, '(#100) Param subject must be at most 128 characters long.')
    if (body.description && String(body.description).length > 2048) return graphError(400, 100, '(#100) Param description must be at most 2048 characters long.')
    const requestId = uid('req')
    const joinApprovalMode = body.join_approval_mode ?? 'auto_approve'
    setTimeout(() => {
      if (!this.business.oba) {
        this.dispatcher.enqueue('group_lifecycle_update', {
          messaging_product: 'whatsapp',
          metadata: this.metadata(),
          groups: [
            {
              timestamp: unix(),
              type: 'group_create',
              request_id: requestId,
              errors: [
                {
                  code: 131215,
                  title: 'Groups API not available for this business (sandbox code)',
                  message: 'Groups API requires an Official Business Account (blue tick) on a Cloud API number.',
                },
              ],
            },
          ],
        })
        return
      }
      const id = digits(this.rand, 16)
      const g: ApiGroup = {
        id,
        subject,
        description: body.description,
        inviteCode: randomBytes(16).toString('base64url').slice(0, 22),
        participants: [],
        createdAt: Date.now(),
        requestId,
        joinApprovalMode,
        rejected: [],
        messages: [],
        lastInboundAt: null,
      }
      this.apiGroups.set(id, g)
      this.dispatcher.enqueue('group_lifecycle_update', {
        messaging_product: 'whatsapp',
        metadata: this.metadata(),
        groups: [
          {
            timestamp: unix(),
            group_id: id,
            type: 'group_create',
            request_id: requestId,
            subject,
            invite_link: `https://chat.whatsapp.com/${g.inviteCode}`,
            join_approval_mode: joinApprovalMode,
          },
        ],
      })
      this.changed()
    }, 400)
    // Sync response body is not documented; the result arrives via the lifecycle webhook.
    return { status: 200, body: { messaging_product: 'whatsapp', request_id: requestId } }
  }

  graphListGroups(phoneNumberId: string): GraphResult {
    if (phoneNumberId !== this.business.phoneNumberId) return noObject(phoneNumberId)
    return {
      status: 200,
      body: { data: [...this.apiGroups.values()].map((g) => ({ id: g.id, subject: g.subject, created_at: unix(g.createdAt) })), paging: {} },
    }
  }

  graphGetObject(id: string, fields: string[]): GraphResult {
    if (id === this.business.phoneNumberId) {
      return {
        status: 200,
        body: {
          id,
          display_phone_number: this.business.displayPhone,
          verified_name: this.business.verifiedName,
          quality_rating: 'GREEN',
          is_official_business_account: this.business.oba,
          code_verification_status: 'VERIFIED',
          platform_type: 'CLOUD_API',
        },
      }
    }
    const g = this.apiGroups.get(id)
    if (!g) return noObject(id) // includes Community and app-created group ids: no API exists for them
    const all: Record<string, unknown> = {
      id: g.id,
      subject: g.subject,
      description: g.description,
      join_approval_mode: g.joinApprovalMode,
      total_participant_count: g.participants.length,
      participants: g.participants.map((pid) => {
        const p = this.personas.get(pid)!
        return { ...(p.hiddenNumber ? {} : { wa_id: p.pn }), user_id: p.bsuid }
      }),
    }
    const want = fields.length ? fields : ['id', 'subject']
    return { status: 200, body: Object.fromEntries(Object.entries(all).filter(([k]) => k === 'id' || want.includes(k))) }
  }

  graphInviteLink(groupId: string): GraphResult {
    const g = this.apiGroups.get(groupId)
    if (!g) return noObject(groupId)
    return { status: 200, body: { messaging_product: 'whatsapp', invite_link: `https://chat.whatsapp.com/${g.inviteCode}` } }
  }

  graphRemoveParticipants(groupId: string, body: any): GraphResult {
    const g = this.apiGroups.get(groupId)
    if (!g) return noObject(groupId)
    const list: any[] = body?.participants ?? []
    if (!list.length) return graphError(400, 100, '(#100) participants must be a non-empty array.')
    if (list.length > 8) return graphError(400, 100, '(#100) A maximum of 8 participants can be removed per request.')
    const removed: Persona[] = []
    for (const item of list) {
      const p = item.user ? this.resolveRecipient(String(item.user)) : this.byBsuid.get(String(item.user_id))
      if (p && g.participants.includes(p.id)) {
        g.participants = g.participants.filter((x) => x !== p.id)
        removed.push(p)
      }
    }
    if (removed.length) {
      this.dispatcher.enqueue('group_participants_update', {
        messaging_product: 'whatsapp',
        metadata: this.metadata(),
        groups: [
          {
            timestamp: unix(),
            group_id: g.id,
            type: 'group_participants_remove',
            initiated_by: 'business',
            removed_participants: removed.map((p) => ({ ...(p.hiddenNumber ? {} : { wa_id: p.pn }), user_id: p.bsuid })),
          },
        ],
      })
    }
    this.changed()
    return { status: 200, body: { success: true } }
  }

  // ---------------------------------------------------------------- Graph: templates

  graphListTemplates(wabaId: string): GraphResult {
    if (wabaId !== this.business.wabaId) return noObject(wabaId)
    return {
      status: 200,
      body: {
        data: this.templates.map((t) => ({
          id: t.id,
          name: t.name,
          language: t.language,
          status: t.status,
          category: t.category,
          components: [
            { type: 'BODY', text: t.body },
            ...(t.footer ? [{ type: 'FOOTER', text: t.footer }] : []),
            ...(t.buttons.length ? [{ type: 'BUTTONS', buttons: t.buttons }] : []),
          ],
        })),
        paging: {},
      },
    }
  }

  graphCreateTemplate(wabaId: string, body: any): GraphResult {
    if (wabaId !== this.business.wabaId) return noObject(wabaId)
    const name = String(body?.name ?? '')
    if (!/^[a-z0-9_]{1,512}$/.test(name)) return graphError(400, 100, '(#100) Template name can only contain lowercase letters, numbers and underscores.')
    const language = String(body?.language ?? 'en_US')
    if (this.template(name, language)) return graphError(400, 192, '(#192) Message template already exists in this language', { type: 'OAuthException' })
    const category = String(body?.category ?? 'UTILITY').toUpperCase() as TemplateState['category']
    const comps: any[] = body?.components ?? []
    const bodyText = comps.find((c) => c.type === 'BODY')?.text
    if (!bodyText) return graphError(400, 100, '(#100) A BODY component is required.')
    const t: TemplateState = {
      id: digits(this.rand, 15),
      name,
      language,
      category,
      status: 'PENDING',
      body: bodyText,
      footer: comps.find((c) => c.type === 'FOOTER')?.text,
      buttons: comps.find((c) => c.type === 'BUTTONS')?.buttons ?? [],
    }
    this.templates.push(t)
    setTimeout(() => {
      t.status = 'APPROVED'
      this.dispatcher.enqueue('message_template_status_update', {
        event: 'APPROVED',
        message_template_id: Number(t.id),
        message_template_name: t.name,
        message_template_language: t.language,
        reason: 'NONE',
      })
      this.changed()
    }, 2500)
    return { status: 200, body: { id: t.id, status: 'PENDING', category } }
  }

  // ---------------------------------------------------------------- Graph: media

  private newMediaId() {
    let id = ''
    do id = String(1_000_000_000_000_000 + Math.floor(Math.random() * 8_999_999_999_999_999))
    while (this.media.has(id))
    return id
  }

  private storeMedia(bytes: Buffer, mime: string, script?: SandboxMedia['script']): SandboxMedia {
    const m: SandboxMedia = { id: this.newMediaId(), bytes, mime, sha256: createHash('sha256').update(bytes).digest('base64'), at: Date.now(), script }
    this.media.set(m.id, m)
    return m
  }

  /** POST /{phone-number-id}/media */
  graphUploadMedia(phoneNumberId: string, upload: { messagingProduct: string | null; type: string | null; bytes: Buffer | null; fileType: string | null }): GraphResult {
    if (phoneNumberId !== this.business.phoneNumberId) return noObject(phoneNumberId)
    if (upload.messagingProduct !== 'whatsapp') return graphError(400, 100, '(#100) The parameter messaging_product is required.')
    if (!upload.bytes?.length) return graphError(400, 100, '(#100) The parameter file is required.')
    const mime = (upload.type || upload.fileType || '').split(';')[0].trim()
    if (!AUDIO_TYPES.includes(mime)) return graphError(400, 131053, '(#131053) Media upload error', { details: `Sandbox accepts audio only (${AUDIO_TYPES.join(', ')}); got "${mime || 'no type'}"` })
    if (upload.bytes.length > MEDIA_MAX) return graphError(400, 131053, '(#131053) Media upload error', { details: 'Audio is over the 16 MB limit' })
    if (mime === 'audio/ogg' && !inspectOggOpus(upload.bytes)) return graphError(400, 131053, '(#131053) Media upload error', { details: 'audio/ogg must be encoded with the Opus codec' })
    return { status: 200, body: { id: this.storeMedia(upload.bytes, mime).id } }
  }

  /** GET /{media-id}: the download URL is only reachable with the access token, like Meta's. */
  graphMediaInfo(id: string, downloadBase: string): GraphResult | null {
    const m = this.media.get(id)
    if (!m) return null
    return {
      status: 200,
      body: { messaging_product: 'whatsapp', url: `${downloadBase}/_media/${m.id}`, mime_type: m.mime, sha256: m.sha256, file_size: m.bytes.length, id: m.id },
    }
  }

  mediaBytes(id: string) {
    return this.media.get(id)
  }

  mediaScript(id: string) {
    return this.media.get(id)?.script
  }

  /** A persona records a voice note in their 1:1 chat with the business. `bytes` is mono Ogg/Opus. */
  personaVoice(personaId: string, chatId: string, bytes: Buffer, script: { text: string; lang: string }): { ok: boolean; error?: string } {
    const p = this.personas.get(personaId)
    if (!p) return { ok: false, error: 'unknown persona' }
    if (chatId !== 'dm') return { ok: false, error: 'The sandbox simulates voice notes in the chat with the business only' }
    if (!script.text.trim()) return { ok: false, error: 'say something' }
    const m = this.storeMedia(bytes, 'audio/ogg; codecs=opus', { text: script.text.trim(), lang: script.lang })
    const info = inspectOggOpus(bytes)
    const id = wamid()
    if (!this.dms.has(p.id)) this.dms.set(p.id, [])
    this.dms.get(p.id)!.push({
      id,
      personaId: p.id,
      from: 'persona',
      at: Date.now(),
      kind: 'audio',
      text: '',
      spoken: script.text.trim(),
      audio: { mediaId: m.id, voice: true, seconds: info ? Math.round(info.durationSec * 10) / 10 : null },
    })
    this.windows.set(p.id, Date.now())
    this.inbound(p, { id, type: 'audio', audio: { mime_type: m.mime, sha256: m.sha256, id: m.id, voice: true } })
    this.changed(p.id)
    return { ok: true }
  }

  /** A persona sends a photo (a synthetic fixture) in their chat with the business. */
  personaImage(personaId: string, file: { name: string; bytes: Buffer; mime: string; doc?: { kind: string; fields: Record<string, string> } }, caption?: string): { ok: boolean; error?: string } {
    const p = this.personas.get(personaId)
    if (!p) return { ok: false, error: 'unknown persona' }
    const m = this.storeMedia(file.bytes, file.mime, file.doc ? { doc: file.doc } : undefined)
    const id = wamid()
    this.pushPersona(p, { id, personaId: p.id, from: 'persona', at: Date.now(), kind: 'image', text: caption ?? '', image: { mediaId: m.id, file: file.name, caption } })
    this.inbound(p, { id, type: 'image', image: { mime_type: file.mime, sha256: m.sha256, id: m.id, ...(caption ? { caption } : {}) } })
    return { ok: true }
  }

  personaLocation(personaId: string, loc: { lat: number; lng: number; name?: string; address?: string }): { ok: boolean; error?: string } {
    const p = this.personas.get(personaId)
    if (!p) return { ok: false, error: 'unknown persona' }
    const id = wamid()
    this.pushPersona(p, { id, personaId: p.id, from: 'persona', at: Date.now(), kind: 'location', text: loc.name ?? 'Location', location: { lat: loc.lat, lng: loc.lng, name: loc.name } })
    this.inbound(p, { id, type: 'location', location: { latitude: loc.lat, longitude: loc.lng, ...(loc.name ? { name: loc.name } : {}), ...(loc.address ? { address: loc.address } : {}) } })
    return { ok: true }
  }

  personaContact(personaId: string, contact: { name: string; phone: string }): { ok: boolean; error?: string } {
    const p = this.personas.get(personaId)
    if (!p) return { ok: false, error: 'unknown persona' }
    const id = wamid()
    const digitsOnly = contact.phone.replace(/\D/g, '')
    this.pushPersona(p, { id, personaId: p.id, from: 'persona', at: Date.now(), kind: 'contacts', text: contact.name, contact })
    this.inbound(p, { id, type: 'contacts', contacts: [{ name: { formatted_name: contact.name }, phones: [{ phone: `+${digitsOnly}`, wa_id: digitsOnly, type: 'CELL' }] }] })
    return { ok: true }
  }

  private pushPersona(p: Persona, msg: DmMessage) {
    if (!this.dms.has(p.id)) this.dms.set(p.id, [])
    this.dms.get(p.id)!.push(msg)
    this.windows.set(p.id, Date.now())
    this.typing.delete(p.id)
    this.changed(p.id)
  }

  // ---------------------------------------------------------------- persona actions (Cloud lane)

  personaSend(personaId: string, chatId: string, text: string): { ok: boolean; error?: string } {
    const p = this.personas.get(personaId)
    if (!p) return { ok: false, error: 'unknown persona' }
    if (!text.trim()) return { ok: false, error: 'empty message' }
    if (chatId === 'dm') {
      const id = wamid()
      if (!this.dms.has(p.id)) this.dms.set(p.id, [])
      this.dms.get(p.id)!.push({ id, personaId: p.id, from: 'persona', at: Date.now(), kind: 'text', text })
      this.windows.set(p.id, Date.now())
      this.inbound(p, { id, type: 'text', text: { body: text } })
      this.changed(p.id)
      return { ok: true }
    }
    const g = this.apiGroups.get(chatId)
    if (g) {
      if (!g.participants.includes(p.id)) return { ok: false, error: 'not a participant' }
      const id = wamid()
      g.messages.push({ id, personaId: p.id, from: 'persona', at: Date.now(), kind: 'text', text })
      g.lastInboundAt = Date.now()
      this.inbound(p, { id, type: 'text', text: { body: text } }, g.id)
      this.changed(p.id)
      return { ok: true }
    }
    return this.personaLinked(personaId, chatId, 'text', text)
  }

  personaTap(personaId: string, chatId: string, messageId: string, buttonId: string): { ok: boolean; error?: string; copied?: string; joined?: string } {
    const p = this.personas.get(personaId)
    if (!p) return { ok: false, error: 'unknown persona' }
    const list = chatId === 'dm' ? this.dms.get(p.id) ?? [] : this.apiGroups.get(chatId)?.messages ?? []
    const msg = list.find((m) => m.id === messageId)
    if (!msg) return { ok: false, error: 'message not found' }
    const button = msg.buttons?.find((b) => b.id === buttonId)
    const row = msg.list?.sections.flatMap((s) => s.rows).find((r) => r.id === buttonId)
    if (button?.kind === 'copy_code') return { ok: true, copied: button.value }
    if (button?.kind === 'join_group') {
      const r = this.personaJoin(p.id, button.value ?? '')
      return r.ok ? { ok: true, joined: r.groupId } : { ok: false, error: r.error }
    }
    if (button?.kind === 'url') return { ok: true }
    if (!button && !row) return { ok: false, error: 'button not found' }
    const id = wamid()
    const context = { from: this.business.displayPhone, id: msg.id }
    let message: Record<string, unknown>
    let echo: string
    if (row) {
      message = { id, type: 'interactive', context, interactive: { type: 'list_reply', list_reply: { id: row.id, title: row.title, description: row.description } } }
      echo = row.title
    } else if (button!.kind === 'reply') {
      message = { id, type: 'interactive', context, interactive: { type: 'button_reply', button_reply: { id: button!.id, title: button!.title } } }
      echo = button!.title
    } else {
      message = { id, type: 'button', context, button: { payload: button!.title, text: button!.title } }
      echo = button!.title
    }
    msg.tapped = buttonId
    if (!this.dms.has(p.id)) this.dms.set(p.id, [])
    this.dms.get(p.id)!.push({ id, personaId: p.id, from: 'persona', at: Date.now(), kind: 'reply', text: echo, contextId: msg.id })
    this.windows.set(p.id, Date.now())
    this.inbound(p, message)
    this.changed(p.id)
    return { ok: true }
  }

  personaJoin(personaId: string, codeOrLink: string): { ok: boolean; error?: string; groupId?: string } {
    const p = this.personas.get(personaId)
    if (!p) return { ok: false, error: 'unknown persona' }
    const code = codeOrLink.trim().split('/').pop() ?? ''
    const g = [...this.apiGroups.values()].find((x) => x.inviteCode === code)
    if (!g) return { ok: false, error: 'Invite link is invalid or was reset' }
    if (g.participants.includes(p.id)) return { ok: true, groupId: g.id }
    if (g.participants.length + 1 >= GROUP_CAP) {
      const reason = `Group is full: Groups API caps groups at ${GROUP_CAP} participants including the business number.`
      g.rejected.push({ personaId: p.id, at: Date.now(), reason })
      this.bus.log({ kind: 'sandbox', lane: 'A', title: `${p.name} could not join "${g.subject}"`, detail: reason })
      this.changed(p.id)
      return { ok: false, error: reason }
    }
    g.participants.push(p.id)
    this.dispatcher.enqueue('group_participants_update', {
      messaging_product: 'whatsapp',
      metadata: this.metadata(),
      groups: [
        {
          timestamp: unix(),
          group_id: g.id,
          type: 'group_participants_add',
          reason: 'invite_link',
          added_participants: [{ ...(p.hiddenNumber ? {} : { wa_id: p.pn }), user_id: p.bsuid }],
        },
      ],
    })
    this.changed(p.id)
    return { ok: true, groupId: g.id }
  }

  personaLeave(personaId: string, groupId: string): { ok: boolean; error?: string } {
    const p = this.personas.get(personaId)
    const g = this.apiGroups.get(groupId)
    if (!p || !g || !g.participants.includes(p.id)) return { ok: false, error: 'not a participant' }
    g.participants = g.participants.filter((x) => x !== p.id)
    this.dispatcher.enqueue('group_participants_update', {
      messaging_product: 'whatsapp',
      metadata: this.metadata(),
      groups: [
        {
          timestamp: unix(),
          group_id: g.id,
          type: 'group_participants_remove',
          initiated_by: 'participant',
          removed_participants: [{ ...(p.hiddenNumber ? {} : { wa_id: p.pn }), user_id: p.bsuid }],
        },
      ],
    })
    this.changed(p.id)
    return { ok: true }
  }

  expireWindow(personaId: string) {
    this.windows.set(personaId, Date.now() - DAY - 60_000)
    this.bus.log({ kind: 'sandbox', lane: 'A', title: `Service window expired for ${this.personas.get(personaId)?.name}`, detail: 'Last inbound message moved to 24h+1m ago' })
    this.changed(personaId)
  }

  setOba(on: boolean) {
    this.business.oba = on
    this.bus.log({ kind: 'sandbox', lane: 'A', title: `Official Business Account ${on ? 'granted' : 'removed'}`, detail: 'Groups API requires OBA' })
    this.changed()
  }

  // ---------------------------------------------------------------- persona actions (linked lane)

  personaLinked(personaId: string, jid: string, kind: LinkedMsgKind, text: string, targetId?: string): { ok: boolean; error?: string; id?: string } {
    const p = this.personas.get(personaId)
    const g = this.linked.get(jid)
    if (!p || !g) return { ok: false, error: 'unknown persona or group' }
    if (g.kind === 'community') return { ok: false, error: 'A Community has no chat of its own; post in the announcement group or a sub-group.' }
    if (!g.members.includes(p.id)) return { ok: false, error: `${p.name} is not a member of ${g.subject}` }
    if (g.announce && !g.admins.includes(p.id) && !kind.startsWith('stub')) return { ok: false, error: 'Only admins can send messages to this group.' }
    if (['edit', 'revoke', 'reaction', 'reply'].includes(kind)) {
      const target = targetId ? g.messages.find((m) => m.id === targetId) : undefined
      if (!target) return { ok: false, error: 'target message not found' }
      if (kind === 'edit') {
        if (target.personaId !== p.id) return { ok: false, error: 'can only edit your own message' }
        target.editedText = text
      }
      if (kind === 'revoke') {
        if (target.personaId !== p.id && !g.admins.includes(p.id)) return { ok: false, error: 'can only delete your own message' }
        target.deleted = true
      }
      if (kind === 'reaction') target.reactions[p.id] = text
    }
    const m: LinkedMsg = { id: waWebId(), jid, personaId: p.id, at: Date.now(), kind, text, targetId, reactions: {} }
    g.messages.push(m)
    if (g.messages.length > 500) g.messages.splice(0, g.messages.length - 500)
    this.deliverLinked(g, m)
    this.changed(p.id)
    return { ok: true, id: m.id }
  }

  private deliverLinked(g: LinkedGroup, m: LinkedMsg) {
    if (this.device.state !== 'open') return
    if (g.memberJoinedAt === null || m.at < g.memberJoinedAt) return
    this.delivered.add(m.id)
    this.socket.upsert([this.socket.build(g, m)], 'notify')
  }

  memberJoin(jid: string): { ok: boolean; error?: string } {
    const g = this.linked.get(jid)
    const member = this.personas.get('member')!
    if (!g) return { ok: false, error: 'unknown group' }
    if (g.memberJoinedAt !== null) return { ok: true }
    g.memberJoinedAt = Date.now()
    if (!g.members.includes('member')) g.members.push('member')
    if (this.device.state === 'open') {
      this.socket.groupsUpsert(g)
      this.socket.participants(g, member, 'add')
    }
    this.bus.log({ kind: 'sandbox', lane: 'B', title: `Member number joined "${g.subject}"`, detail: 'It will only see messages sent from now on' })
    this.changed('member')
    return { ok: true }
  }

  revealLidMapping(personaId: string) {
    const p = this.personas.get(personaId)
    if (!p) return
    this.knownMappings.add(p.lid)
    if (this.device.state === 'open') this.socket.lidMapping(p)
    this.bus.log({ kind: 'sandbox', lane: 'B', title: `LID mapping revealed for ${p.name}`, detail: `${p.lid}@lid → ${p.pn}` })
  }

  // ---------------------------------------------------------------- linked device lifecycle

  /** Called by the agent's socket factory (connect / reconnect after 515). */
  onSocketConnect() {
    const s = this.device.state
    if (s === 'paired_restart' || s === 'open') {
      this.device = { state: 'open', since: Date.now() }
      setTimeout(() => {
        this.socket.connection({ connection: 'connecting' })
        this.socket.connection({ connection: 'open', isOnline: false, receivedPendingNotifications: true })
        // Offline/backlog messages arrive as a history sync (append), not live notifications.
        const backlog: ReturnType<FakeSocket['build']>[] = []
        for (const g of this.linked.values()) {
          if (g.memberJoinedAt === null) continue
          for (const m of g.messages) {
            if (m.at >= g.memberJoinedAt && !this.delivered.has(m.id)) {
              this.delivered.add(m.id)
              backlog.push(this.socket.build(g, m))
            }
          }
        }
        this.socket.history(backlog)
        this.changed('member')
      }, 50)
      return
    }
    this.device = { state: 'awaiting_scan', since: Date.now() }
    const emitQr = () => {
      this.device.qr = `2@${randomBytes(24).toString('base64')},${randomBytes(32).toString('base64')},sandbox`
      this.socket.connection({ connection: 'connecting', qr: this.device.qr })
      this.changed('member')
    }
    setTimeout(emitQr, 50)
    if (this.qrTimer) clearInterval(this.qrTimer)
    this.qrTimer = setInterval(() => {
      if (this.device.state !== 'awaiting_scan') return void (this.qrTimer && clearInterval(this.qrTimer))
      emitQr()
    }, 20_000)
  }

  onSocketEnd() {
    if (this.device.state === 'open' || this.device.state === 'awaiting_scan') {
      this.device = { state: 'unlinked', since: Date.now() }
      this.changed('member')
    }
  }

  /** The member phone "scans" the QR shown by the linked client. */
  scanQr(): { ok: boolean; error?: string } {
    if (this.device.state !== 'awaiting_scan') return { ok: false, error: 'No QR is being shown. Click Connect on the linked channel first.' }
    if (this.qrTimer) clearInterval(this.qrTimer)
    this.device = { state: 'paired_restart', since: Date.now() }
    this.bus.log({ kind: 'sandbox', lane: 'B', title: 'Member phone scanned the QR', detail: 'Server asks the client to restart (515) after pairing' })
    this.socket.connection({ connection: 'connecting', isNewLogin: true, qr: undefined })
    setTimeout(() => this.socket.close(515, 'Stream Errored (restart required)'), 80)
    this.changed('member')
    return { ok: true }
  }

  /** Simulates WhatsApp banning / logging out the member number. */
  ban(): { ok: boolean } {
    const was = this.device.state
    this.device = { state: 'logged_out', since: Date.now() }
    if (was === 'open' || was === 'awaiting_scan') this.socket.close(401, 'Connection Failure (logged out)')
    this.bus.log({ kind: 'sandbox', lane: 'B', title: 'Member number banned', detail: 'Linked device receives 401 loggedOut; do not auto-reconnect' })
    this.changed('member')
    return { ok: true }
  }

  // ---------------------------------------------------------------- views for the simulator UI

  personaView(personaId: string) {
    const p = this.personas.get(personaId)
    if (!p) return undefined
    const chats: any[] = [
      {
        id: 'dm',
        kind: 'dm',
        title: this.business.verifiedName,
        subtitle: `+${this.business.displayPhone} · official number`,
        windowOpen: this.windowOpen(p.id),
        windowLastInbound: this.windows.get(p.id) ?? null,
        // "typing…" lasts until the business replies, or about 25 seconds (as on WhatsApp).
        typing: this.typing.has(p.id) && Date.now() - this.typing.get(p.id)! < 25_000,
        messages: this.dms.get(p.id) ?? [],
      },
    ]
    for (const g of this.apiGroups.values()) {
      if (!g.participants.includes(p.id)) continue
      chats.push({
        id: g.id,
        kind: 'api_group',
        title: g.subject,
        subtitle: `Groups API · ${g.participants.length + 1}/${GROUP_CAP} incl. business`,
        messages: g.messages.map((m) => ({ ...m, senderName: m.from === 'business' ? this.business.verifiedName : this.personas.get(m.personaId)?.name })),
      })
    }
    for (const g of this.linked.values()) {
      if (!g.members.includes(p.id) || g.kind === 'community') continue
      chats.push({
        id: g.jid,
        kind: g.kind,
        title: g.subject,
        subtitle: `${g.members.length} members${g.announce ? ' · admins post only' : ''}${g.parent ? ` · in ${this.linked.get(g.parent)?.subject}` : ''}`,
        canPost: !g.announce || g.admins.includes(p.id),
        isAdmin: g.admins.includes(p.id),
        memberNumberJoined: g.memberJoinedAt !== null,
        messages: g.messages
          .filter((m) => ['text', 'reply', 'ephemeral', 'view_once', 'stub_add', 'stub_leave', 'ciphertext'].includes(m.kind))
          .slice(-150)
          .map((m) => ({
            id: m.id,
            kind: m.kind,
            personaId: m.personaId,
            senderName: this.personas.get(m.personaId)?.name,
            at: m.at,
            text: m.deleted ? 'This message was deleted' : (m.editedText ?? m.text),
            edited: !!m.editedText && !m.deleted,
            deleted: !!m.deleted,
            reactions: Object.values(m.reactions),
            targetId: m.targetId,
            quoted: m.targetId ? g.messages.find((x) => x.id === m.targetId)?.text : undefined,
          })),
      })
    }
    return { persona: p, chats, device: p.id === 'member' ? this.deviceView() : undefined }
  }

  deviceView() {
    return { state: this.device.state, qr: this.device.state === 'awaiting_scan' ? this.device.qr : undefined, since: this.device.since }
  }

  stateView() {
    const named = [...this.personas.values()].filter((p) => !p.synthetic)
    return {
      business: {
        name: this.business.verifiedName,
        displayPhone: this.business.displayPhone,
        phoneNumberId: this.business.phoneNumberId,
        wabaId: this.business.wabaId,
        oba: this.business.oba,
      },
      personas: named.map((p) => ({
        id: p.id,
        name: p.name,
        pn: p.pn,
        bsuid: p.bsuid,
        lid: p.lid,
        hiddenNumber: p.hiddenNumber,
        pnInGroups: p.pnInGroups,
        hue: p.hue,
        windowOpen: this.windowOpen(p.id),
        unread: (this.dms.get(p.id) ?? []).filter((m) => m.from === 'business').length,
      })),
      syntheticCount: [...this.personas.values()].filter((p) => p.synthetic).length,
      apiGroups: [...this.apiGroups.values()].map((g) => ({
        id: g.id,
        subject: g.subject,
        inviteLink: `https://chat.whatsapp.com/${g.inviteCode}`,
        participants: g.participants,
        rejected: g.rejected,
        cap: GROUP_CAP,
      })),
      linkedGroups: [...this.linked.values()].map((g) => ({
        jid: g.jid,
        subject: g.subject,
        kind: g.kind,
        parent: g.parent,
        members: g.members.length,
        memberJoined: g.memberJoinedAt !== null,
        announce: g.announce,
        admins: g.admins,
        messageCount: g.messages.length,
      })),
      templates: this.templates.map((t) => ({ name: t.name, category: t.category, status: t.status, language: t.language })),
      device: this.deviceView(),
      faults: this.faults,
      autoRead: this.autoRead,
    }
  }

  stop() {
    this.dispatcher.stop()
    if (this.qrTimer) clearInterval(this.qrTimer)
  }
}
