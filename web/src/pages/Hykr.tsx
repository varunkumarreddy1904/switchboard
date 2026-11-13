import { AlertTriangle, BadgeCheck, Camera, CheckCircle2, ClipboardCheck, Clock, ExternalLink, Gauge, MapPin, MessageSquare, Search, ShieldCheck, Trash2, UserPlus, Users, XCircle } from 'lucide-react'
import { useState } from 'react'
import { go } from '../Console'
import { Callout, Empty, Field, Tabs, useAction } from '../components/ui'
import { del, post, timeAgo, useApi } from '../lib/api'

/**
 * PoC #12 (HYKR / EquipXchange) desk pages: owners, the verification queue (a stand-in for PoC #6's
 * sign-off) and the funnel + reply speed. Data comes from /api/hx (console only, never through the tunnel).
 */

const KIND: Record<string, string> = {
  machine: 'Machine',
  rc: 'RC',
  invoice: 'Invoice',
  insurance: 'Insurance',
  pin_plate: 'PIN plate',
  hour_meter: 'Hour meter',
  video: 'Video',
  relationship_proof: 'Relationship proof',
  paper_form: 'Paper consent form',
  rc_unreadable: 'RC (unreadable)',
  other: 'Other',
}
const FLAG: Record<string, string> = {
  no_papers: 'No RC and no invoice: inspect in person (Path B, lowest assurance)',
  insurance_later: 'Insurance photo not sent yet',
  insurance_expired: 'Insurance expired: no dispatch until renewed',
  pin_plate_missing: 'PIN plate photo missing',
  rc_in_family_name: 'RC in a family member’s name: check the relationship proof',
  rc_other_person: 'RC in someone else’s name: confirm who owns the machine',
  relationship_proof_later: 'Relationship proof not sent yet',
  no_papers_consent: 'Owner has not agreed to share papers (C2)',
  owner_denied_mitra: 'Owner said the Mitra registration is wrong',
}
const STATUS: Record<string, string> = { draft: '', pending: 'warn', needs_info: 'crit', active: 'good', rejected: 'crit', paused: '' }
const rupees = (p: number | null) => (p == null ? '—' : `₹${Math.round(p / 100).toLocaleString('en-IN')}`)
const when = (t: number | null) => (t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—')

function Photos({ evidence, big }: { evidence: any[]; big?: boolean }) {
  if (!evidence?.length) return <div className="tiny faint">No photos yet</div>
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${big ? 150 : 96}px, 1fr))`, gap: 8 }}>
      {evidence.map((e) => (
        <a key={e.id} href={e.url} target="_blank" rel="noreferrer" title={`${e.id} · ${KIND[e.kind] ?? e.kind}${e.read?.relabelled_from ? ` (sent as ${KIND[e.read.relabelled_from]})` : ''}`} style={{ position: 'relative', display: 'block', aspectRatio: '4/3', borderRadius: 8, overflow: 'hidden', background: 'var(--surface-3)' }}>
          {/^image\//.test(e.mime) ? (
            <img src={e.url} alt={KIND[e.kind] ?? e.kind} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          ) : (
            <div className="row" style={{ height: '100%', justifyContent: 'center' }}>
              <Camera size={18} /> {e.mime}
            </div>
          )}
          <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,.6)', color: '#fff', fontSize: 11, padding: '2px 6px' }}>
            {KIND[e.kind] ?? e.kind}
            {e.read?.relabelled_from ? ' ↺' : ''}
          </span>
        </a>
      ))}
    </div>
  )
}

/** What each photo said, as read by Claude (or the sandbox's known contents). */
function Reads({ evidence }: { evidence: any[] }) {
  const rows = (evidence ?? []).filter((e) => e.read)
  if (!rows.length) return null
  return (
    <table className="table" style={{ marginTop: 8 }}>
      <thead>
        <tr>
          <th>Photo</th>
          <th>Read as</th>
          <th>Fields</th>
          <th>By</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => (
          <tr key={e.id}>
            <td className="tiny">
              {e.id}
              <br />
              <span className="faint">sent as {KIND[e.read.relabelled_from ?? e.kind] ?? e.kind}</span>
            </td>
            <td>
              {KIND[e.read.kind] ?? e.read.kind} {e.read.readable === false && <span className="badge crit">unreadable</span>}
            </td>
            <td className="tiny">
              {Object.entries(e.read.fields ?? {})
                .filter(([, v]) => v)
                .map(([k, v]) => `${k}: ${v}`)
                .join(' · ') || '—'}
            </td>
            <td className="tiny faint">{e.readEngine}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function MachineFacts({ m }: { m: any }) {
  return (
    <dl className="kv">
      <dt>Machine</dt>
      <dd style={{ textTransform: 'capitalize' }}>{m.label || m.classLabel}</dd>
      <dt>Year</dt>
      <dd>{m.year ?? '—'}</dd>
      <dt>Registration</dt>
      <dd>{m.reg_no ?? (m.reg_status === 'unregistered' ? 'Unregistered' : '—')}</dd>
      <dt>PIN</dt>
      <dd className="mono">{m.pin ?? '—'}</dd>
      <dt>Engine no.</dt>
      <dd className="mono">{m.engine_no ?? '—'}</dd>
      <dt>Name on RC</dt>
      <dd>
        {m.rc_owner_name ?? '—'}
        {m.relationship && <span className="badge">{m.relationship}</span>}
      </dd>
      <dt>Insurance till</dt>
      <dd>{m.insurance_expiry ?? '—'}</dd>
      <dt>Hour meter</dt>
      <dd>{m.hour_reading ? `${m.hour_reading} h` : '—'}</dd>
      <dt>Based at</dt>
      <dd>
        {m.base_label ?? '—'}
        {m.base_lat != null && (
          <a className="tiny" href={`https://www.openstreetmap.org/?mlat=${m.base_lat}&mlon=${m.base_lng}#map=14/${m.base_lat}/${m.base_lng}`} target="_blank" rel="noreferrer">
            {' '}
            <MapPin size={11} /> {m.base_lat}, {m.base_lng}
          </a>
        )}
      </dd>
      <dt>Lowest rate</dt>
      <dd>
        {rupees(m.rate_hour)}/h{m.rate_day ? ` · ${rupees(m.rate_day)}/day` : ''}
      </dd>
      <dt>Diesel · travel</dt>
      <dd>
        {m.diesel === 'owner' ? 'owner provides' : m.diesel === 'customer' ? 'customer provides' : '—'} · {m.radius_km ? `${m.radius_km} km` : '—'}
      </dd>
    </dl>
  )
}

function Flags({ flags }: { flags: string[] }) {
  const f = (flags ?? []).filter((x) => FLAG[x])
  if (!f.length) return null
  return (
    <div className="stack" style={{ gap: 4 }}>
      {f.map((x) => (
        <div key={x} className="row tiny" style={{ color: 'var(--warn-text)' }}>
          <AlertTriangle size={12} /> {FLAG[x]}
        </div>
      ))}
    </div>
  )
}

// ====================================================================== owners

export function HxOwners({ id }: { id?: string }) {
  if (id) return <OwnerDetail id={id} />
  return <OwnerList />
}

function OwnerList() {
  const [q, setQ] = useState('')
  const { data } = useApi<any[]>(`/api/hx/owners?q=${encodeURIComponent(q)}`, ['hykr', 'contacts', 'conversations'], [q])
  const people = (data ?? []).filter((p) => !p.roles.includes('mitra'))
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Owners</h1>
          <p>Machine owners registering on WhatsApp for EquipXchange (PoC #12). Each row is one person record (P-…) with their machines (M-…), consents (C-…) and evidence (E-…), in the shared kit’s format.</p>
        </div>
        <a className="btn" href={`${location.protocol}//${location.hostname}:5175`} target="_blank" rel="noreferrer">
          <ExternalLink size={14} /> HYKR app
        </a>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr)', gap: 14 }}>
        <div className="card">
          <div className="card-head">
            <div className="row" style={{ flex: 1, maxWidth: 360 }}>
              <Search size={14} />
              <input className="input" placeholder="Search name, phone, village, ID" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <span className="tiny faint">{people.length} owners</span>
          </div>
          <div className="card-body" style={{ padding: 0, marginTop: 10 }}>
            {!people.length ? (
              <Empty icon={<Users size={26} />} title="No owners yet">
                Message the business number from the Simulator (Ravi Kumar, Srinivas Rao …) or a real phone.
              </Empty>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Owner</th>
                    <th>Village</th>
                    <th>Machines</th>
                    <th>Where they are</th>
                    <th>Joined via</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.id} style={{ cursor: 'pointer' }} onClick={() => go('hx-owners', p.id)}>
                      <td>
                        <b>{p.name ?? '(no name yet)'}</b>
                        <div className="tiny faint">
                          {p.id} · {p.phone ?? 'hidden number'}
                        </div>
                      </td>
                      <td>{p.village ?? '—'}</td>
                      <td>
                        {p.machines}
                        {p.live > 0 && <span className="badge good"> {p.live} live</span>}
                        {p.pending > 0 && <span className="badge warn"> {p.pending} to check</span>}
                      </td>
                      <td className="small">
                        <span className={`badge ${p.status === 'paused' ? 'crit' : p.status === 'active' ? 'good' : 'warn'}`}>{p.status}</span> {p.next ?? '—'}
                      </td>
                      <td className="small">{String(p.created_by ?? '').startsWith('mitra') ? 'Mitra (paper form)' : 'WhatsApp'}</td>
                      <td className="small faint">{timeAgo(p.flow_at ?? p.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <Mitras />
      </div>
    </div>
  )
}

function Mitras() {
  const { data, reload } = useApi<any[]>('/api/hx/mitras', ['hykr'])
  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const { busy, run } = useAction()
  return (
    <div className="card card-pad stack">
      <div className="row">
        <UserPlus size={16} />
        <b>Mitras (field partners)</b>
        <span className="tiny faint">Their WhatsApp number gets the “register an owner from a paper form” path.</span>
      </div>
      <div className="row wrap">
        {(data ?? []).map((m) => (
          <span key={m.phone} className="badge outline">
            {m.name} · +{m.phone}
            <button className="btn ghost sm" aria-label={`Remove ${m.name}`} onClick={async () => (await run('rm', () => del(`/api/hx/mitras/${m.phone}`)), reload())}>
              <Trash2 size={11} />
            </button>
          </span>
        ))}
      </div>
      <div className="row wrap">
        <input className="input" style={{ maxWidth: 200 }} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" style={{ maxWidth: 220 }} placeholder="+91 WhatsApp number" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <button className="btn" disabled={busy === 'add' || phone.replace(/\D/g, '').length < 10} onClick={async () => (await run('add', () => post('/api/hx/mitras', { phone, name }), 'Mitra added'), setPhone(''), setName(''), reload())}>
          Add Mitra
        </button>
      </div>
    </div>
  )
}

function OwnerDetail({ id }: { id: string }) {
  const { data } = useApi<any>(`/api/hx/owners/${id}`, ['hykr', 'contacts', 'conversations'], [id])
  if (!data) return <div className="page" />
  const p = data.person
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <a className="small" href="#/hx-owners">
            ← Owners
          </a>
          <h1>{p.name ?? p.id}</h1>
          <p>
            {p.id} · {p.phone ?? 'hidden number'} · {p.village ?? '—'} · {p.roles.join(', ')} · KYC level {p.kyc_level} · <span className={`badge ${p.status === 'active' ? 'good' : 'warn'}`}>{p.status}</span>
          </p>
        </div>
        {data.conversationId && (
          <button className="btn" onClick={() => go('inbox', data.conversationId)}>
            <MessageSquare size={14} /> Open chat
          </button>
        )}
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', alignItems: 'start' }}>
        <div className="stack-lg">
          {data.flow && (
            <Callout kind="info" icon={<Clock size={16} />}>
              <b>Next:</b> {data.flow.next} <span className="tiny faint">(step “{data.flow.step}”, {data.flow.role}, updated {timeAgo(data.flow.updated_at)})</span>
            </Callout>
          )}
          {data.machines.map((m: any) => (
            <div key={m.id} className="card card-pad stack">
              <div className="row between">
                <b style={{ textTransform: 'capitalize' }}>
                  {m.id} · {m.label || m.classLabel}
                </b>
                <span className={`badge ${STATUS[m.status] ?? ''}`}>{m.statusLabel}</span>
              </div>
              {m.desk_note && <div className="tiny">Desk note: {m.desk_note}</div>}
              <Photos evidence={m.evidence} />
              <MachineFacts m={m} />
              <Flags flags={m.flags} />
              <Reads evidence={m.evidence} />
            </div>
          ))}
          {!data.machines.length && <div className="card card-pad faint">No machines yet.</div>}
        </div>
        <div className="stack-lg">
          <div className="card card-pad stack">
            <b>Consents</b>
            {data.consents.map((c: any) => (
              <div key={c.id} className="small">
                <span className={`badge ${c.withdrawn_at ? 'crit' : 'good'}`}>{c.purpose}</span> {c.channel} · {c.wording_version} · {when(c.given_at)}
                {c.withdrawn_at && ` · withdrawn ${when(c.withdrawn_at)}`}
                <div className="tiny faint">
                  {c.id} · “{c.answer}”{c.evidence_id ? ` · evidence ${c.evidence_id}` : ''}
                </div>
              </div>
            ))}
            {!data.consents.length && <span className="tiny faint">None</span>}
          </div>
          {data.delegates.length > 0 && (
            <div className="card card-pad stack">
              <b>Managers</b>
              {data.delegates.map((d: any) => (
                <div key={d.phone} className="small">
                  {d.name ?? 'Manager'} · +{d.phone}
                </div>
              ))}
            </div>
          )}
          <div className="card card-pad stack">
            <b>History</b>
            <div className="tiny faint">Events in the shared kit’s envelope (type, actor, trace, rules version).</div>
            {data.events.map((e: any) => (
              <div key={e.id} className="small" style={{ borderLeft: '2px solid var(--border)', paddingLeft: 8 }}>
                <b>{e.type}</b> <span className="faint tiny">{when(e.occurred_at)}</span>
                <div className="tiny faint">
                  {e.actor} · {e.machine_id ?? e.person_id} · {e.rules_version}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ====================================================================== verification

const ASK_KINDS = [
  ['rc', 'Clear RC photo'],
  ['insurance', 'Insurance photo'],
  ['pin_plate', 'PIN plate photo'],
  ['hour_meter', 'Hour meter photo'],
  ['machine', 'Machine photo'],
  ['relationship_proof', 'Relationship proof'],
  ['invoice', 'Purchase invoice'],
  ['other', 'Something else'],
] as const

export function HxVerify() {
  const [tab, setTab] = useState<'queue' | 'active' | 'all'>('queue')
  const { data } = useApi<any[]>(`/api/hx/machines?status=${tab}`, ['hykr'], [tab])
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Verification</h1>
          <p>Every machine is checked by a person before it goes live (the stand-in for PoC #6’s sign-off). Approving or asking for more messages the owner on WhatsApp straight away: free text inside the 24-hour window, an approved template outside it. Machines sent to the EquipXchange app are decided on the app’s desk; this page shows its decision.</p>
        </div>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'queue', label: 'To check' },
          { id: 'active', label: 'Live' },
          { id: 'all', label: 'All' },
        ]}
      />
      <div className="stack-lg" style={{ marginTop: 14 }}>
        {!data?.length && (
          <Empty icon={<ClipboardCheck size={26} />} title={tab === 'queue' ? 'Nothing to check' : 'No machines'}>
            Submitted machines appear here.
          </Empty>
        )}
        {(data ?? []).map((m) => (
          <VerifyCard key={m.id} m={m} />
        ))}
      </div>
    </div>
  )
}

function VerifyCard({ m }: { m: any }) {
  const { busy, run } = useAction()
  const [askKind, setAskKind] = useState<string>('rc')
  const [note, setNote] = useState('')
  const [reason, setReason] = useState('')
  const [mode, setMode] = useState<'none' | 'ask' | 'reject'>('none')
  const decided = m.status === 'active' || m.status === 'rejected'
  return (
    <div className="card card-pad stack">
      <div className="row between wrap">
        <div>
          <b style={{ textTransform: 'capitalize' }}>{m.label || m.classLabel}</b>{' '}
          <span className={`badge ${STATUS[m.status] ?? ''}`}>{m.statusLabel}</span>
          <div className="tiny faint">
            {m.id} · owner{' '}
            <a href={`#/hx-owners/${m.owner.id}`}>
              {m.owner.name} ({m.owner.id})
            </a>{' '}
            · {m.owner.village ?? '—'} · submitted {timeAgo(m.submitted_at)}
          </div>
        </div>
        {!decided && !m.decidedIn && (
          <div className="row wrap">
            <button className="btn primary" disabled={!!busy} onClick={() => run('ok', () => post(`/api/hx/machines/${m.id}/approve`, { by: 'desk' }), 'Approved: the owner has been told')}>
              <BadgeCheck size={14} /> Approve
            </button>
            <button className="btn" onClick={() => setMode(mode === 'ask' ? 'none' : 'ask')}>
              <Camera size={14} /> Ask for more
            </button>
            <button className="btn danger" onClick={() => setMode(mode === 'reject' ? 'none' : 'reject')}>
              <XCircle size={14} /> Reject
            </button>
          </div>
        )}
      </div>
      {m.decidedIn && (
        <Callout icon={<ExternalLink size={16} />}>
          Checked in {m.decidedIn.app}
          {m.decidedIn.code ? ` as ${m.decidedIn.code}` : ''}. Approve, ask for more or reject on the app’s desk (
          <a href={`${m.decidedIn.url}/ops/supply`} target="_blank" rel="noreferrer">
            Supply → To verify
          </a>
          ). Its decision shows here, and the owner’s reply on WhatsApp goes back to it.
        </Callout>
      )}
      {m.desk_note && <div className="tiny">Desk note: {m.desk_note}</div>}
      {m.driver && (
        <div className="tiny">
          Driver: {m.driver.name ?? 'name not given'} (+{m.driver.phone})
        </div>
      )}
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,3fr) minmax(0,2fr)', alignItems: 'start' }}>
        <Photos evidence={m.evidence} big />
        <div className="stack">
          <MachineFacts m={m} />
          <Flags flags={m.flags} />
        </div>
      </div>
      <Reads evidence={m.evidence} />
      {mode === 'ask' && (
        <div className="row wrap">
          <select className="select" value={askKind} onChange={(e) => setAskKind(e.target.value)} aria-label="What to ask for">
            {ASK_KINDS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Note to the owner (optional), e.g. “the RC photo is cut off at the bottom”" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn primary" disabled={!!busy} onClick={async () => (await run('ask', () => post(`/api/hx/machines/${m.id}/ask`, { kind: askKind, note, by: 'desk' }), 'Owner asked on WhatsApp'), setMode('none'))}>
            Send request
          </button>
        </div>
      )}
      {mode === 'reject' && (
        <div className="row wrap">
          <input className="input" style={{ flex: 1, minWidth: 200 }} placeholder="Reason the owner will see, e.g. “the RC is cancelled”" value={reason} onChange={(e) => setReason(e.target.value)} />
          <button className="btn danger" disabled={!!busy || !reason.trim()} onClick={async () => (await run('rej', () => post(`/api/hx/machines/${m.id}/reject`, { reason, by: 'desk' }), 'Rejected: the owner has been told'), setMode('none'))}>
            Reject machine
          </button>
        </div>
      )}
    </div>
  )
}

// ====================================================================== funnel and speed

const STEP_LABEL: Record<string, string> = {
  c1: 'Shown consent C1',
  name: 'Name',
  village: 'Village',
  role: 'Drives it?',
  c2: 'Consent C2 (papers)',
  class: 'Machine type',
  photo_machine: 'Machine photo',
  rc: 'RC',
  insurance: 'Insurance',
  pin_plate: 'PIN plate',
  hour_meter: 'Hour meter',
  location: 'Location',
  video: 'Video (optional)',
  details: 'Read-back',
  rate_hour: 'Rate / hour',
  rate_day: 'Rate / day',
  diesel: 'Diesel',
  radius: 'Travel distance',
  summary: 'Summary',
  submitted: 'Submitted',
  verified: 'Verified (live)',
}
const TARGET: Record<string, number> = { tap: 1000, text: 2000, voice: 3000, photo: 2000, location: 1500 }

export function HxFunnel() {
  const { data: f } = useApi<any>('/api/hx/funnel', ['hykr'])
  const { data: sp } = useApi<any>('/api/hx/speed', ['conversations', 'hykr'])
  const top = Math.max(1, ...(f?.steps ?? []).map((s: any) => s.reached))
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Funnel and speed</h1>
          <p>Where owners drop off during WhatsApp registration, and how fast the bot answers: from Meta’s webhook reaching us to our first reply being accepted by Meta (WhatsApp delivery to the phone comes on top).</p>
        </div>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', alignItems: 'start' }}>
        <div className="card card-pad stack">
          <div className="row">
            <Users size={16} />
            <b>Drop-off by step</b>
            <span className="tiny faint">
              {f?.owners ?? 0} owners · {f?.declined ?? 0} declined consent
            </span>
          </div>
          {(f?.steps ?? []).map((s: any) => (
            <div key={s.step} className="row" style={{ gap: 10 }}>
              <span className="small" style={{ width: 130, flex: 'none' }}>
                {STEP_LABEL[s.step] ?? s.step}
              </span>
              <div style={{ flex: 1, background: 'var(--surface-3)', borderRadius: 4, height: 14 }}>
                <div style={{ width: `${(100 * s.reached) / top}%`, background: s.step === 'verified' ? 'var(--good)' : 'var(--accent)', height: 14, borderRadius: 4 }} />
              </div>
              <span className="small" style={{ width: 32, textAlign: 'right' }}>
                {s.reached}
              </span>
            </div>
          ))}
          <div className="row wrap tiny">
            {Object.entries(f?.machines ?? {}).map(([k, v]) => (
              <span key={k} className="badge outline">
                {k}: {String(v)}
              </span>
            ))}
          </div>
        </div>
        <div className="card card-pad stack">
          <div className="row">
            <Gauge size={16} />
            <b>Reply speed (last 24 h)</b>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>Owner sent</th>
                <th>Replies</th>
                <th>Median</th>
                <th>95th %</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(sp?.kinds ?? {}).map(([k, v]: [string, any]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v.n}</td>
                  <td>{v.p50 != null ? `${(v.p50 / 1000).toFixed(2)} s` : '—'}</td>
                  <td>{v.p95 != null ? `${(v.p95 / 1000).toFixed(2)} s` : '—'}</td>
                  <td>
                    {TARGET[k] ? (
                      <span className={`badge ${v.p50 != null && v.p50 <= TARGET[k] ? 'good' : 'warn'}`}>
                        {v.p50 != null && v.p50 <= TARGET[k] ? <CheckCircle2 size={11} /> : <AlertTriangle size={11} />} under {TARGET[k] / 1000} s
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!Object.keys(sp?.kinds ?? {}).length && <div className="tiny faint">No replies measured yet.</div>}
          <div className="tiny faint">
            <ShieldCheck size={11} /> Recent replies (stage times from the webhook):
          </div>
          <div className="stack" style={{ gap: 4, maxHeight: 320, overflowY: 'auto' }}>
            {(sp?.recent ?? []).map((r: any) => (
              <div key={r.id} className="row tiny" style={{ gap: 8 }}>
                <span className="badge outline">{r.kind}</span>
                <b>{(r.total_ms / 1000).toFixed(2)} s</b>
                <span className="faint">
                  {Object.entries(r.marks)
                    .map(([k, v]) => `${k} ${v} ms`)
                    .join(' · ')}
                </span>
                <span className="faint" style={{ marginLeft: 'auto' }}>
                  {timeAgo(r.at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

