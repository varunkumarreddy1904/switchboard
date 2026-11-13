import { AlertCircle, Bot, CheckCircle2, Clock, Eye, FileText, Inbox as InboxIcon, Lock, Mic, MousePointerClick, RotateCcw, Search, Send, ShieldAlert, Sparkles, Truck } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { go } from '../Console'
import { Avatar, Callout, Empty, Field, LaneBadge, ModeBadge, Tabs, useAction } from '../components/ui'
import { api, duration, fmtPhone, hm, post, timeAgo, useApi } from '../lib/api'

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'dm', label: 'Direct' },
  { id: 'groups', label: 'Groups' },
  { id: 'unread', label: 'Unread' },
  { id: 'resolved', label: 'Resolved' },
] as const

const KIND_LABEL: Record<string, string> = {
  dm: 'Direct',
  group: 'Group',
  community_sub: 'Community group',
  community_announce: 'Announcements',
}

export function Inbox({ activeId }: { activeId?: string }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('all')
  const [channel, setChannel] = useState('')
  const [q, setQ] = useState('')
  const { data: boot } = useApi<any>('/api/bootstrap', ['channels'])
  const path = `/api/conversations?filter=${filter}${channel ? `&channel=${channel}` : ''}${q ? `&q=${encodeURIComponent(q)}` : ''}`
  const { data: list } = useApi<any[]>(path, ['conversations', 'groups'], [path])

  return (
    <div className={`inbox ${activeId ? 'has-active' : ''}`}>
      <section className="inbox-list" aria-label="Conversations">
        <div className="inbox-list-head">
          <div className="row between">
            <h1>Team inbox</h1>
            <span className="tiny faint">{list?.length ?? 0} chats</span>
          </div>
          <div className="row" style={{ position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, color: 'var(--text-3)' }} />
            <input className="input" style={{ paddingLeft: 30 }} placeholder="Search by name or group" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Tabs value={filter} onChange={setFilter} items={FILTERS.map((f) => ({ id: f.id, label: f.label }))} />
          <select className="select" value={channel} onChange={(e) => setChannel(e.target.value)} aria-label="Channel">
            <option value="">All channels</option>
            {(boot?.channels ?? []).map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="conv-items">
          {list && !list.length && (
            <Empty icon={<InboxIcon size={28} />} title="No conversations yet">
              Open the <a href="#/simulator">Simulator</a> and send a message as a persona, or run a scene.
            </Empty>
          )}
          {list?.map((c) => (
            <div key={c.id} className={`conv-item ${c.id === activeId ? 'active' : ''}`} onClick={() => go('inbox', c.id)}>
              <Avatar name={c.title} group={c.kind !== 'dm'} />
              <div className="grow">
                <div className="row">
                  <span className="conv-title ellipsis grow">{c.title}</span>
                </div>
                <div className="conv-preview ellipsis">
                  {c.blocked > 0 && !c.consent ? `${c.blocked} message(s) dropped: no admin consent` : c.last ? `${c.last.dir === 'out' ? 'You: ' : ''}${c.last.type === 'audio' ? `Voice: ${c.last.text || '…'}` : c.last.text || '(deleted)'}` : <span className="faint">No messages</span>}
                </div>
                <div className="row" style={{ marginTop: 4, gap: 5 }}>
                  <LaneBadge lane={c.lane} short />
                  {c.kind !== 'dm' && <span className="badge">{KIND_LABEL[c.kind] ?? c.kind}</span>}
                  {c.channel?.mode === 'live' && <span className="badge crit">LIVE</span>}
                  {c.kind === 'dm' && c.windowOpen === false && <span className="badge warn">Templates only</span>}
                  {c.status === 'resolved' && <span className="badge good">Resolved</span>}
                </div>
              </div>
              <div className="conv-meta">
                <span>{timeAgo(c.last_message_at)}</span>
                {c.unread > 0 && <span className="unread">{c.unread}</span>}
              </div>
            </div>
          ))}
        </div>
      </section>
      {activeId ? <Chat id={activeId} operators={boot?.operators ?? []} /> : <div className="chat"><Empty icon={<MousePointerClick size={28} />} title="Pick a conversation" /></div>}
    </div>
  )
}

function statusIcon(s?: string) {
  if (s === 'accepted') return <Clock size={11} />
  if (s === 'sent') return <Send size={11} />
  if (s === 'delivered') return <Truck size={11} />
  if (s === 'read') return <Eye size={11} />
  if (s === 'failed') return <AlertCircle size={11} />
  return null
}

function Chat({ id, operators }: { id: string; operators: string[] }) {
  const { data, reload } = useApi<any>(`/api/conversations/${id}`, ['conversations', 'groups', 'contacts'], [id])
  const body = useRef<HTMLDivElement>(null)
  const count = data?.messages?.length ?? 0
  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight })
  }, [count, id])
  useEffect(() => {
    if (data?.conversation?.unread > 0) void post(`/api/conversations/${id}/read`)
  }, [data?.conversation?.unread, id])
  if (!data) return <div className="chat" />
  const c = data.conversation
  const isGroup = c.kind !== 'dm'
  const windowLeft = c.windowEndsAt ? c.windowEndsAt - Date.now() : 0

  return (
    <>
      <section className="chat" aria-label="Conversation">
        <div className="chat-head">
          <button className="btn ghost icon mobile-only" onClick={() => go('inbox')} aria-label="Back to conversations">
            ←
          </button>
          <Avatar name={c.title} group={isGroup} />
          <div className="grow">
            <h2 className="ellipsis">{c.title}</h2>
            <div className="tiny faint ellipsis row" style={{ gap: 5, marginTop: 2 }}>
              <LaneBadge lane={c.lane} short />
              <ModeBadge mode={c.channel?.mode ?? 'sandbox'} />
              {c.channel?.name} · {KIND_LABEL[c.kind] ?? c.kind}
              {c.members ? ` · ${c.members} members` : ''}
              {c.kind === 'dm' && (c.windowOpen ? ` · service window closes in ${duration(windowLeft)}` : ' · service window closed')}
            </div>
          </div>
          <Meta conv={c} operators={operators} />
        </div>
        <div className="chat-body" ref={body}>
          {!data.messages.length && <Empty title="No stored messages">{c.lane === 'B' && !c.consent ? 'Ingestion is blocked until an admin consent is recorded.' : 'Messages will appear here as webhooks and socket events arrive.'}</Empty>}
          {data.messages.map((m: any) => (
            <Message key={m.id} m={m} group={isGroup} />
          ))}
        </div>
        <div className="chat-foot">{c.lane === 'B' ? <LinkedFoot conv={c} undecryptable={data.undecryptable} onChange={reload} /> : <Composer conv={c} />}</div>
      </section>
      <aside className="side" aria-label="Details">
        {data.person && <PersonPanel p={data.person} />}
        {data.apiGroup && <ApiGroupPanel g={data.apiGroup} />}
        {c.lane === 'B' && <ConsentPanel conv={c} onChange={reload} />}
      </aside>
    </>
  )
}

function Meta({ conv, operators }: { conv: any; operators: string[] }) {
  const { run } = useAction()
  return (
    <div className="row chat-actions">
      <select className="select" style={{ width: 150 }} value={conv.assignee ?? ''} onChange={(e) => run('assign', () => post(`/api/conversations/${conv.id}/meta`, { assignee: e.target.value || null }), e.target.value ? `Assigned to ${e.target.value}: the bot stays quiet` : 'Unassigned: the bot handles replies')} aria-label="Assignee">
        <option value="">Bot (unassigned)</option>
        {operators.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
      {conv.status === 'open' ? (
        <button className="btn sm" onClick={() => run('resolve', () => post(`/api/conversations/${conv.id}/meta`, { status: 'resolved' }))}>
          <CheckCircle2 size={14} /> Resolve
        </button>
      ) : (
        <button className="btn sm" onClick={() => run('reopen', () => post(`/api/conversations/${conv.id}/meta`, { status: 'open' }))}>
          <RotateCcw size={14} /> Reopen
        </button>
      )}
    </div>
  )
}

const VOICE_PROBLEM: Record<string, string> = {
  too_long: 'Too long: not transcribed',
  unavailable: 'Speech-to-text unavailable',
  empty: 'No speech recognised',
  failed: 'Could not process this voice note',
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

/** A voice note: player (while the recording is kept), language, and the transcript or the words spoken. */
function VoiceNote({ m, out }: { m: any; out: boolean }) {
  const p = m.payload ?? {}
  const problem = VOICE_PROBLEM[p.state]
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row tiny faint" style={{ gap: 5 }}>
        <Mic size={12} /> {out ? 'Voice reply' : 'Voice note'}
        {p.seconds ? ` · ${clock(p.seconds)}` : ''}
        {p.lang ? ` · ${p.lang === 'hi' ? 'Hindi' : 'English'}` : ''}
      </div>
      {m.audio?.state === 'available' && <audio controls preload="none" src={`/api/media/${m.audio.id}`} style={{ width: 250, height: 34 }} />}
      {m.audio?.state === 'deleted' && <div className="tiny faint">Recording deleted after the retention period; transcript kept.</div>}
      {p.state === 'transcribing' && (
        <div className="tiny faint row pulse" style={{ gap: 5 }}>
          <Clock size={11} /> Transcribing…
        </div>
      )}
      {m.text && <div>{m.text}</div>}
      {problem && (
        <div className="tiny" style={{ color: 'var(--warn-text)' }}>
          {problem}
          {p.error ? `: ${p.error}` : ''}
        </div>
      )}
    </div>
  )
}

function Message({ m, group }: { m: any; group: boolean }) {
  if (m.dir === 'system') {
    return (
      <div className="msg sys">
        <div className="bubble">{m.text}</div>
      </div>
    )
  }
  const out = m.dir === 'out'
  const p = m.payload ?? {}
  const err = m.error
  return (
    <div className={`msg ${out ? 'out' : 'in'}`}>
      <div className="bubble">
        {group && !out && <div className="msg-sender">{m.sender_label}</div>}
        {out && m.sender_label === 'agent' && (
          <div className="tiny faint row" style={{ marginBottom: 2 }}>
            <Bot size={11} /> agent
          </div>
        )}
        {m.type === 'audio' ? (
          <VoiceNote m={m} out={out} />
        ) : m.deleted ? (
          <i className="faint">Deleted for everyone: stored text erased</i>
        ) : p.evidence && /image|document/.test(m.type) ? (
          <div className="stack" style={{ gap: 4 }}>
            <a href={`/api/hx/evidence/${p.evidence}`} target="_blank" rel="noreferrer">
              <img src={`/api/hx/evidence/${p.evidence}`} alt={p.evidenceKind ?? 'photo'} style={{ maxWidth: 220, maxHeight: 180, borderRadius: 8, display: 'block' }} loading="lazy" />
            </a>
            <span className="tiny faint">
              {p.evidence} · saved as {String(p.evidenceKind ?? 'photo').replace('_', ' ')}
              {m.text && !m.text.startsWith('[') ? ` · “${m.text}”` : ''}
            </span>
          </div>
        ) : p.location ? (
          <a href={`https://www.openstreetmap.org/?mlat=${p.location.lat}&mlon=${p.location.lng}#map=15/${p.location.lat}/${p.location.lng}`} target="_blank" rel="noreferrer">
            📍 {p.location.name ?? 'Location'} ({p.location.lat.toFixed(4)}, {p.location.lng.toFixed(4)})
          </a>
        ) : (
          m.text
        )}
        {p.buttons && (
          <div className="chips" style={{ marginTop: 6 }}>
            {p.buttons.map((b: any) => (
              <span key={b.id} className="chip">
                {b.title}
              </span>
            ))}
          </div>
        )}
        {p.list && (
          <div className="chips" style={{ marginTop: 6 }}>
            <span className="chip">☰ {p.list.button}</span>
            {p.list.rows.map((r: any) => (
              <span key={r.id} className="chip" style={{ color: 'var(--text-2)' }}>
                {r.title}
              </span>
            ))}
          </div>
        )}
      </div>
      {m.reactions?.length > 0 && <div className="reactions">{m.reactions.join(' ')}</div>}
      <div className="msg-meta">
        <span>{hm(m.at)}</span>
        {m.type === 'template' && (
          <span className="badge accent">
            <FileText size={10} /> template
          </span>
        )}
        {p.replyId && <span className="badge">tapped {p.replyId}</span>}
        {m.type === 'audio' && p.engine && <span className="badge" title="Speech-to-text engine">{p.engine}</span>}
        {m.edited ? <span className="badge">edited</span> : null}
        {m.redactions > 0 && <span className="badge warn">{m.redactions} redacted</span>}
        {p.injection && (
          <span className="badge crit">
            <ShieldAlert size={10} /> injection flagged
          </span>
        )}
        {p.viewOnce && <span className="badge">view-once</span>}
        {p.ephemeral && <span className="badge">disappearing</span>}
        {p.delivery === 'append' && <span className="badge">history sync</span>}
        {out && m.status && (
          <span className={`row ${m.status === 'failed' ? 'status-failed' : ''}`} style={{ gap: 3 }}>
            {statusIcon(m.status)} {m.status}
          </span>
        )}
      </div>
      {err && (
        <div className="msg-err">
          {err.code ? `#${err.code} ` : ''}
          {err.title ?? err.message}
          {err.details && <div className="tiny">{err.details}</div>}
        </div>
      )}
    </div>
  )
}

function Composer({ conv }: { conv: any }) {
  const [mode, setMode] = useState<'text' | 'buttons' | 'template'>('text')
  const [text, setText] = useState('')
  const [buttons, setButtons] = useState(['Yes', 'No', ''])
  const { busy, run } = useAction()
  const isGroup = conv.kind === 'group'
  const closed = conv.kind === 'dm' && !conv.windowOpen
  useEffect(() => {
    if (closed) setMode('template')
  }, [closed])

  const send = async () => {
    const body = mode === 'text' ? { kind: 'text', text } : { kind: 'buttons', text, buttons: buttons.filter(Boolean) }
    const r = await run('send', () => post(`/api/conversations/${conv.id}/send`, body))
    if (r && (r as any).ok !== false) setText('')
  }

  return (
    <div className="stack">
      {closed && (
        <Callout kind="warn" icon={<Lock size={15} />}>
          The 24-hour customer service window is closed. Only approved templates deliver. A free-form send still returns 200, then fails asynchronously with error 131047.
        </Callout>
      )}
      <div className="row between">
        <Tabs
          value={mode}
          onChange={setMode}
          items={[
            { id: 'text', label: 'Text' },
            ...(isGroup ? [] : [{ id: 'buttons' as const, label: 'Quick buttons' }]),
            ...(isGroup ? [] : [{ id: 'template' as const, label: 'Template' }]),
          ]}
        />
        {isGroup && <span className="tiny faint">Groups API: text and templates only, no interactive messages</span>}
      </div>
      {mode === 'template' ? (
        <TemplateSend conv={conv} />
      ) : (
        <>
          {mode === 'buttons' && (
            <div className="row">
              {buttons.map((b, i) => (
                <input key={i} className="input" maxLength={20} placeholder={`Button ${i + 1}`} value={b} onChange={(e) => setButtons(buttons.map((x, j) => (j === i ? e.target.value : x)))} />
              ))}
            </div>
          )}
          <div className="composer">
            <textarea
              className="textarea"
              rows={1}
              placeholder={closed ? 'Free-form will fail outside the window. Try it to see the async failure.' : 'Type a reply…'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <button className="btn primary" disabled={!text.trim() || busy === 'send'} onClick={send}>
              <Send size={15} /> Send
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function TemplateSend({ conv }: { conv: any }) {
  const { data: templates } = useApi<any[]>(`/api/templates?channel=${conv.channel_id}`, ['templates'], [conv.channel_id])
  const usable = (templates ?? []).filter((t) => t.status === 'APPROVED' && t.category !== 'AUTHENTICATION' && t.name !== 'group_invite')
  const [name, setName] = useState('')
  const t = usable.find((x) => x.name === name) ?? usable[0]
  const bodyText: string = t?.components?.find((c: any) => c.type === 'BODY')?.text ?? ''
  const nParams = (bodyText.match(/\{\{\d+\}\}/g) ?? []).length
  const [params, setParams] = useState<string[]>([])
  const { busy, run } = useAction()
  const preview = useMemo(() => bodyText.replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] || `{{${n}}}`), [bodyText, params])
  if (!templates) return <div className="tiny faint">Loading templates…</div>
  if (!usable.length) return <div className="tiny faint">No approved templates. Create one on the Templates page.</div>
  return (
    <div className="stack">
      <div className="row wrap">
        <select className="select" style={{ maxWidth: 220 }} value={t?.name} onChange={(e) => (setName(e.target.value), setParams([]))}>
          {usable.map((x) => (
            <option key={x.name} value={x.name}>
              {x.name} · {x.category.toLowerCase()}
            </option>
          ))}
        </select>
        {Array.from({ length: nParams }, (_, i) => (
          <input key={i} className="input" style={{ maxWidth: 170 }} placeholder={`{{${i + 1}}}`} value={params[i] ?? ''} onChange={(e) => setParams((p) => Object.assign([...p], { [i]: e.target.value }))} />
        ))}
        <button
          className="btn primary"
          disabled={busy === 'tpl' || params.filter(Boolean).length < nParams}
          onClick={() => run('tpl', () => post(`/api/conversations/${conv.id}/send`, { kind: 'template', name: t.name, language: t.language, params }), 'Template sent')}
        >
          <Send size={15} /> Send template
        </button>
      </div>
      <div className="tiny faint">Preview: {preview}</div>
    </div>
  )
}

function LinkedFoot({ conv, undecryptable }: { conv: any; undecryptable: number; onChange: () => void }) {
  return (
    <div className="row wrap">
      <Callout kind="lane-b" icon={<Lock size={15} />}>
        Read-only: this lane uses an unofficial linked device, so the agent never posts here. {undecryptable > 0 && `${undecryptable} undecryptable message(s) on this channel.`}
      </Callout>
      <button className="btn" onClick={() => go('agent', conv.id)}>
        <Sparkles size={15} /> Digest & ask
      </button>
    </div>
  )
}

function PersonPanel({ p }: { p: any }) {
  const { run } = useAction()
  return (
    <div className="stack-lg">
      <div className="row">
        <Avatar name={p.display_name} size="lg" />
        <div className="grow">
          <div style={{ fontWeight: 650 }}>{p.display_name}</div>
          <div className="row" style={{ gap: 5, marginTop: 3 }}>
            <span className={`badge ${p.account_status === 'active' ? 'good' : p.account_status === 'onboarding' ? 'warn' : ''}`}>{p.account_status === 'none' ? 'no account' : p.account_status}</span>
            {p.opted_out ? <span className="badge crit">opted out</span> : null}
          </div>
        </div>
      </div>
      <div>
        <h3>Profile</h3>
        <dl className="kv">
          <dt>Role</dt>
          <dd>{p.role ?? '—'}</dd>
          <dt>Digest</dt>
          <dd>{p.cadence ?? '—'}</dd>
          <dt>Messages</dt>
          <dd>{p.messages}</dd>
          <dt>Last seen</dt>
          <dd>{p.lastSeen ? timeAgo(p.lastSeen) : '—'}</dd>
        </dl>
      </div>
      <IdentityLinks links={p.links} />
      {p.onboarding?.length > 0 && (
        <div>
          <h3>Onboarding</h3>
          {p.onboarding.map((o: any) => (
            <div key={o.channel_id} className="row tiny">
              <span className="badge">{o.step}</span> <span className="faint">{timeAgo(o.updated_at)} ago</span>
            </div>
          ))}
        </div>
      )}
      <button className="btn sm" onClick={() => run('opt', () => post(`/api/contacts/${p.id}`, { optedOut: !p.opted_out }))}>
        {p.opted_out ? 'Opt back in' : 'Mark opted out'}
      </button>
    </div>
  )
}

export function IdentityLinks({ links }: { links: any[] }) {
  return (
    <div>
      <h3>Identity links</h3>
      <div className="stack" style={{ gap: 5 }}>
        {links.map((l) => (
          <div key={`${l.kind}${l.value}${l.channel_id}`} className="link-row" title={`source: ${l.source} · channel ${l.channel_id}`}>
            <span className={`badge ${l.kind === 'pn' ? 'good' : l.kind === 'bsuid' ? 'lane-a' : 'lane-b'}`}>{l.kind}</span>
            <code className="grow ellipsis">{l.kind === 'pn' ? fmtPhone(l.value) : l.value}</code>
            <span className="tiny faint">{l.source}</span>
          </div>
        ))}
      </div>
      <div className="tiny faint" style={{ marginTop: 6 }}>
        Only a phone number joins Cloud (bsuid) and linked (lid) identities.
      </div>
    </div>
  )
}

function ApiGroupPanel({ g }: { g: any }) {
  const n = g.participants.length + 1
  return (
    <div className="stack">
      <h3>Groups API group</h3>
      <div className="row between small">
        <span>Participants (incl. business)</span>
        <b>{n} / 8</b>
      </div>
      <div className={`meter ${n >= 8 ? 'full' : ''}`}>
        <div style={{ width: `${(n / 8) * 100}%` }} />
      </div>
      {g.invite_link && <code className="tiny ellipsis">{g.invite_link}</code>}
      {g.participants.map((p: any) => (
        <div key={p.id} className="row small">
          <Avatar name={p.name ?? '?'} size="sm" /> {p.name}
        </div>
      ))}
      <a className="btn sm" href="#/groups">
        Manage group
      </a>
    </div>
  )
}

function ConsentPanel({ conv, onChange }: { conv: any; onChange: () => void }) {
  const [by, setBy] = useState('')
  const { busy, run } = useAction()
  return (
    <div className="stack">
      <h3>Admin consent</h3>
      {conv.consent ? (
        <>
          <Callout kind="info" icon={<CheckCircle2 size={15} />}>
            Recorded from <b>{conv.consent.granted_by}</b> {timeAgo(conv.consent.granted_at)} ago. Scope: {conv.consent.scope}.
          </Callout>
          <button className="btn sm danger" onClick={async () => (await run('revoke', () => api(`/api/conversations/${conv.id}/consent`, { method: 'DELETE' }), 'Consent revoked'), onChange())}>
            Revoke consent
          </button>
        </>
      ) : (
        <>
          <Callout kind="warn">No consent on record: {conv.blocked} message(s) dropped without storing their content.</Callout>
          <Field label="Group admin who agreed" hint="Ask the admin outside WhatsApp and mention the AI reader in the group description.">
            <input className="input" value={by} onChange={(e) => setBy(e.target.value)} placeholder="e.g. Grace Kim" />
          </Field>
          <button className="btn primary sm" disabled={!by.trim() || busy === 'consent'} onClick={async () => (await run('consent', () => post(`/api/conversations/${conv.id}/consent`, { grantedBy: by }), 'Consent recorded'), onChange())}>
            Record consent
          </button>
        </>
      )}
    </div>
  )
}
