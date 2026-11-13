import type { FastifyPluginAsync } from 'fastify'
import { verifySignature } from '../shared/crypto'
import type { Agent } from './agent'
import { matchCommand } from './voice/match'
import type { InboundDm } from './inbound'
import { runTimed, Stopwatch, type InputKind } from './timing'
import { looksLikeInjection, redact } from './redact'

/**
 * Cloud API webhook receiver: GET verify handshake, POST with HMAC over the exact raw bytes,
 * durable inbox write BEFORE the 200, then asynchronous processing.
 */
export function cloudWebhook(agent: Agent): FastifyPluginAsync {
  return async (app) => {
    // Raw bytes for signature verification; scoped to this plugin only.
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

    app.get<{ Params: { channelId: string }; Querystring: Record<string, string> }>('/webhook/:channelId', async (req, reply) => {
      const ch = agent.channels.cloud(req.params.channelId)
      const mode = req.query['hub.mode']
      const token = req.query['hub.verify_token']
      const ok = !!ch && mode === 'subscribe' && token === ch.config.verifyToken
      agent.bus.log({ kind: 'webhook.in', lane: 'A', live: ch?.mode === 'live', title: `GET verify · ${req.params.channelId}`, status: ok ? 200 : 403, detail: ok ? 'verify token matched; echoing hub.challenge' : 'verify token mismatch' })
      if (!ok) return reply.code(403).send('forbidden')
      return reply.type('text/plain').send(req.query['hub.challenge'] ?? '')
    })

    app.post<{ Params: { channelId: string } }>('/webhook/:channelId', async (req, reply) => {
      const ch = agent.channels.cloud(req.params.channelId)
      const live = ch?.mode === 'live'
      if (!ch) return reply.code(404).send({ error: 'unknown channel' })
      const raw = req.body as Buffer
      if (agent.failNextWebhooks > 0) {
        agent.failNextWebhooks--
        agent.bus.log({ kind: 'webhook.in', lane: 'A', live, title: 'Webhook rejected (fault injection)', status: 500, detail: `${agent.failNextWebhooks} more forced failures queued` })
        return reply.code(500).send({ error: 'injected failure' })
      }
      const sig = req.headers['x-hub-signature-256'] as string | undefined
      if (!ch.config.appSecret) {
        // An HMAC with an empty key is forgeable, so never accept webhooks until the secret is set.
        // Meta retries refused deliveries, so nothing is lost once the secret is added.
        agent.bus.log({ kind: 'webhook.in', lane: 'A', live, title: 'Webhook refused: no App secret on this channel', status: 401, detail: 'Add the App secret (App settings → Basic) on the Live lab card; Meta will retry' })
        return reply.code(401).send({ error: 'app secret not configured' })
      }
      if (!Buffer.isBuffer(raw) || !verifySignature(ch.config.appSecret, raw, sig)) {
        agent.bus.log({ kind: 'webhook.in', lane: 'A', live, title: 'Webhook signature invalid', status: 401, detail: 'X-Hub-Signature-256 did not match HMAC(app_secret, raw body)' })
        return reply.code(401).send({ error: 'bad signature' })
      }
      const r = agent.store.sql.run('insert into inbox(channel_id, received_at, body, processed) values(?,?,?,0)', ch.id, Date.now(), raw.toString('utf8'))
      const inboxId = Number(r.lastInsertRowid)
      agent.bus.log({ kind: 'webhook.in', lane: 'A', live, title: `Webhook accepted → inbox #${inboxId}`, status: 200, detail: 'signature ok; stored durably, processing async' })
      setImmediate(() => processInbox(agent, inboxId).catch((e) => agent.bus.log({ kind: 'agent', lane: 'A', title: 'Inbox processing error', detail: (e as Error).message })))
      return reply.code(200).send('EVENT_RECEIVED')
    })
  }
}

/** Re-process anything left unprocessed (e.g. a crash between the 200 and processing). */
export async function drainInbox(agent: Agent) {
  const rows = agent.store.sql.all<{ id: number }>('select id from inbox where processed=0 order by id')
  for (const r of rows) await processInbox(agent, r.id)
}

const chains = new Map<string, Promise<void>>()

/** Serialise processing per channel so a conversation's events apply in arrival order. */
export function processInbox(agent: Agent, inboxId: number): Promise<void> {
  const row = agent.store.sql.get<{ channel_id: string }>('select channel_id from inbox where id=?', inboxId)
  const key = row?.channel_id ?? '-'
  const prev = chains.get(key) ?? Promise.resolve()
  const next = prev.then(() => processOne(agent, inboxId)).catch(() => undefined)
  chains.set(key, next)
  return next
}

async function processOne(agent: Agent, inboxId: number) {
  const row = agent.store.sql.get<{ id: number; channel_id: string; body: string | null; processed: number; received_at: number }>('select * from inbox where id=?', inboxId)
  if (!row || row.processed || !row.body) return
  let payload: any
  try {
    payload = JSON.parse(row.body)
  } catch (e) {
    agent.store.sql.run('update inbox set processed=1, error=?, body=null where id=?', 'invalid json', row.id)
    return
  }
  // Messages are handed to a per-person queue and NOT awaited here: the channel chain only parses and
  // dispatches in arrival order, so one person's slow voice note never delays anyone else.
  const work: Promise<unknown>[] = []
  try {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        await handleChange(agent, row.channel_id, change.field, change.value ?? {}, work, row.received_at)
      }
    }
  } catch (e) {
    agent.store.sql.run('update inbox set error=? where id=?', (e as Error).message, row.id)
    throw e
  }
  const done = Promise.allSettled(work)
    .then((results) => {
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failed) {
        agent.store.sql.run('update inbox set error=? where id=?', String(failed.reason?.message ?? failed.reason), row.id)
        agent.bus.log({ kind: 'agent', lane: 'A', title: 'Inbox processing error', detail: String(failed.reason?.message ?? failed.reason) })
      }
      // Raw body may hold personal data: drop it once processed.
      agent.store.sql.run('update inbox set processed=1, body=null where id=?', row.id)
    })
    // On shutdown the database may already be closed; the row stays unprocessed and is retried on the next start.
    .catch(() => undefined)
  inflight.add(done)
  void done.finally(() => inflight.delete(done))
}

/** Replies still being worked on (not awaited by the channel chain). */
const inflight = new Set<Promise<unknown>>()

/** Waits for in-flight replies to finish, up to `ms`, so shutdown does not cut a reply off midway. */
export async function settleReplies(ms = 5000) {
  if (!inflight.size) return
  await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, ms).unref())])
}

async function handleChange(agent: Agent, channelId: string, field: string, value: any, work: Promise<unknown>[] = [], receivedAt = Date.now()) {
  const { store, bus } = agent
  const live = agent.channels.get(channelId)?.mode === 'live'
  if (field === 'messages') {
    const contacts: any[] = value.contacts ?? []
    for (const msg of value.messages ?? []) {
      if (store.seen(`${channelId}:messages:${msg.id}:`)) {
        bus.log({ kind: 'agent', lane: 'A', live, title: 'Duplicate message ignored', detail: `dedupe key messages:${msg.id}` })
        continue
      }
      const contact = contacts.find((c) => (msg.from_user_id && c.user_id === msg.from_user_id) || (msg.from && c.wa_id === msg.from)) ?? contacts[0] ?? {}
      const personId = agent.identity.resolveCloud({ channelId, waId: msg.from ?? contact.wa_id, bsuid: msg.from_user_id ?? contact.user_id, name: contact.profile?.name })
      work.push(handleInboundMessage(agent, channelId, personId, msg, contact.profile?.name, receivedAt))
    }
    for (const st of value.statuses ?? []) {
      if (store.seen(`${channelId}:statuses:${st.id}:${st.status}${st.recipient_participant_user_id ? ':' + st.recipient_participant_user_id : ''}`)) {
        bus.log({ kind: 'agent', lane: 'A', live, title: `Duplicate status ignored (${st.status})`, detail: st.id.slice(0, 24) + '…' })
        continue
      }
      const err = st.errors?.[0]
      const updated = agent.applyStatus(st.id, st.status, err ? { code: err.code, title: err.title, details: err.error_data?.details } : undefined)
      agent.onboarding.onOtpStatus(st.id, st.status, err ? `#${err.code} ${err.title}` : undefined)
      if (st.status === 'failed' && err?.code === 131047 && updated && updated.type !== 'template') {
        await reengage(agent, channelId, updated.conversation_id)
      }
    }
    return
  }
  if (field === 'group_lifecycle_update') {
    for (const g of value.groups ?? []) {
      if (store.seen(`${channelId}:group_lifecycle_update:${g.request_id ?? g.group_id}:${g.type}`)) continue
      agent.groups.onLifecycle(channelId, g)
    }
    return
  }
  if (field === 'group_participants_update') {
    for (const g of value.groups ?? []) {
      const who = JSON.stringify(g.added_participants ?? g.removed_participants ?? [])
      if (store.seen(`${channelId}:group_participants_update:${g.group_id}:${g.type}:${g.timestamp}:${who}`)) continue
      agent.groups.onParticipants(channelId, g)
    }
    return
  }
  if (field === 'message_template_status_update') {
    bus.log({ kind: 'agent', lane: 'A', live, title: `Template ${value.message_template_name} → ${value.event}` })
    bus.change('templates')
    return
  }
  bus.log({ kind: 'agent', lane: 'A', live, title: `Unhandled webhook field "${field}"`, detail: 'ignored' })
}

type Described = Pick<InboundDm, 'type' | 'text' | 'replyId' | 'media' | 'location' | 'contacts'>

/** Turns a Cloud API message object into what the inbox stores and the brain reads. */
function describe(msg: any): Described {
  const media = (kind: 'image' | 'document' | 'video', m: any): Described => ({
    type: kind,
    text: m?.caption || (kind === 'image' ? '[photo]' : kind === 'video' ? '[video]' : `[document${m?.filename ? `: ${m.filename}` : ''}]`),
    media: { id: m?.id, mime: m?.mime_type ?? 'application/octet-stream', kind, caption: m?.caption, filename: m?.filename, sha256: m?.sha256 },
  })
  switch (msg.type) {
    case 'text':
      return { type: 'text', text: msg.text?.body ?? '' }
    case 'interactive': {
      const it = msg.interactive ?? {}
      if (it.type === 'button_reply') return { type: 'button_reply', text: it.button_reply.title, replyId: it.button_reply.id }
      if (it.type === 'list_reply') return { type: 'list_reply', text: it.list_reply.title, replyId: it.list_reply.id }
      return { type: 'other', text: '[flow response]' }
    }
    case 'button':
      return { type: 'button', text: msg.button?.text ?? '', replyId: msg.button?.payload }
    case 'image':
      return media('image', msg.image)
    case 'document':
      return media('document', msg.document)
    case 'video':
      return media('video', msg.video)
    case 'sticker':
      return { type: 'other', text: '[sticker]' }
    case 'location': {
      const l = msg.location ?? {}
      const label = [l.name, l.address].filter(Boolean).join(', ')
      return { type: 'location', text: `[location${label ? `: ${label}` : ''}]`, location: { lat: Number(l.latitude), lng: Number(l.longitude), name: l.name, address: l.address } }
    }
    case 'contacts': {
      const contacts = ((msg.contacts ?? []) as any[]).map((c) => ({ name: c.name?.formatted_name ?? c.name?.first_name ?? '', phone: String(c.phones?.[0]?.wa_id ?? c.phones?.[0]?.phone ?? '') }))
      return { type: 'contacts', text: `[contact: ${contacts.map((c) => `${c.name} ${c.phone}`.trim()).join(', ')}]`, contacts }
    }
    case 'unsupported':
      return { type: 'other', text: `[unsupported message: ${msg.errors?.[0]?.title ?? 'type not supported'}]` }
    default:
      return { type: 'other', text: `[${msg.type} message]` }
  }
}

const KIND: Record<string, InputKind> = { text: 'text', button_reply: 'tap', list_reply: 'tap', button: 'tap', image: 'photo', document: 'photo', video: 'photo', location: 'location' }

/**
 * Stores the message and hands it to the brain. Returns the person's queued work (the caller does not wait
 * for it). Messages from the same person run one at a time, in order; different people run side by side.
 */
function handleInboundMessage(agent: Agent, channelId: string, personId: string, msg: any, name: string | undefined, receivedAt: number): Promise<void> {
  const { store, bus } = agent
  const d = describe(msg)
  const at = Number(msg.timestamp) * 1000 || Date.now()

  if (msg.group_id) {
    return agent.serial.run(`${channelId}:group:${msg.group_id}`, async () => {
      const g = store.sql.get<{ subject: string }>('select subject from api_groups where group_id=?', msg.group_id)
      const conv = store.ensureConversation({ channel_id: channelId, kind: 'group', lane: 'A', external_id: msg.group_id, title: g?.subject ?? 'Group' })
      const red = redact(d.text)
      store.addMessage({
        conversation_id: conv.id,
        external_id: msg.id,
        dir: 'in',
        sender_person_id: personId,
        sender_label: store.person(personId)?.display_name ?? name ?? 'member',
        type: msg.type,
        text: red.text,
        payload: JSON.stringify({ injection: looksLikeInjection(d.text) || undefined }),
        status: null,
        error: null,
        at,
        redactions: red.count,
      })
      bus.change('conversations', { id: conv.id })
      await agent.groups.onApiGroupMessage(channelId, conv, d.text)
    })
  }

  const conv = agent.dmConversation(channelId, personId)
  const assigned = () => !!store.sql.get<{ assignee: string | null }>('select assignee from conversations where id=?', conv.id)?.assignee
  const quiet = () => {
    bus.log({ kind: 'agent', lane: 'A', title: 'Assigned to a human: agent stays quiet', detail: conv.title })
  }
  const sw = new Stopwatch(store.sql, channelId, personId, msg.type === 'audio' ? 'voice' : (KIND[d.type] ?? 'other'), receivedAt)
  // Blue ticks straight away, plus "typing…" while the bot works on it (Meta clears it when we reply, or
  // after about 25 s). Not when a person on the team owns the chat: they may not answer at once.
  if (msg.id) void agent.client(channelId).markRead(msg.id, !assigned()).catch(() => undefined)

  return agent.serial.run(`${channelId}:${personId}`, () =>
    runTimed(sw, async () => {
      sw.mark('start')
      if (msg.type === 'audio') {
        const row = store.addMessage({
          conversation_id: conv.id,
          external_id: msg.id,
          dir: 'in',
          sender_person_id: personId,
          sender_label: store.person(personId)?.display_name ?? name ?? 'contact',
          type: 'audio',
          text: '',
          payload: JSON.stringify({ voice: msg.audio?.voice !== false, state: 'transcribing' }),
          status: null,
          error: null,
          at,
        })
        bus.change('conversations', { id: conv.id })
        // Transcribed even when a human is assigned, so the team can read it.
        const r = await agent.voice.receive(channelId, conv.id, row.id, msg.audio ?? {})
        sw.mark('transcribed')
        if (!r.ok) {
          if (assigned()) quiet()
          else await agent.text(channelId, personId, r.reply)
          return
        }
        if (matchCommand(r.text) !== 'stop' && assigned()) return quiet()
        await agent.brain.handle({ channelId, personId, type: 'voice', text: r.text, messageId: row.id, wamid: msg.id })
        return
      }
      const row = store.addMessage({
        conversation_id: conv.id,
        external_id: msg.id,
        dir: 'in',
        sender_person_id: personId,
        sender_label: store.person(personId)?.display_name ?? name ?? 'contact',
        type: msg.type,
        text: d.text,
        payload:
          d.replyId || msg.context || d.media || d.location || d.contacts
            ? JSON.stringify({ replyId: d.replyId, contextId: msg.context?.id, media: d.media, location: d.location, contacts: d.contacts })
            : null,
        status: null,
        error: null,
        at,
      })
      bus.change('conversations', { id: conv.id })
      if (d.text.trim().toUpperCase() !== 'STOP' && assigned()) return quiet()
      await agent.brain.handle({ channelId, personId, ...d, messageId: row.id, wamid: msg.id })
    }),
  )
}

/** 131047 = outside the 24h window: free-form failed asynchronously, so fall back to an approved template. */
async function reengage(agent: Agent, channelId: string, conversationId: string) {
  const ch = agent.cloudChannel(channelId)
  const conv = agent.store.conversation(conversationId)
  if (!conv?.person_id || !ch.config.reengageTemplate) return
  const p = agent.store.person(conv.person_id)
  agent.bus.log({ kind: 'agent', lane: 'A', title: 'Free-form failed with 131047 → sending re-engagement template', detail: `template ${ch.config.reengageTemplate}` })
  await agent.template(channelId, conv.person_id, ch.config.reengageTemplate, ch.config.otpLanguage, [p?.display_name?.split(' ')[0] ?? 'there'], `Re-engagement template "${ch.config.reengageTemplate}"`)
}
