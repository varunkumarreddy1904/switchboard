import { Pause, Play, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Callout, JsonView } from '../components/ui'
import { clock, stream, useWire, type WireEvent } from '../lib/api'

const KINDS: { id: WireEvent['kind']; label: string }[] = [
  { id: 'graph.request', label: 'Graph API calls' },
  { id: 'webhook.out', label: 'Webhook deliveries' },
  { id: 'webhook.in', label: 'Webhook receipt' },
  { id: 'socket.event', label: 'Linked socket' },
  { id: 'agent', label: 'Agent decisions' },
  { id: 'sandbox', label: 'Sandbox' },
]

export function Events() {
  const { events } = useWire()
  const [kinds, setKinds] = useState<Set<string>>(new Set(KINDS.map((k) => k.id)))
  const [lane, setLane] = useState<'all' | 'A' | 'B'>('all')
  const [q, setQ] = useState('')
  const [paused, setPaused] = useState<WireEvent[] | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  const src = paused ?? events
  const list = useMemo(
    () =>
      src
        .filter((e) => kinds.has(e.kind) && (lane === 'all' || e.lane === lane || e.lane === '-') && (!q || `${e.title} ${e.detail ?? ''}`.toLowerCase().includes(q.toLowerCase())))
        .slice(-500)
        .reverse(),
    [src, kinds, lane, q],
  )
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Event log</h1>
          <p>Every Graph API call, signed webhook delivery, linked-socket event and agent decision. Raw payloads stay in memory only and are stripped for live channels.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setPaused(paused ? null : [...events])}>
            {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? 'Resume' : 'Pause'}
          </button>
          <button className="btn ghost" onClick={() => stream.clearLocal()}>
            <Trash2 size={14} /> Clear view
          </button>
        </div>
      </div>
      <div className="row wrap" style={{ marginBottom: 12 }}>
        {KINDS.map((k) => (
          <label key={k.id} className="check badge outline" style={{ padding: '3px 9px' }}>
            <input
              type="checkbox"
              checked={kinds.has(k.id)}
              onChange={(e) => {
                const s = new Set(kinds)
                e.target.checked ? s.add(k.id) : s.delete(k.id)
                setKinds(s)
              }}
              style={{ margin: 0 }}
            />
            {k.label}
          </label>
        ))}
        <select className="select" style={{ width: 150 }} value={lane} onChange={(e) => setLane(e.target.value as any)} aria-label="Lane">
          <option value="all">Both lanes</option>
          <option value="A">Lane A · official</option>
          <option value="B">Lane B · linked</option>
        </select>
        <input className="input" style={{ width: 220 }} placeholder="Filter text" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="card">
        {list.map((e) => (
          <div key={e.id}>
            <div className={`ev ${open === e.id ? 'open' : ''}`} onClick={() => setOpen(open === e.id ? null : e.id)}>
              <span className="faint mono">{clock(e.at)}</span>
              <span className="ev-kind faint">{e.kind}</span>
              <span className="ev-lane">{e.lane !== '-' && <span className={`badge ${e.lane === 'A' ? 'lane-a' : 'lane-b'}`}>{e.lane}</span>}</span>
              <span className="ellipsis">
                <b style={{ fontWeight: 600 }}>{e.title}</b>
                {e.live && <span className="badge crit" style={{ marginLeft: 6 }}>LIVE</span>}
                {e.detail && <span className="muted"> · {e.detail}</span>}
              </span>
              <span style={{ textAlign: 'right' }}>{e.status ? <span className={`badge ${e.status < 300 ? 'good' : 'crit'}`}>{e.status}</span> : null}</span>
            </div>
            {open === e.id && (
              <div className="ev-detail stack">
                {e.detail && <div className="small">{e.detail}</div>}
                {e.headers && <JsonView value={e.headers} />}
                {e.payload !== undefined ? <JsonView value={e.payload} /> : <div className="tiny faint">{e.live ? 'Payload not retained for live traffic.' : 'No payload for this event.'}</div>}
              </div>
            )}
          </div>
        ))}
        {!list.length && <div className="empty">No events yet</div>}
      </div>
      <div style={{ marginTop: 12 }}>
        <Callout kind="plain">
          Read a full flow: send "START" as a persona, then follow <code>webhook.out</code> (signed POST) → <code>webhook.in</code> (signature check, inbox) → <code>agent</code> (onboarding step) → <code>graph.request</code> (reply) → status webhooks.
        </Callout>
      </div>
    </div>
  )
}
