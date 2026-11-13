import { Search, Users } from 'lucide-react'
import { useState } from 'react'
import { Avatar, Callout, Empty } from '../components/ui'
import { fmtPhone, timeAgo, useApi } from '../lib/api'

export function Contacts() {
  const [q, setQ] = useState('')
  const { data } = useApi<any[]>(`/api/contacts${q ? `?q=${encodeURIComponent(q)}` : ''}`, ['contacts', 'conversations', 'onboarding'], [q])
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Contacts</h1>
          <p>Everyone the agent has seen on either lane, with the identifiers that prove who they are. A person reached only by BSUID (Cloud API) and LID (linked device) stays as two records until a phone number links them.</p>
        </div>
        <div className="row" style={{ position: 'relative', width: 260 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, color: 'var(--text-3)' }} />
          <input className="input" style={{ paddingLeft: 30 }} placeholder="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="card">
        {!data?.length ? (
          <Empty icon={<Users size={28} />} title="No contacts yet">
            Contacts appear when a persona messages the official number or posts in a consented group.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Identifiers (kind · value · source)</th>
                  <th>Account</th>
                  <th>Onboarding</th>
                  <th>Messages</th>
                  <th>Last seen</th>
                </tr>
              </thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="row">
                        <Avatar name={p.display_name} size="sm" />
                        <div>
                          <div style={{ fontWeight: 600 }}>{p.display_name}</div>
                          {p.opted_out ? <span className="badge crit">opted out</span> : null}
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="stack" style={{ gap: 3 }}>
                        {p.links.map((l: any) => (
                          <div key={`${l.kind}${l.value}${l.channel_id}`} className="row tiny" style={{ gap: 6 }}>
                            <span className={`badge ${l.kind === 'pn' ? 'good' : l.kind === 'bsuid' ? 'lane-a' : 'lane-b'}`}>{l.kind}</span>
                            <code>{l.kind === 'pn' ? fmtPhone(l.value) : l.value}</code>
                            <span className="faint">{l.source}</span>
                          </div>
                        ))}
                      </div>
                    </td>
                    <td>
                      <span className={`badge ${p.account_status === 'active' ? 'good' : p.account_status === 'onboarding' ? 'warn' : ''}`}>{p.account_status === 'none' ? '—' : p.account_status}</span>
                      {p.role && <div className="tiny faint">{p.role}</div>}
                    </td>
                    <td className="small">{p.onboarding?.[0]?.step ?? <span className="faint">—</span>}</td>
                    <td className="small">{p.messages}</td>
                    <td className="small faint">{p.lastSeen ? timeAgo(p.lastSeen) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div style={{ marginTop: 14 }}>
        <Callout kind="plain">
          <b>Sources:</b> <code>wa_inbound</code> Cloud webhook · <code>otp</code> phone verified in the app · <code>participantAlt</code> phone exposed in a LID group · <code>lidPnMapping</code> / <code>lid-mapping.update</code> mapping learned later · <code>linked_inbound</code> LID only.
        </Callout>
      </div>
    </div>
  )
}
