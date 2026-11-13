import type { FastifyPluginAsync, FastifyReply } from 'fastify'
import { createReadStream } from 'node:fs'
import type { ChangeEvent, WireEvent } from '../shared/bus'
import { randomToken } from '../shared/crypto'
import { uid } from '../shared/ids'
import type { Agent } from './agent'
import { SANDBOX_CLOUD, SANDBOX_LINKED, type CloudConfig } from './channels'
import type { ConversationRow, MessageRow, PersonRow } from './store'

const OPERATORS = ['You', 'Support team', 'Sales team']
const DAY = 24 * 60 * 60 * 1000

const bad = (reply: FastifyReply, error: string, code = 400) => reply.code(code).send({ ok: false, error })

export function consoleApi(agent: Agent): FastifyPluginAsync {
  const { store, bus } = agent

  const messageView = (m: MessageRow) => {
    const payload = m.payload ? JSON.parse(m.payload) : null
    return {
      ...m,
      payload,
      error: m.error ? JSON.parse(m.error) : null,
      reactions: m.reactions ? Object.values(JSON.parse(m.reactions) as Record<string, string>) : [],
      // Voice notes: whether the recording can still be played (raw audio is deleted after the retention window).
      audio: m.type === 'audio' && payload?.media ? { id: payload.media, state: agent.voice.mediaState(payload.media) } : undefined,
    }
  }

  const convView = (c: ConversationRow) => {
    const ch = agent.channels.get(c.channel_id)
    const last = store.sql.get<{ text: string; dir: string; at: number; type: string }>('select text, dir, at, type from messages where conversation_id=? order by at desc, rowid desc limit 1', c.id)
    const consent = c.lane === 'B' ? store.consent(c.id) : undefined
    return {
      ...c,
      channel: ch ? { id: ch.id, name: ch.name, mode: ch.mode, kind: ch.kind } : null,
      last,
      windowOpen: c.kind === 'dm' ? !!c.last_inbound_at && Date.now() - c.last_inbound_at < DAY : null,
      windowEndsAt: c.kind === 'dm' && c.last_inbound_at ? c.last_inbound_at + DAY : null,
      consent: consent ?? null,
      readOnly: c.lane === 'B',
    }
  }

  const personView = (p: PersonRow) => {
    const links = store.links(p.id)
    const onboarding = store.sql.all<{ channel_id: string; step: string; updated_at: number }>('select channel_id, step, updated_at from onboarding where person_id=?', p.id)
    const convs = store.sql.get<{ n: number }>('select count(*) n from conversations where person_id=?', p.id)?.n ?? 0
    const msgs = store.sql.get<{ n: number; last: number | null }>('select count(*) n, max(at) last from messages where sender_person_id=?', p.id)
    return { ...p, links, onboarding, conversations: convs, messages: msgs?.n ?? 0, lastSeen: msgs?.last ?? null }
  }

  const channelView = (id: string) => {
    const ch = agent.channels.get(id)!
    const v: any = agent.channels.redacted(ch)
    if (ch.kind === 'linked') v.linked = agent.linked.view(ch.id)
    if (ch.kind === 'cloud') {
      // The sandbox world calls its webhook in-process; only live channels need the public tunnel URL.
      v.webhookUrl = `${ch.mode === 'live' ? agent.publicBase() : agent.internalBase}/webhook/${ch.id}`
      v.hasAppSecret = !!(ch.config as CloudConfig).appSecret
    }
    return v
  }

  return async (app) => {
    // ------------------------------------------------------------ stream + bootstrap
    app.get('/stream', (req, reply) => {
      reply.hijack()
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      const onWire = (e: WireEvent) => send('wire', e)
      const onChange = (c: ChangeEvent) => send('change', c)
      bus.on('wire', onWire)
      bus.on('change', onChange)
      send('hello', { at: Date.now() })
      const ping = setInterval(() => reply.raw.write(': ping\n\n'), 15_000)
      req.raw.on('close', () => {
        clearInterval(ping)
        bus.off('wire', onWire)
        bus.off('change', onChange)
      })
    })

    app.get('/bootstrap', async () => ({
      channels: agent.channels.all().map((c) => channelView(c.id)),
      settings: settingsView(),
      operators: OPERATORS,
      llm: agent.llm.engine,
    }))

    app.get<{ Querystring: { limit?: string } }>('/wire', async (req) => bus.recent(Number(req.query.limit ?? 300)))

    // ------------------------------------------------------------ dashboard
    app.get('/dashboard', async () => {
      const n = (sql: string, ...p: any[]) => store.sql.get<{ n: number }>(sql, ...p)?.n ?? 0
      const since = Date.now() - DAY
      const hours = 12
      const buckets = Array.from({ length: hours }, (_, i) => {
        const end = Date.now() - (hours - 1 - i) * 3600_000
        const start = end - 3600_000
        return {
          label: new Date(end).toISOString(),
          inbound: n("select count(*) n from messages where dir='in' and at>=? and at<?", start, end),
          outbound: n("select count(*) n from messages where dir='out' and at>=? and at<?", start, end),
        }
      })
      return {
        contacts: n('select count(*) n from persons'),
        activeAccounts: n("select count(*) n from persons where account_status='active'"),
        onboarding: n("select count(*) n from persons where account_status='onboarding'"),
        openConversations: n("select count(*) n from conversations where status='open' and kind='dm'"),
        unread: n('select coalesce(sum(unread),0) n from conversations'),
        inbound24h: n("select count(*) n from messages where dir='in' and at>=?", since),
        outbound24h: n("select count(*) n from messages where dir='out' and at>=?", since),
        failed24h: n("select count(*) n from messages where status='failed' and at>=?", since),
        apiGroups: n('select count(*) n from api_groups'),
        linkedGroups: n("select count(*) n from conversations where lane='B' and kind!='community'"),
        consentedGroups: n('select count(*) n from consent'),
        blockedMessages: n("select coalesce(sum(blocked),0) n from conversations where lane='B'"),
        redactions: n('select coalesce(sum(redactions),0) n from messages'),
        funnel: agent.dashboardFunnel(),
        series: buckets,
        channels: agent.channels.all().map((c) => channelView(c.id)),
        llm: agent.llm.engine,
        llmProvider: agent.llm.provider,
      }
    })

    // ------------------------------------------------------------ inbox
    app.get<{ Querystring: { filter?: string; channel?: string; q?: string } }>('/conversations', async (req) => {
      const { filter = 'all', channel, q } = req.query
      const where: string[] = ["kind != 'community'"]
      const params: any[] = []
      if (filter === 'dm') where.push("kind='dm'")
      if (filter === 'groups') where.push("kind!='dm'")
      if (filter === 'laneA') where.push("lane='A'")
      if (filter === 'laneB') where.push("lane='B'")
      if (filter === 'unread') where.push('unread>0')
      if (filter === 'resolved') where.push("status='resolved'")
      if (filter === 'open') where.push("status='open'")
      if (channel) where.push('channel_id=?') && params.push(channel)
      if (q) where.push('title like ?') && params.push(`%${q}%`)
      const rows = store.sql.all<ConversationRow>(`select * from conversations where ${where.join(' and ')} order by coalesce(last_message_at, 0) desc limit 300`, ...params)
      return rows.map(convView)
    })

    app.get<{ Params: { id: string } }>('/conversations/:id', async (req, reply) => {
      const c = store.conversation(req.params.id)
      if (!c) return bad(reply, 'not found', 404)
      const person = c.person_id ? store.person(c.person_id) : undefined
      const apiGroup = c.lane === 'A' && c.kind === 'group' ? store.sql.get<any>('select * from api_groups where group_id=?', c.external_id) : undefined
      return {
        conversation: convView(c),
        messages: store.messages(c.id, 300).map(messageView),
        person: person ? personView(person) : null,
        apiGroup: apiGroup ? { ...apiGroup, participants: JSON.parse(apiGroup.participants).map((id: string) => ({ id, name: store.person(id)?.display_name })) } : null,
        undecryptable: store.counter(`${c.channel_id}:undecryptable`),
      }
    })

    app.post<{ Params: { id: string } }>('/conversations/:id/read', async (req) => {
      store.sql.run('update conversations set unread=0 where id=?', req.params.id)
      bus.change('conversations', { id: req.params.id })
      return { ok: true }
    })

    app.post<{ Params: { id: string }; Body: { status?: 'open' | 'resolved'; assignee?: string | null } }>('/conversations/:id/meta', async (req) => {
      const { status, assignee } = req.body ?? {}
      if (status) store.sql.run('update conversations set status=? where id=?', status, req.params.id)
      if (assignee !== undefined) store.sql.run('update conversations set assignee=? where id=?', assignee || null, req.params.id)
      bus.change('conversations', { id: req.params.id })
      return { ok: true }
    })

    app.post<{ Params: { id: string }; Body: any }>('/conversations/:id/send', async (req, reply) => {
      const c = store.conversation(req.params.id)
      if (!c) return bad(reply, 'not found', 404)
      if (c.lane === 'B') return bad(reply, 'Linked-device lane is read-only by design')
      const b: any = req.body ?? {}
      if (c.kind === 'group') {
        if (b.kind !== 'text' || !b.text) return bad(reply, 'Groups API groups accept text and templates only (no interactive)')
        const res = await agent.client(c.channel_id).sendGroupText(c.external_id, b.text)
        store.addMessage({ conversation_id: c.id, external_id: res.json?.messages?.[0]?.id ?? null, dir: 'out', sender_person_id: null, sender_label: 'You', type: 'text', text: b.text, payload: null, status: res.ok ? 'accepted' : 'failed', error: res.ok ? null : JSON.stringify(res.error), at: Date.now() })
        bus.change('conversations', { id: c.id })
        return { ok: res.ok, error: res.error?.message }
      }
      if (!c.person_id) return bad(reply, 'conversation has no contact')
      let r
      // What the team types goes out exactly as typed: never turned into a voice note.
      if (b.kind === 'text') r = await agent.text(c.channel_id, c.person_id, String(b.text ?? ''), { voice: false })
      else if (b.kind === 'buttons') r = await agent.buttons(c.channel_id, c.person_id, String(b.text ?? ''), (b.buttons ?? []).slice(0, 3).map((t: string, i: number) => ({ id: `op_${i}`, title: String(t).slice(0, 20) })), { voice: false })
      else if (b.kind === 'template') r = await agent.template(c.channel_id, c.person_id, String(b.name), String(b.language ?? 'en_US'), (b.params ?? []).map(String))
      else return bad(reply, 'unknown kind')
      return { ok: r.ok, error: r.error }
    })

    app.post<{ Params: { id: string }; Body: { grantedBy?: string; scope?: string } }>('/conversations/:id/consent', async (req, reply) => {
      const c = store.conversation(req.params.id)
      if (!c || c.lane !== 'B') return bad(reply, 'consent applies to linked-device groups')
      const grantedBy = (req.body?.grantedBy ?? '').trim()
      if (!grantedBy) return bad(reply, 'Name the group admin who gave consent')
      agent.groups.grantConsent(c.id, grantedBy, req.body?.scope || 'digest + Q&A; members told in group description')
      return { ok: true }
    })
    app.delete<{ Params: { id: string } }>('/conversations/:id/consent', async (req) => {
      agent.groups.revokeConsent(req.params.id)
      return { ok: true }
    })

    app.post<{ Params: { id: string } }>('/conversations/:id/digest', async (req, reply) => {
      try {
        return { ok: true, digest: await agent.groups.digest(req.params.id) }
      } catch (e) {
        return bad(reply, (e as Error).message)
      }
    })
    app.post<{ Params: { id: string }; Body: { question?: string } }>('/conversations/:id/ask', async (req, reply) => {
      const q = (req.body?.question ?? '').trim()
      if (!q) return bad(reply, 'question required')
      return { ok: true, answer: await agent.groups.ask(req.params.id, q) }
    })
    app.get<{ Params: { id: string } }>('/conversations/:id/digests', async (req) =>
      store.sql
        .all<{ id: string; created_at: number; engine: string; kind: string; question: string | null; content: string }>('select * from digests where conversation_id=? order by created_at desc limit 20', req.params.id)
        .map((d) => ({ ...d, content: JSON.parse(d.content) })),
    )

    // ------------------------------------------------------------ contacts
    app.get<{ Querystring: { q?: string } }>('/contacts', async (req) => {
      const q = req.query.q ? `%${req.query.q}%` : '%'
      return store.sql.all<PersonRow>('select * from persons where display_name like ? order by created_at desc limit 500', q).map(personView)
    })
    app.post<{ Params: { id: string }; Body: { optedOut?: boolean } }>('/contacts/:id', async (req) => {
      if (req.body?.optedOut !== undefined) store.sql.run('update persons set opted_out=? where id=?', req.body.optedOut ? 1 : 0, req.params.id)
      bus.change('contacts')
      return { ok: true }
    })

    // ------------------------------------------------------------ templates + broadcasts
    app.get<{ Querystring: { channel?: string } }>('/templates', async (req, reply) => {
      const ch = req.query.channel ?? SANDBOX_CLOUD
      const res = await agent.client(ch).listTemplates()
      if (!res.ok) return bad(reply, res.error?.message ?? 'failed')
      return res.json.data ?? []
    })
    app.post<{ Body: any }>('/templates', async (req, reply) => {
      const b: any = req.body ?? {}
      const components: any[] = [{ type: 'BODY', text: String(b.body ?? '') }]
      if (b.footer) components.push({ type: 'FOOTER', text: String(b.footer) })
      const qr = (b.buttons ?? []).filter(Boolean).slice(0, 3)
      if (qr.length) components.push({ type: 'BUTTONS', buttons: qr.map((t: string) => ({ type: 'QUICK_REPLY', text: String(t).slice(0, 25) })) })
      const res = await agent.client(b.channelId ?? SANDBOX_CLOUD).createTemplate({ name: String(b.name ?? ''), language: String(b.language ?? 'en_US'), category: String(b.category ?? 'UTILITY'), components })
      if (!res.ok) return bad(reply, res.error?.message ?? 'failed')
      bus.change('templates')
      return { ok: true, template: res.json }
    })

    app.get('/broadcasts', async () => store.sql.all<any>('select * from broadcasts order by created_at desc limit 50').map((b) => ({ ...b, results: JSON.parse(b.results ?? '[]') })))
    app.post<{ Body: { channelId?: string; template: string; language?: string; params?: string[]; personIds: string[] } }>('/broadcasts', async (req, reply) => {
      const b = req.body
      if (!b?.template || !b.personIds?.length) return bad(reply, 'template and recipients required')
      const channelId = b.channelId ?? SANDBOX_CLOUD
      const results: { personId: string; name: string; ok: boolean; error?: string; skipped?: string }[] = []
      for (const pid of b.personIds) {
        const p = store.person(pid)
        if (!p) continue
        if (p.opted_out) {
          results.push({ personId: pid, name: p.display_name, ok: false, skipped: 'opted out' })
          continue
        }
        const params = (b.params ?? []).map((x) => x.replace(/\{\{name\}\}/g, p.display_name.split(' ')[0]))
        const r = await agent.template(channelId, pid, b.template, b.language ?? 'en_US', params)
        results.push({ personId: pid, name: p.display_name, ok: r.ok, error: r.error })
      }
      const id = uid('bc')
      store.sql.run('insert into broadcasts(id, channel_id, created_at, template, recipients, accepted, failed, results) values(?,?,?,?,?,?,?,?)', id, channelId, Date.now(), b.template, results.length, results.filter((r) => r.ok).length, results.filter((r) => !r.ok).length, JSON.stringify(results))
      bus.change('broadcasts')
      return { ok: true, id, results }
    })

    // ------------------------------------------------------------ groups
    app.get('/groups', async () => {
      const api = store.sql.all<any>('select * from api_groups order by created_at desc').map((g) => {
        const conv = store.conversationByExternal(g.channel_id, g.group_id)
        const participants = JSON.parse(g.participants) as string[]
        return { ...g, conversationId: conv?.id, participants: participants.map((id) => ({ id, name: store.person(id)?.display_name })), cap: 8 }
      })
      const requests = store.sql.all<any>('select * from group_requests order by created_at desc limit 20')
      const linked = store.sql.all<ConversationRow>("select * from conversations where lane='B' order by kind, title").map(convView)
      return { api, requests, linked }
    })
    app.post<{ Body: { channelId?: string; subject: string } }>('/groups/api', async (req, reply) => {
      const subject = (req.body?.subject ?? '').trim()
      if (!subject) return bad(reply, 'subject required')
      return agent.groups.createApiGroup(req.body.channelId ?? SANDBOX_CLOUD, subject)
    })
    app.post<{ Params: { groupId: string }; Body: { channelId?: string; personId: string } }>('/groups/api/:groupId/invite', async (req) => {
      const r = await agent.groups.invite(req.body.channelId ?? SANDBOX_CLOUD, req.params.groupId, req.body.personId)
      return { ok: r.ok, error: r.error }
    })
    app.post<{ Params: { groupId: string }; Body: { channelId?: string; personId: string } }>('/groups/api/:groupId/remove', async (req, reply) => {
      const ch = req.body.channelId ?? SANDBOX_CLOUD
      const pn = store.links(req.body.personId).find((l) => l.kind === 'pn')
      const bsuid = store.links(req.body.personId).find((l) => l.kind === 'bsuid' && l.channel_id === ch)
      if (!pn && !bsuid) return bad(reply, 'no identifier for this contact')
      const res = await agent.client(ch).removeParticipants(req.params.groupId, [pn ? { user: pn.value } : { user_id: bsuid!.value }])
      return { ok: res.ok, error: res.error?.message }
    })

    // ------------------------------------------------------------ channels (live lab)
    app.get('/channels', async () => agent.channels.all().map((c) => channelView(c.id)))

    const newToken = (b: any) => (b?.accessToken && !String(b.accessToken).startsWith('••••') ? String(b.accessToken).trim() : '')
    const cloudFromBody = (b: any, prev?: CloudConfig): CloudConfig => ({
      graphBase: 'https://graph.facebook.com',
      graphVersion: String(b.graphVersion || prev?.graphVersion || 'v24.0'),
      phoneNumberId: String(b.phoneNumberId ?? prev?.phoneNumberId ?? '').trim(),
      wabaId: String(b.wabaId ?? prev?.wabaId ?? '').trim(),
      accessToken: newToken(b) || (prev?.accessToken ?? ''),
      tokenExpiresAt: newToken(b) ? undefined : prev?.tokenExpiresAt,
      appSecret: b.appSecret && !String(b.appSecret).startsWith('••••') ? String(b.appSecret).trim() : (prev?.appSecret ?? ''),
      verifyToken: String(b.verifyToken || prev?.verifyToken || randomToken(12)),
      displayPhone: String(b.displayPhone ?? prev?.displayPhone ?? '').replace(/\D/g, ''),
      otpTemplate: String(b.otpTemplate || prev?.otpTemplate || 'otp_login'),
      otpLanguage: String(b.otpLanguage || prev?.otpLanguage || 'en_US'),
      reengageTemplate: b.reengageTemplate ?? prev?.reengageTemplate ?? '',
      inviteTemplate: b.inviteTemplate ?? prev?.inviteTemplate ?? '',
      oba: !!(b.oba ?? prev?.oba),
    })

    app.post<{ Body: any }>('/channels/cloud', async (req, reply) => {
      const cfg = cloudFromBody(req.body ?? {})
      if (!cfg.phoneNumberId || !cfg.wabaId || !cfg.accessToken) return bad(reply, 'Phone number ID, WABA ID and access token are required')
      const id = agent.channels.newId('live-cloud')
      // Saving without the App secret is allowed so sending can be tested; webhooks are refused until it is added.
      agent.channels.upsert({ id, kind: 'cloud', mode: 'live', name: String((req.body as any)?.name || 'My Cloud API number'), config: cfg, status: 'untested' })
      return { ok: true, channel: channelView(id) }
    })
    app.patch<{ Params: { id: string }; Body: any }>('/channels/:id', async (req, reply) => {
      const ch = agent.channels.get(req.params.id)
      if (!ch || ch.mode !== 'live') return bad(reply, 'only live channels can be edited')
      if (ch.kind === 'cloud') {
        agent.channels.upsert({ ...ch, name: (req.body as any)?.name ?? ch.name, config: cloudFromBody(req.body ?? {}, ch.config as CloudConfig) })
        if (newToken(req.body)) agent.channels.setStatus(ch.id, 'untested', 'New access token saved: press Test connection')
      } else agent.channels.upsert({ ...ch, name: (req.body as any)?.name ?? ch.name })
      return { ok: true, channel: channelView(ch.id) }
    })
    app.post<{ Params: { id: string } }>('/channels/:id/test', async (req, reply) => {
      const ch = agent.channels.cloud(req.params.id)
      if (!ch) return bad(reply, 'not a Cloud API channel')
      const client = agent.client(ch.id)
      const res = await client.phoneInfo()
      if (res.ok) {
        const displayPhone = String(res.json.display_phone_number ?? '').replace(/\D/g, '')
        // Also ask Meta when the token runs out, so an expiring temporary token is visible before sends start failing.
        let tokenExpiresAt = ch.config.tokenExpiresAt
        let tokenNote = ''
        if (ch.mode === 'live' && ch.config.appSecret) {
          const t = await client.tokenInfo(ch.config.appSecret)
          if (t.ok) {
            tokenExpiresAt = t.expiresAt
            tokenNote = t.expiresAt ? ` · token expires ${new Date(t.expiresAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ' · token never expires'
          }
        }
        agent.channels.upsert({ ...ch, config: { ...ch.config, displayPhone: displayPhone || ch.config.displayPhone, tokenExpiresAt } })
        agent.channels.setStatus(ch.id, 'ready', `${res.json.verified_name ?? ''} · +${displayPhone} · quality ${res.json.quality_rating ?? '?'}${tokenNote}`)
      } else agent.channels.setStatus(ch.id, 'error', [(res.error?.message ?? 'Test failed').replace(/\.?\s*$/, '.'), res.error?.details].filter(Boolean).join(' '))
      return { ok: res.ok, info: res.json, error: res.error?.message }
    })
    app.post<{ Params: { id: string } }>('/channels/:id/point-webhook', async (req, reply) => {
      const ch = agent.channels.cloud(req.params.id)
      if (!ch || ch.mode !== 'live') return bad(reply, 'only live Cloud API channels')
      const url = `${agent.publicBase()}/webhook/${ch.id}`
      if (!url.startsWith('https://')) return bad(reply, 'Set an https Public URL in Settings first (your cloudflared or ngrok tunnel)')
      if (!ch.config.appSecret) return bad(reply, 'Add the App secret first: Meta needs it (as the app access token) to change the webhook URL')
      const res = await agent.client(ch.id).pointWebhook(url, ch.config.verifyToken, ch.config.appSecret)
      if (!res.ok) {
        const where = { app: 'reading the app behind the token', waba: 'subscribing the app to the WhatsApp account', 'app-webhook': 'setting the callback URL' }[res.step as 'app' | 'waba' | 'app-webhook']
        return {
          ok: false,
          error: `Meta refused ${where}: ${res.error?.message ?? 'unknown error'}. Fallback: in the App Dashboard → Webhooks → WhatsApp Business Account, paste this card's Callback URL and Verify token, Verify and save, then subscribe to 'messages'.`,
        }
      }
      return { ok: true, callbackUrl: url, appId: 'appId' in res ? res.appId : null, active: 'active' in res ? (res.active ?? null) : null }
    })
    app.post<{ Params: { id: string }; Body: { to: string; text?: string } }>('/channels/:id/test-message', async (req, reply) => {
      const ch = agent.channels.cloud(req.params.id)
      if (!ch) return bad(reply, 'not a Cloud API channel')
      const to = String(req.body?.to ?? '').replace(/\D/g, '')
      if (!to) return bad(reply, 'recipient required')
      // Outside a 24h window only templates deliver; hello_world exists on every new WABA.
      const res = req.body?.text ? await agent.client(ch.id).sendText(to, req.body.text) : await agent.client(ch.id).sendTemplate(to, 'hello_world', 'en_US')
      return { ok: res.ok, response: res.json, error: res.error?.message }
    })
    app.post<{ Body: { name?: string; ackBanRisk?: boolean } }>('/channels/linked', async (req, reply) => {
      if (!req.body?.ackBanRisk) return bad(reply, 'You must acknowledge the ToS / ban risk to link a real number with an unofficial client')
      const id = agent.channels.newId('live-linked')
      agent.channels.upsert({ id, kind: 'linked', mode: 'live', name: req.body.name || 'Linked member number', config: { source: 'baileys', ackBanRisk: true }, status: 'disconnected' })
      agent.linked.ensure(id)
      return { ok: true, channel: channelView(id) }
    })
    app.post<{ Params: { id: string } }>('/channels/:id/connect', async (req, reply) => {
      try {
        await agent.linked.ensure(req.params.id).connect()
        return { ok: true }
      } catch (e) {
        return bad(reply, (e as Error).message)
      }
    })
    app.post<{ Params: { id: string } }>('/channels/:id/disconnect', async (req) => {
      await agent.linked.runners.get(req.params.id)?.disconnect()
      return { ok: true }
    })
    app.post<{ Params: { id: string }; Body: { phone: string } }>('/channels/:id/pair', async (req, reply) => {
      try {
        return { ok: true, code: await agent.linked.ensure(req.params.id).requestPairingCode(req.body?.phone ?? '') }
      } catch (e) {
        return bad(reply, (e as Error).message)
      }
    })
    app.delete<{ Params: { id: string } }>('/channels/:id', async (req, reply) => {
      const ch = agent.channels.get(req.params.id)
      if (!ch) return bad(reply, 'not found', 404)
      if (ch.mode === 'sandbox') return bad(reply, 'sandbox channels cannot be removed')
      if (ch.kind === 'linked') await agent.linked.removeLive(ch.id)
      store.clearChannelData([ch.id])
      agent.channels.remove(ch.id)
      return { ok: true }
    })

    // ------------------------------------------------------------ settings
    const settingsView = () => ({
      publicBaseUrl: store.setting('publicBaseUrl') ?? process.env.PUBLIC_BASE_URL ?? '',
      effectivePublicBase: agent.publicBase(),
      hasApiKey: !!(store.setting('anthropicApiKey') || process.env.ANTHROPIC_API_KEY),
      apiKeySource: store.setting('anthropicApiKey') ? 'settings' : process.env.ANTHROPIC_API_KEY ? 'env' : null,
      // An OpenRouter key (sk-or-…) is used with OpenRouter's Claude endpoint; the model id is translated for it.
      provider: agent.llm.provider,
      providerModel: agent.llm.model,
      model: store.setting('anthropicModel') || process.env.ANTHROPIC_MODEL || 'claude-opus-5-5',
      internalBase: agent.internalBase,
      voice: agent.voice.settings(),
    })
    app.get('/settings', async () => settingsView())
    app.post<{ Body: { publicBaseUrl?: string; anthropicApiKey?: string | null; anthropicModel?: string } }>('/settings', async (req) => {
      const b: any = req.body ?? {}
      if (b.publicBaseUrl !== undefined) store.setSetting('publicBaseUrl', b.publicBaseUrl.trim() ? b.publicBaseUrl.trim().replace(/\/$/, '') : null)
      if (b.anthropicApiKey !== undefined) store.setSetting('anthropicApiKey', b.anthropicApiKey ? b.anthropicApiKey.trim() : null)
      if (b.anthropicModel !== undefined) store.setSetting('anthropicModel', b.anthropicModel.trim() || null)
      const v = b.voice ?? {}
      if (v.replies !== undefined) store.setSetting('voiceReplies', ['mirror', 'always', 'never'].includes(v.replies) ? v.replies : null)
      if (v.voiceEn !== undefined) store.setSetting('voiceEn', String(v.voiceEn).trim() || null)
      if (v.voiceHi !== undefined) store.setSetting('voiceHi', String(v.voiceHi).trim() || null)
      if (v.maxSeconds !== undefined) store.setSetting('voiceMaxSeconds', Number(v.maxSeconds) > 0 ? String(Math.min(600, Number(v.maxSeconds))) : null)
      if (v.retentionHours !== undefined) store.setSetting('voiceRetentionHours', Number(v.retentionHours) > 0 ? String(Number(v.retentionHours)) : null)
      if (v.whisperModel !== undefined) store.setSetting('whisperModel', String(v.whisperModel).trim() || null)
      if (v.sandboxWhisper !== undefined) store.setSetting('voiceSandboxWhisper', v.sandboxWhisper ? '1' : null)
      if (v.retentionHours !== undefined) agent.voice.sweep()
      bus.change('channels')
      return { ok: true, settings: settingsView() }
    })

    // ------------------------------------------------------------ voice notes
    app.get('/voice/status', async () => agent.voice.status())
    app.post<{ Body: { text?: string; lang?: string } }>('/voice/preview', async (req, reply) => {
      const lang = req.body?.lang === 'hi' ? 'hi' : 'en'
      const text = String(req.body?.text ?? '').trim() || (lang === 'hi' ? 'नमस्ते! मैं EquipXchange का असिस्टेंट हूँ।' : "Hi! I'm EquipXchange's assistant. Send a photo of your machine to get started.")
      try {
        return { ok: true, id: await agent.voice.preview(text, lang) }
      } catch (e) {
        return bad(reply, (e as Error).message)
      }
    })
    // Recordings are personal data: this route is console-only (the tunnel guard blocks /api/* except /api/app/*).
    app.get<{ Params: { id: string } }>('/media/:id', async (req, reply) => {
      const f = agent.voice.mediaFile(req.params.id)
      if (!f) return bad(reply, 'Recording not found or already deleted (raw audio is kept for a limited time)', 404)
      return reply.type(f.mime).header('cache-control', 'no-store').send(createReadStream(f.path))
    })

    app.post<{ Body: { count?: number } }>('/test/fail-webhooks', async (req) => {
      agent.failNextWebhooks = Math.max(0, Math.min(10, Number(req.body?.count ?? 1)))
      bus.log({ kind: 'sandbox', lane: 'A', title: `Agent will reject the next ${agent.failNextWebhooks} webhook(s) with 500` })
      return { ok: true }
    })

    // ------------------------------------------------------------ app stub ("your app"): public-safe endpoints only
  }
}

export { SANDBOX_CLOUD, SANDBOX_LINKED }
