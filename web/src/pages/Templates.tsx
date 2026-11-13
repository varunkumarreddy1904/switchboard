import { Plus } from 'lucide-react'
import { useState } from 'react'
import { Callout, Empty, Field, useAction } from '../components/ui'
import { post, useApi } from '../lib/api'

export function Templates() {
  const { data: boot } = useApi<any>('/api/bootstrap', ['channels'])
  const clouds = (boot?.channels ?? []).filter((c: any) => c.kind === 'cloud')
  const [channelId, setChannelId] = useState('sbx-cloud')
  const { data, error } = useApi<any[]>(`/api/templates?channel=${channelId}`, ['templates'], [channelId])
  const [form, setForm] = useState({ name: '', category: 'UTILITY', language: 'en_US', body: '', footer: '', b1: '', b2: '' })
  const { busy, run } = useAction()
  const set = (k: keyof typeof form) => (e: any) => setForm({ ...form, [k]: e.target.value })

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Templates</h1>
          <p>Message templates must be approved by Meta before use. In the sandbox, approval arrives after a few seconds through the <code>message_template_status_update</code> webhook; real reviews can take minutes to days.</p>
        </div>
        <select className="select" style={{ width: 260 }} value={channelId} onChange={(e) => setChannelId(e.target.value)} aria-label="Channel">
          {clouds.map((c: any) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)' }}>
        <div className="grid cols-2" style={{ alignContent: 'start' }}>
          {error && <Callout kind="crit">{error}</Callout>}
          {!data?.length && !error && <Empty title="No templates" />}
          {data?.map((t) => {
            const body = t.components?.find((c: any) => c.type === 'BODY')?.text
            const footer = t.components?.find((c: any) => c.type === 'FOOTER')?.text
            const buttons = t.components?.find((c: any) => c.type === 'BUTTONS')?.buttons ?? []
            return (
              <div key={t.id ?? t.name} className="card card-pad stack">
                <div className="row">
                  <code style={{ fontWeight: 650 }}>{t.name}</code>
                  <span className="badge">{t.language}</span>
                  <span className="right" />
                  <span className={`badge ${t.status === 'APPROVED' ? 'good' : t.status === 'PENDING' ? 'warn' : 'crit'}`}>{t.status}</span>
                </div>
                <span className={`badge ${t.category === 'MARKETING' ? 'lane-b' : t.category === 'AUTHENTICATION' ? 'accent' : 'lane-a'}`} style={{ width: 'fit-content' }}>
                  {t.category}
                </span>
                <div className="small" style={{ whiteSpace: 'pre-wrap' }}>
                  {body}
                </div>
                {footer && <div className="tiny faint">{footer}</div>}
                {buttons.length > 0 && (
                  <div className="chips">
                    {buttons.map((b: any, i: number) => (
                      <span key={i} className="chip">
                        {b.text}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <div className="card card-pad stack-lg" style={{ alignSelf: 'start' }}>
          <h2>New template</h2>
          <Field label="Name" hint="lowercase letters, numbers, underscores">
            <input className="input" value={form.name} onChange={set('name')} placeholder="event_reminder" />
          </Field>
          <div className="grid cols-2">
            <Field label="Category">
              <select className="select" value={form.category} onChange={set('category')}>
                <option>UTILITY</option>
                <option>MARKETING</option>
              </select>
            </Field>
            <Field label="Language">
              <input className="input" value={form.language} onChange={set('language')} />
            </Field>
          </div>
          <Field label="Body" hint="Use {{1}}, {{2}} for variables">
            <textarea className="textarea" value={form.body} onChange={set('body')} placeholder="Hi {{1}}, your event {{2}} starts tomorrow." />
          </Field>
          <Field label="Footer (optional)">
            <input className="input" value={form.footer} onChange={set('footer')} />
          </Field>
          <div className="grid cols-2">
            <Field label="Quick reply 1">
              <input className="input" maxLength={25} value={form.b1} onChange={set('b1')} />
            </Field>
            <Field label="Quick reply 2">
              <input className="input" maxLength={25} value={form.b2} onChange={set('b2')} />
            </Field>
          </div>
          <button
            className="btn primary"
            disabled={!form.name || !form.body || busy === 'create'}
            onClick={async () => {
              const r: any = await run('create', () => post('/api/templates', { channelId, ...form, buttons: [form.b1, form.b2] }), 'Submitted for approval')
              if (r?.ok) setForm({ ...form, name: '', body: '', footer: '', b1: '', b2: '' })
            }}
          >
            <Plus size={15} /> Submit for approval
          </button>
          <div className="tiny faint">Authentication templates have fixed, Meta-defined text (copy-code, one-tap, zero-tap) and are created separately in WhatsApp Manager.</div>
        </div>
      </div>
    </div>
  )
}
