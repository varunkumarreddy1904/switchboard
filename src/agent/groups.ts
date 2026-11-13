import { uid } from '../shared/ids'
import type { Agent } from './agent'
import { isPlaceholder } from './identity'
import type { GroupMsg } from './llm'
import { redact } from './redact'
import type { ConversationRow, MessageRow } from './store'

interface GroupRequest {
  request_id: string
  channel_id: string
  subject: string
  created_at: number
  status: string
  group_id: string | null
  error: string | null
}

export class Groups {
  constructor(private agent: Agent) {}

  private get store() {
    return this.agent.store
  }
  private get bus() {
    return this.agent.bus
  }

  // ------------------------------------------------------------ lane A: Groups API (8 max, OBA, invite-only)

  async createApiGroup(channelId: string, subject: string) {
    const res = await this.agent.client(channelId).createGroup(subject, 'Created by the EquipXchange agent via the Groups API')
    if (!res.ok) return { ok: false, error: res.error?.message }
    const requestId: string = res.json?.request_id ?? uid('req_local')
    this.store.sql.run("insert into group_requests(request_id, channel_id, subject, created_at, status) values(?,?,?,?, 'pending')", requestId, channelId, subject, Date.now())
    this.bus.log({ kind: 'agent', lane: 'A', title: `Group create requested: "${subject}"`, detail: `request_id ${requestId}; waiting for group_lifecycle_update webhook` })
    this.bus.change('groups')
    return { ok: true, requestId }
  }

  /** group_lifecycle_update webhook: the only place a create succeeds or fails. */
  onLifecycle(channelId: string, g: any) {
    if (g.type === 'group_create') {
      const req =
        (g.request_id && this.store.sql.get<GroupRequest>('select * from group_requests where request_id=?', g.request_id)) ||
        this.store.sql.get<GroupRequest>("select * from group_requests where channel_id=? and subject=? and status='pending' order by created_at desc limit 1", channelId, g.subject ?? '')
      if (g.errors?.length) {
        const err = g.errors.map((e: any) => `#${e.code} ${e.message ?? e.title}`).join('; ')
        if (req) this.store.sql.run("update group_requests set status='failed', error=? where request_id=?", err, req.request_id)
        this.bus.log({ kind: 'agent', lane: 'A', title: 'Group create failed (async)', detail: err })
        this.bus.change('groups')
        return
      }
      if (req) this.store.sql.run("update group_requests set status='created', group_id=? where request_id=?", g.group_id, req.request_id)
      this.store.sql.run(
        `insert into api_groups(group_id, channel_id, subject, invite_link, created_at, participants) values(?,?,?,?,?, '[]')
         on conflict(group_id) do update set invite_link=excluded.invite_link, subject=excluded.subject`,
        g.group_id,
        channelId,
        g.subject ?? req?.subject ?? 'Group',
        g.invite_link ?? null,
        Date.now(),
      )
      this.store.ensureConversation({ channel_id: channelId, kind: 'group', lane: 'A', external_id: g.group_id, title: g.subject ?? req?.subject ?? 'Group', members: 1 })
      this.bus.log({ kind: 'agent', lane: 'A', title: `Group created: "${g.subject}"`, detail: `matched request ${g.request_id}` })
      this.bus.change('groups')
      this.bus.change('conversations')
    } else if (g.type === 'group_delete') {
      this.store.sql.run('delete from api_groups where group_id=?', g.group_id)
      this.bus.change('groups')
    }
  }

  /** group_participants_update webhook. */
  onParticipants(channelId: string, g: any) {
    const row = this.store.sql.get<{ participants: string }>('select participants from api_groups where group_id=?', g.group_id)
    if (!row) return
    const set = new Set<string>(JSON.parse(row.participants))
    const people = (list: any[] = []) => list.map((p) => this.agent.identity.resolveCloud({ channelId, waId: p.wa_id, bsuid: p.user_id }))
    if (g.type === 'group_participants_add') for (const id of people(g.added_participants)) set.add(id)
    if (g.type === 'group_participants_remove') for (const id of people(g.removed_participants)) set.delete(id)
    this.store.sql.run('update api_groups set participants=? where group_id=?', JSON.stringify([...set]), g.group_id)
    const conv = this.store.conversationByExternal(channelId, g.group_id)
    if (conv) {
      this.store.sql.run('update conversations set members=? where id=?', set.size + 1, conv.id)
      const names = (g.added_participants ?? g.removed_participants ?? []).length
      this.store.addMessage({
        conversation_id: conv.id,
        external_id: null,
        dir: 'system',
        sender_person_id: null,
        sender_label: 'system',
        type: 'system',
        text: `${names} participant(s) ${g.type === 'group_participants_add' ? 'joined via invite link' : g.initiated_by === 'business' ? 'removed by the business' : 'left'}`,
        payload: null,
        status: null,
        error: null,
        at: Date.now(),
      })
    }
    this.bus.change('groups')
  }

  async invite(channelId: string, groupId: string, personId: string) {
    const ch = this.agent.cloudChannel(channelId)
    const name = ch.config.inviteTemplate ?? 'group_invite'
    const group = this.store.sql.get<{ subject: string }>('select subject from api_groups where group_id=?', groupId)
    return this.agent.sendDm(
      channelId,
      personId,
      (c, to) => c.sendTemplate(to, name, ch.config.otpLanguage, [{ type: 'body', parameters: [{ type: 'group_id', group_id: groupId }] }]),
      { type: 'template', text: `Invite to "${group?.subject ?? groupId}" (template ${name}, group_id parameter)`, payload: { template: name, groupId } },
    )
  }

  async refresh(channelId: string, groupId: string) {
    return this.agent.client(channelId).getGroup(groupId)
  }

  /** Lane A group message: reply only when mentioned, and only about the business (Meta 2026 AI policy). */
  async onApiGroupMessage(channelId: string, conv: ConversationRow, text: string) {
    if (!/@(northstar|assistant)\b/i.test(text)) return
    const question = text.replace(/@(northstar|assistant)\b/gi, '').trim()
    const a = await this.agent.llm.appAnswer(question || 'help')
    const res = await this.agent.client(channelId).sendGroupText(conv.external_id, a.answer)
    this.store.addMessage({
      conversation_id: conv.id,
      external_id: res.json?.messages?.[0]?.id ?? null,
      dir: 'out',
      sender_person_id: null,
      sender_label: 'agent',
      type: 'text',
      text: a.answer,
      payload: JSON.stringify({ engine: a.engine, inScope: a.inScope }),
      status: res.ok ? 'accepted' : 'failed',
      error: res.ok ? null : JSON.stringify(res.error),
      at: Date.now(),
    })
    this.bus.change('conversations', { id: conv.id })
  }

  // ------------------------------------------------------------ consent (lane B ingestion gate)

  grantConsent(conversationId: string, grantedBy: string, scope: string) {
    this.store.sql.run(
      'insert into consent(conversation_id, granted_by, granted_at, scope) values(?,?,?,?) on conflict(conversation_id) do update set granted_by=excluded.granted_by, granted_at=excluded.granted_at, scope=excluded.scope',
      conversationId,
      grantedBy,
      Date.now(),
      scope,
    )
    this.bus.log({ kind: 'agent', lane: 'B', title: 'Admin consent recorded', detail: `${grantedBy} · ${scope}` })
    this.bus.change('groups')
  }

  revokeConsent(conversationId: string) {
    this.store.sql.run('delete from consent where conversation_id=?', conversationId)
    this.bus.change('groups')
  }

  // ------------------------------------------------------------ digests + Q&A (both lanes, redacted text only)

  private groupMessages(conversationId: string, limit = 200): GroupMsg[] {
    return this.store
      .messages(conversationId, limit)
      .filter((m: MessageRow) => m.dir === 'in' && !m.deleted && m.type !== 'system')
      .map((m) => ({
        id: m.external_id ?? m.id,
        // A sender label can be a phone-number placeholder: never pass identifiers to the model.
        sender: !m.sender_label || isPlaceholder(m.sender_label) ? 'a member' : redact(m.sender_label).text,
        text: m.text,
        at: m.at,
        replyTo: m.payload ? JSON.parse(m.payload).replyTo : undefined,
      }))
  }

  async digest(conversationId: string) {
    const conv = this.store.conversation(conversationId)
    if (!conv) throw new Error('unknown conversation')
    const msgs = this.groupMessages(conversationId)
    const d = await this.agent.llm.digest(conv.title, msgs)
    const id = uid('dig')
    this.store.sql.run("insert into digests(id, conversation_id, created_at, engine, kind, content) values(?,?,?,?, 'digest', ?)", id, conversationId, Date.now(), d.engine, JSON.stringify(d))
    this.bus.change('digests', { conversationId })
    return { id, ...d }
  }

  async ask(conversationId: string, question: string) {
    const conv = this.store.conversation(conversationId)
    if (!conv) throw new Error('unknown conversation')
    const a = await this.agent.llm.ask(conv.title, this.groupMessages(conversationId), question)
    const id = uid('ask')
    this.store.sql.run("insert into digests(id, conversation_id, created_at, engine, kind, question, content) values(?,?,?,?, 'qa', ?, ?)", id, conversationId, Date.now(), a.engine, question, JSON.stringify(a))
    this.bus.change('digests', { conversationId })
    return { id, ...a }
  }
}
