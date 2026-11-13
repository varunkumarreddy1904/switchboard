import { CheckCircle2, Megaphone, Send, XCircle } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Callout, Empty, Field, useAction } from '../components/ui'
import { post, timeAgo, useApi } from '../lib/api'

const PRICING: Record<string, string> = {
  MARKETING: 'Billed per delivered message',
  UTILITY: 'Free inside an open service window, otherwise billed',
  AUTHENTICATION: 'Billed per delivered message',
}

export function Broadcasts() {
  const { data: boot } = useApi<any>('/api/bootstrap', ['channels'])
  const clouds = (boot?.channels ?? []).filter((c: any) => c.kind === 'cloud')
  const [channelId, setChannelId] = useState('sbx-cloud')
  const { data: templates } = useApi<any[]>(`/api/templates?channel=${channelId}`, ['templates'], [channelId])
  const { data: contacts } = useApi<any[]>('/api/contacts', ['contacts'])
  const { data: history, reload } = useApi<any[]>('/api/broadcasts', ['broadcasts'])
  const usable = (templates ?? []).filter((t) => t.status === 'APPROVED' && t.category !== 'AUTHENTICATION' && t.name !== 'group_invite')
  const [name, setName] = useState('')
  const t = usable.find((x) => x.name === name) ?? usable[0]
  const bodyText: string = t?.components?.find((c: any) => c.type === 'BODY')?.text ?? ''
  const n = (bodyText.match(/\{\{\d+\}\}/g) ?? []).length
  const [params, setParams] = useState<string[]>(['{{name}}', '3'])
  const reachable = useMemo(
    () => (contacts ?? []).filter((p) => p.links.some((l: any) => l.kind === 'pn' || (l.kind === 'bsuid' && l.channel_id === channelId))),
    [contacts, channelId],
  )
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [results, setResults] = useState<any[] | null>(null)
  const { busy, run } = useAction()

  const send = async () => {
    const r: any = await run('send', () => post('/api/broadcasts', { channelId, template: t.name, language: t.language, params: params.slice(0, n), personIds: [...picked] }))
    if (r?.ok) {
      setResults(r.results)
      reload()
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Broadcasts</h1>
          <p>Send an approved template to many contacts. Templates are the only messages that deliver outside the 24-hour window. Contacts who sent STOP are skipped.</p>
        </div>
      </div>
      <div className="grid cols-2">
        <div className="card card-pad stack-lg">
          <h2>New broadcast</h2>
          <Field label="Channel">
            <select className="select" value={channelId} onChange={(e) => setChannelId(e.target.value)}>
              {clouds.map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Template" hint={t ? PRICING[t.category] : undefined}>
            <select className="select" value={t?.name ?? ''} onChange={(e) => setName(e.target.value)}>
              {usable.map((x) => (
                <option key={x.name} value={x.name}>
                  {x.name} · {x.category.toLowerCase()}
                </option>
              ))}
            </select>
          </Field>
          {n > 0 && (
            <div className="grid cols-2">
              {Array.from({ length: n }, (_, i) => (
                <Field key={i} label={`Parameter {{${i + 1}}}`} hint={i === 0 ? 'Use {{name}} for the first name' : undefined}>
                  <input className="input" value={params[i] ?? ''} onChange={(e) => setParams((p) => Object.assign([...p], { [i]: e.target.value }))} />
                </Field>
              ))}
            </div>
          )}
          {t && <div className="callout plain small">{bodyText}</div>}
          <Field label={`Recipients (${picked.size} of ${reachable.length} reachable)`}>
            <div className="card" style={{ maxHeight: 240, overflowY: 'auto', boxShadow: 'none' }}>
              {reachable.map((p) => (
                <label key={p.id} className="check" style={{ padding: '7px 10px', borderBottom: '1px solid var(--border)' }}>
                  <input
                    type="checkbox"
                    checked={picked.has(p.id)}
                    disabled={!!p.opted_out}
                    onChange={(e) => {
                      const s = new Set(picked)
                      e.target.checked ? s.add(p.id) : s.delete(p.id)
                      setPicked(s)
                    }}
                  />
                  <span className="grow">{p.display_name}</span>
                  {p.opted_out ? <span className="badge crit">opted out</span> : null}
                </label>
              ))}
              {!reachable.length && <div className="small faint" style={{ padding: 10 }}>No reachable contacts yet. Have personas message the official number first.</div>}
            </div>
          </Field>
          <div className="row">
            <button className="btn sm" onClick={() => setPicked(new Set(reachable.filter((p) => !p.opted_out).map((p) => p.id)))}>
              Select all
            </button>
            <button className="btn primary right" disabled={!t || !picked.size || busy === 'send'} onClick={send}>
              <Send size={15} /> Send to {picked.size}
            </button>
          </div>
          {results && (
            <div className="stack">
              {results.map((r) => (
                <div key={r.personId} className="row small">
                  {r.ok ? <CheckCircle2 size={14} color="var(--good)" /> : <XCircle size={14} color="var(--crit)" />}
                  <span className="grow">{r.name}</span>
                  <span className="faint">{r.ok ? 'accepted' : r.skipped ?? r.error}</span>
                </div>
              ))}
              <div className="tiny faint">Accepted means HTTP 200. Delivery and failures arrive later as status webhooks; check the Event log.</div>
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-head">
            <h2>History</h2>
          </div>
          <div className="card-body">
            {!history?.length ? (
              <Empty icon={<Megaphone size={26} />} title="No broadcasts yet" />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Template</th>
                    <th>Recipients</th>
                    <th>Accepted</th>
                    <th>Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((b) => (
                    <tr key={b.id}>
                      <td>{timeAgo(b.created_at)}</td>
                      <td>
                        <code>{b.template}</code>
                      </td>
                      <td>{b.recipients}</td>
                      <td>{b.accepted}</td>
                      <td>{b.failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div style={{ marginTop: 12 }}>
              <Callout kind="plain">Groups API messages are billed per recipient: one template to a 5-member group counts as 5 messages.</Callout>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
