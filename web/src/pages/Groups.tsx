import { ArrowRight, Building2, Megaphone, MessageSquare, Plus, ShieldCheck, ShieldOff, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { go } from '../Console'
import { Avatar, Callout, CopyField, Empty, LaneBadge, ModeBadge, useAction } from '../components/ui'
import { api, post, timeAgo, useApi } from '../lib/api'

export function Groups() {
  const { data, reload } = useApi<any>('/api/groups', ['groups', 'conversations'])
  const { data: contacts } = useApi<any[]>('/api/contacts', ['contacts'])
  const [subject, setSubject] = useState('')
  const { busy, run } = useAction()
  if (!data) return <div className="page" />

  const communities = data.linked.filter((g: any) => g.kind === 'community')
  const standalone = data.linked.filter((g: any) => g.kind === 'group')
  const children = (id: string) => data.linked.filter((g: any) => g.community_id === id)
  const orphans = data.linked.filter((g: any) => (g.kind === 'community_sub' || g.kind === 'community_announce') && !communities.some((c: any) => c.external_id === g.community_id))

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Groups</h1>
          <p>Official Groups API groups are created by the business, capped at 8 participants including the business number, and need an Official Business Account. Existing groups and Communities can only be read by a linked-device member number.</p>
        </div>
      </div>

      <div className="stack-lg">
        <section className="card">
          <div className="card-head">
            <div className="row">
              <LaneBadge lane="A" />
              <h2>Groups API</h2>
            </div>
          </div>
          <div className="card-body stack-lg">
            <div className="row wrap">
              <input className="input" style={{ maxWidth: 360 }} placeholder="New group subject (max 128 chars)" maxLength={128} value={subject} onChange={(e) => setSubject(e.target.value)} />
              <button
                className="btn primary"
                disabled={!subject.trim() || busy === 'create'}
                onClick={async () => {
                  const r: any = await run('create', () => post('/api/groups/api', { subject }), 'Requested; waiting for group_lifecycle_update webhook')
                  if (r?.ok) setSubject('')
                }}
              >
                <Plus size={15} /> Create group
              </button>
              <span className="tiny faint">Create is asynchronous: the API returns a request_id and the group arrives by webhook.</span>
            </div>
            {data.requests.some((r: any) => r.status !== 'created') && (
              <div className="stack">
                {data.requests
                  .filter((r: any) => r.status !== 'created')
                  .slice(0, 4)
                  .map((r: any) => (
                    <div key={r.request_id} className="row small">
                      <span className={`badge ${r.status === 'failed' ? 'crit' : 'warn'}`}>{r.status}</span>
                      <span>{r.subject}</span>
                      <code className="tiny faint">{r.request_id}</code>
                      {r.error && <span className="tiny" style={{ color: 'var(--crit-text)' }}>{r.error}</span>}
                    </div>
                  ))}
              </div>
            )}
            {!data.api.length ? (
              <Empty title="No Groups API groups yet">Create one above, invite contacts, then join from their phones in the Simulator.</Empty>
            ) : (
              <div className="grid cols-2">
                {data.api.map((g: any) => (
                  <ApiGroupCard key={g.group_id} g={g} contacts={contacts ?? []} />
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div className="row">
              <LaneBadge lane="B" />
              <h2>Linked-device groups and Communities</h2>
            </div>
          </div>
          <div className="card-body stack-lg">
            <Callout kind="lane-b">
              Read through an unofficial linked device on a separate member number. This breaks WhatsApp's Terms of Service and numbers get banned. Each group stays blocked until a group admin's consent is recorded, and blocked messages are dropped without storing content.
            </Callout>
            {!data.linked.length && <Empty title="No linked groups">Link the member number on the Live lab page (sandbox: scan the QR from the Simulator).</Empty>}
            {communities.map((c: any) => (
              <div key={c.id} className="card" style={{ boxShadow: 'none' }}>
                <div className="row" style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
                  <Building2 size={16} />
                  <b>{c.title}</b>
                  <span className="badge">Community · {c.members} members</span>
                  <ModeBadge mode={c.channel?.mode ?? 'sandbox'} />
                  <span className="tiny faint right">The community itself has no chat; messages live in its groups</span>
                </div>
                <div className="stack" style={{ padding: 10 }}>
                  {children(c.external_id).map((g: any) => (
                    <LinkedRow key={g.id} g={g} onChange={reload} />
                  ))}
                </div>
              </div>
            ))}
            {[...standalone, ...orphans].length > 0 && (
              <div className="stack">
                {[...standalone, ...orphans].map((g: any) => (
                  <LinkedRow key={g.id} g={g} onChange={reload} />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function ApiGroupCard({ g, contacts }: { g: any; contacts: any[] }) {
  const [pid, setPid] = useState('')
  const { busy, run } = useAction()
  const n = g.participants.length + 1
  const members = new Set(g.participants.map((p: any) => p.id))
  const candidates = contacts.filter((c) => !members.has(c.id) && c.links.some((l: any) => l.kind === 'pn' || l.kind === 'bsuid'))
  return (
    <div className="card card-pad stack" style={{ boxShadow: 'none' }}>
      <div className="row">
        <Avatar name={g.subject} group />
        <div className="grow">
          <b>{g.subject}</b>
          <div className="tiny faint">created {timeAgo(g.created_at)} ago · id {g.group_id}</div>
        </div>
        {g.conversationId && (
          <button className="btn sm ghost" onClick={() => go('inbox', g.conversationId)}>
            <MessageSquare size={14} /> Chat
          </button>
        )}
      </div>
      <div className="row between small">
        <span>Participants incl. business</span>
        <b>{n} / 8</b>
      </div>
      <div className={`meter ${n >= 8 ? 'full' : ''}`}>
        <div style={{ width: `${(n / 8) * 100}%` }} />
      </div>
      {g.invite_link && <CopyField value={g.invite_link} />}
      <div className="row wrap" style={{ gap: 4 }}>
        {g.participants.map((p: any) => (
          <span key={p.id} className="badge">
            {p.name}
          </span>
        ))}
      </div>
      <div className="row">
        <select className="select" value={pid} onChange={(e) => setPid(e.target.value)} aria-label="Contact to invite">
          <option value="">Invite a contact…</option>
          {candidates.map((c) => (
            <option key={c.id} value={c.id}>
              {c.display_name}
            </option>
          ))}
        </select>
        <button className="btn" disabled={!pid || busy === 'inv'} onClick={async () => (await run('inv', () => post(`/api/groups/api/${g.group_id}/invite`, { personId: pid }), 'Invite template sent'), setPid(''))}>
          <UserPlus size={15} /> Invite
        </button>
      </div>
      {n >= 8 && <div className="tiny" style={{ color: 'var(--crit-text)' }}>Full: further invitees will be refused when they tap Join.</div>}
    </div>
  )
}

function LinkedRow({ g, onChange }: { g: any; onChange: () => void }) {
  const [by, setBy] = useState('')
  const [open, setOpen] = useState(false)
  const { busy, run } = useAction()
  return (
    <div className="card" style={{ boxShadow: 'none', padding: '10px 12px' }}>
      <div className="row wrap">
        {g.kind === 'community_announce' ? <Megaphone size={15} /> : <MessageSquare size={15} />}
        <b>{g.title}</b>
        <span className="badge">{g.kind === 'community_announce' ? 'Announcements · admins post' : g.kind === 'community_sub' ? 'Community group' : 'Group'}</span>
        <span className="tiny faint">{g.members} members</span>
        {g.consent ? (
          <span className="badge good">
            <ShieldCheck size={11} /> consent: {g.consent.granted_by}
          </span>
        ) : (
          <span className="badge warn">
            <ShieldOff size={11} /> blocked{g.blocked ? ` · ${g.blocked} dropped` : ''}
          </span>
        )}
        <span className="right" />
        <button className="btn sm ghost" onClick={() => go('inbox', g.id)}>
          Messages <ArrowRight size={13} />
        </button>
        <button className="btn sm" onClick={() => go('agent', g.id)}>
          Digest
        </button>
        {g.consent ? (
          <button className="btn sm danger" onClick={async () => (await run('rev', () => api(`/api/conversations/${g.id}/consent`, { method: 'DELETE' }), 'Consent revoked'), onChange())}>
            Revoke
          </button>
        ) : (
          <button className="btn sm primary" onClick={() => setOpen(!open)}>
            Record consent
          </button>
        )}
      </div>
      {open && !g.consent && (
        <div className="row" style={{ marginTop: 8 }}>
          <input className="input" placeholder="Admin who agreed (asked outside WhatsApp)" value={by} onChange={(e) => setBy(e.target.value)} />
          <button
            className="btn primary"
            disabled={!by.trim() || busy === 'c'}
            onClick={async () => {
              await run('c', () => post(`/api/conversations/${g.id}/consent`, { grantedBy: by }), 'Consent recorded')
              setOpen(false)
              onChange()
            }}
          >
            Save
          </button>
        </div>
      )}
    </div>
  )
}
