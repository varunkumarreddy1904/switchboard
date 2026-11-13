import { AlertTriangle, KeyRound, Plug, PlugZap, Radio, Send, Smartphone, TestTube2, Trash2, Webhook } from 'lucide-react'
import { useState } from 'react'
import { Callout, CopyField, Field, LaneBadge, ModeBadge, StatusPill, useAction } from '../components/ui'
import { api, del, post, useApi } from '../lib/api'

export function LiveLab() {
  const { data: channels, reload } = useApi<any[]>('/api/channels', ['channels'])
  const { data: settings } = useApi<any>('/api/settings', ['channels'])
  const [adding, setAdding] = useState<'cloud' | 'linked' | null>(null)
  const isLocal = /localhost|127\.0\.0\.1/.test(settings?.effectivePublicBase ?? '')
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Live lab</h1>
          <p>Plug in real numbers next to the sandbox. The agent code is identical: a live Cloud API channel only changes the Graph base URL and credentials, and a live linked channel swaps the fake socket for a real Baileys socket.</p>
        </div>
        <div className="row">
          <button className="btn primary" onClick={() => setAdding('cloud')}>
            <Plug size={15} /> Connect Cloud API number
          </button>
          <button className="btn" onClick={() => setAdding('linked')}>
            <Smartphone size={15} /> Link a number (unofficial)
          </button>
        </div>
      </div>

      {isLocal && (
        <div style={{ marginBottom: 14 }}>
          <Callout kind="warn">
            Meta must reach your webhook over public HTTPS. Run <code>cloudflared tunnel --url http://localhost:4000</code> (or ngrok), then paste the https URL into <a href="#/settings">Settings → Public URL</a>. The webhook URLs below update automatically.
          </Callout>
        </div>
      )}

      {adding === 'cloud' && <CloudForm onDone={() => (setAdding(null), reload())} />}
      {adding === 'linked' && <LinkedForm onDone={() => (setAdding(null), reload())} />}

      <div className="stack-lg">
        {(channels ?? []).map((c) => (c.kind === 'cloud' ? <CloudCard key={c.id} c={c} /> : <LinkedCard key={c.id} c={c} />))}
      </div>
    </div>
  )
}

function CloudForm({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ name: 'My Cloud API number', phoneNumberId: '', wabaId: '', accessToken: '', appSecret: '', verifyToken: '', graphVersion: 'v24.0', otpTemplate: '', otpLanguage: 'en_US', reengageTemplate: '', inviteTemplate: '' })
  const set = (k: keyof typeof f) => (e: any) => setF({ ...f, [k]: e.target.value })
  const { busy, run } = useAction()
  return (
    <div className="card card-pad stack-lg" style={{ marginBottom: 14 }}>
      <div className="row">
        <LaneBadge lane="A" />
        <h2>Connect a WhatsApp Cloud API number</h2>
      </div>
      <Callout kind="info" icon={<KeyRound size={16} />}>
        In <b>developers.facebook.com → your app → WhatsApp → API Setup</b> copy the Phone number ID and WhatsApp Business Account ID, and create a permanent System User token in Business Settings. The App secret is under <b>App settings → Basic</b>. A Meta test number works for 1:1 messages; the Groups API needs an Official Business Account and is not available on test numbers.
      </Callout>
      <div className="grid cols-2">
        <Field label="Name">
          <input className="input" value={f.name} onChange={set('name')} />
        </Field>
        <Field label="Graph API version">
          <input className="input" value={f.graphVersion} onChange={set('graphVersion')} />
        </Field>
        <Field label="Phone number ID">
          <input className="input" value={f.phoneNumberId} onChange={set('phoneNumberId')} placeholder="e.g. 1234567890" />
        </Field>
        <Field label="WhatsApp Business Account ID">
          <input className="input" value={f.wabaId} onChange={set('wabaId')} />
        </Field>
        <Field label="Access token" hint="Stored locally in data/agent.db (plain text; local POC only)">
          <input className="input" type="password" value={f.accessToken} onChange={set('accessToken')} />
        </Field>
        <Field label="App secret" hint="App settings → Basic. Verifies X-Hub-Signature-256; until it is set, incoming webhooks are refused">
          <input className="input" type="password" value={f.appSecret} onChange={set('appSecret')} />
        </Field>
        <Field label="Verify token" hint="Any string; paste the same value in Meta's webhook settings. Generated if empty.">
          <input className="input" value={f.verifyToken} onChange={set('verifyToken')} />
        </Field>
        <Field label="Authentication (OTP) template" hint="Name of your approved copy-code template">
          <input className="input" value={f.otpTemplate} onChange={set('otpTemplate')} placeholder="otp_login" />
        </Field>
        <Field label="Re-engagement template (optional)" hint="Utility template with one body parameter, sent when free-form fails with 131047">
          <input className="input" value={f.reengageTemplate} onChange={set('reengageTemplate')} />
        </Field>
        <Field label="Group invite template (optional)" hint="Utility template from the Template Library with a group_id parameter">
          <input className="input" value={f.inviteTemplate} onChange={set('inviteTemplate')} />
        </Field>
      </div>
      <div className="row">
        <button className="btn primary" disabled={busy === 'save'} onClick={async () => {
          const r: any = await run('save', () => post('/api/channels/cloud', f), 'Channel saved: now test it')
          if (r?.ok) onDone()
        }}>
          Save channel
        </button>
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}

/** Shows when Meta says the token runs out (filled by Test connection). */
function TokenExpiry({ at }: { at?: number }) {
  if (at === undefined || at === null) return <span className="tiny faint">expiry unknown: press Test connection</span>
  if (at === 0) return <span className="tiny faint">never expires</span>
  const mins = Math.round((at - Date.now()) / 60_000)
  const when = new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  if (mins <= 0) return <span className="tiny" style={{ color: 'var(--crit-text)' }}>expired {when}</span>
  const left = mins < 120 ? `${mins} min` : mins < 2880 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`
  return <span className="tiny" style={{ color: mins < 120 ? 'var(--warn-text)' : undefined }}>expires {when} (in {left})</span>
}

function CloudCard({ c }: { c: any }) {
  const [to, setTo] = useState('')
  const [secret, setSecret] = useState('')
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const { busy, run } = useAction()
  const [confirm, setConfirm] = useState(false)
  const publicUrl = /^https:\/\//.test(c.webhookUrl ?? '')
  return (
    <div className="card card-pad stack">
      <div className="row wrap">
        <LaneBadge lane="A" />
        <h2>{c.name}</h2>
        <ModeBadge mode={c.mode} />
        <StatusPill status={c.status} />
        {c.status !== 'error' && <span className="right tiny faint">{c.statusDetail}</span>}
      </div>
      <div className="grid cols-2">
        <dl className="kv">
          <dt>Graph</dt>
          <dd>
            <code>
              {c.config.graphBase}/{c.config.graphVersion}
            </code>
          </dd>
          <dt>Phone number ID</dt>
          <dd><code>{c.config.phoneNumberId}</code></dd>
          <dt>WABA ID</dt>
          <dd><code>{c.config.wabaId}</code></dd>
          <dt>Token</dt>
          <dd>
            <code>{c.config.accessToken}</code> {c.mode === 'live' && <TokenExpiry at={c.config.tokenExpiresAt} />}
          </dd>
          {c.mode === 'live' && (
            <>
              <dt>App secret</dt>
              <dd>{c.hasAppSecret ? <code>{c.config.appSecret}</code> : <span className="tiny" style={{ color: 'var(--warn-text)' }}>missing: incoming webhooks are refused</span>}</dd>
            </>
          )}
          <dt>OTP template</dt>
          <dd><code>{c.config.otpTemplate}</code></dd>
        </dl>
        <div className="stack">
          <CopyField label="Callback URL" value={c.webhookUrl} />
          <CopyField label="Verify token" value={c.config.verifyToken} />
          {c.mode === 'live' ? (
            <div className="tiny faint">
              <b>Point Meta's webhook here</b> sets this Callback URL and Verify token on your Meta app (fields <code>messages</code> and <code>message_template_status_update</code>) and subscribes the app to this WhatsApp account, so you don't need the dashboard. Press it again whenever the tunnel URL changes. It needs the App secret.
            </div>
          ) : (
            <div className="tiny faint">Subscribe the app's webhook to: messages, group_lifecycle_update, group_participants_update, message_template_status_update.</div>
          )}
        </div>
      </div>
      {c.mode === 'live' && !c.hasAppSecret && (
        <Callout kind="warn" icon={<KeyRound size={16} />}>
          <div className="stack">
            <span>
              Add the <b>App secret</b> (developers.facebook.com → your app → <b>App settings → Basic</b> → App secret → Show). Without it the server can't verify Meta's signature, so it refuses incoming webhooks. Meta retries, so they arrive once it's set.
            </span>
            <div className="row wrap">
              <input className="input" type="password" style={{ maxWidth: 320 }} placeholder="App secret" value={secret} onChange={(e) => setSecret(e.target.value)} />
              <button className="btn primary" disabled={!secret || busy === 'secret'} onClick={async () => {
                const r: any = await run('secret', () => api(`/api/channels/${c.id}`, { method: 'PATCH', body: { appSecret: secret } }), 'App secret saved')
                if (r?.ok) setSecret('')
              }}>
                Save secret
              </button>
            </div>
          </div>
        </Callout>
      )}
      {c.mode === 'live' && (c.status === 'error' || showToken) && (
        <Callout kind={c.status === 'error' ? 'crit' : 'plain'} icon={<KeyRound size={16} />}>
          <div className="stack">
            {c.status === 'error' && <span><b>This number can't send right now.</b> {c.statusDetail}</span>}
            <span className="tiny">
              The temporary token from <b>WhatsApp → API Setup</b> only lasts about an hour. For demos, make a permanent one: <b>business.facebook.com → Business settings → Users → System users</b> → add an admin system user → <b>Assign assets</b> (your app and WhatsApp account, full control) → <b>Generate new token</b> → expiry <b>Never</b>, permissions <code>whatsapp_business_messaging</code> and <code>whatsapp_business_management</code>.
            </span>
            <div className="row wrap">
              <input className="input" type="password" style={{ maxWidth: 360 }} placeholder="New access token" value={token} onChange={(e) => setToken(e.target.value)} />
              <button className="btn primary" disabled={!token || busy === 'token'} onClick={async () => {
                const r: any = await run('token', async () => {
                  const saved: any = await api(`/api/channels/${c.id}`, { method: 'PATCH', body: { accessToken: token } })
                  return saved?.ok ? post(`/api/channels/${c.id}/test`) : saved
                }, 'New token saved and working')
                if (r?.ok) {
                  setToken('')
                  setShowToken(false)
                }
              }}>
                Save and test
              </button>
            </div>
          </div>
        </Callout>
      )}
      {c.mode === 'live' && (
        <div className="row wrap">
          <button className="btn" disabled={busy === 'test'} onClick={() => run('test', () => post(`/api/channels/${c.id}/test`), 'Connection works')}>
            <TestTube2 size={14} /> Test connection
          </button>
          <button className="btn" disabled={!publicUrl || !c.hasAppSecret || busy === 'hook'} title={!publicUrl ? 'Set an https Public URL in Settings first' : !c.hasAppSecret ? 'Add the App secret first' : ''} onClick={() => run('hook', () => post(`/api/channels/${c.id}/point-webhook`), "Meta's webhook now points here")}>
            <Webhook size={14} /> Point Meta's webhook here
          </button>
          {c.status !== 'error' && (
            <button className="btn ghost" onClick={() => setShowToken((v) => !v)}>
              <KeyRound size={14} /> Replace token
            </button>
          )}
          <input className="input" style={{ maxWidth: 220 }} placeholder="Your phone, e.g. +44…" value={to} onChange={(e) => setTo(e.target.value)} />
          <button className="btn" disabled={!to || busy === 'msg'} onClick={() => run('msg', () => post(`/api/channels/${c.id}/test-message`, { to }), 'hello_world template sent: check your phone')}>
            <Send size={14} /> Send hello_world
          </button>
          <span className="right" />
          {confirm ? (
            <>
              <button className="btn danger" onClick={() => run('del', () => del(`/api/channels/${c.id}`), 'Channel removed')}>
                Remove and delete its data
              </button>
              <button className="btn ghost" onClick={() => setConfirm(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn ghost" onClick={() => setConfirm(true)}>
              <Trash2 size={14} /> Remove
            </button>
          )}
        </div>
      )}
      {c.mode === 'live' && (
        <div className="tiny faint">
          After testing: message your business number from your phone (opens the 24h window), and the conversation appears in the Team inbox tagged LIVE. Onboarding links use the app stub at <code>/app</code>.
        </div>
      )}
    </div>
  )
}

function LinkedForm({ onDone }: { onDone: () => void }) {
  const [ack, setAck] = useState(false)
  const [name, setName] = useState('Linked member number')
  const { busy, run } = useAction()
  return (
    <div className="card card-pad stack-lg" style={{ marginBottom: 14 }}>
      <div className="row">
        <LaneBadge lane="B" />
        <h2>Link a real number with Baileys (unofficial)</h2>
      </div>
      <Callout kind="crit" icon={<AlertTriangle size={16} />}>
        <b>This violates WhatsApp's Terms of Service.</b> Numbers linked by unofficial clients get banned, often without warning. Use a dedicated throwaway number, never your official onboarding number or your personal number. Group members have not agreed to a bot reading along: record admin consent per group before ingestion starts. The agent stays read-only on this lane.
      </Callout>
      <Field label="Name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
        <span>I understand the ban risk and I'm using a dedicated number I can lose.</span>
      </label>
      <div className="row">
        <button className="btn primary" disabled={!ack || busy === 'add'} onClick={async () => {
          const r: any = await run('add', () => post('/api/channels/linked', { name, ackBanRisk: ack }), 'Channel created: click Connect to get a QR')
          if (r?.ok) onDone()
        }}>
          Create linked channel
        </button>
        <button className="btn ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function LinkedCard({ c }: { c: any }) {
  const { busy, run } = useAction()
  const [phone, setPhone] = useState('')
  const [confirm, setConfirm] = useState(false)
  const s = c.linked?.status ?? c.status
  return (
    <div className="card card-pad stack">
      <div className="row wrap">
        <LaneBadge lane="B" />
        <h2>{c.name}</h2>
        <ModeBadge mode={c.mode} />
        <StatusPill status={s} />
        <span className="right tiny faint">{c.linked?.detail}</span>
      </div>
      <div className="row" style={{ alignItems: 'flex-start', gap: 18, flexWrap: 'wrap' }}>
        {c.linked?.qrDataUrl ? (
          <div className="stack" style={{ alignItems: 'center' }}>
            <img className="qr" src={c.linked.qrDataUrl} alt="QR code for linking" />
            <div className="tiny faint">{c.mode === 'sandbox' ? 'Simulator → Ops member number → Scan QR' : 'WhatsApp → Settings → Linked devices → Link a device'}</div>
          </div>
        ) : null}
        <div className="stack grow">
          <div className="small muted">
            {c.mode === 'sandbox'
              ? 'Sandbox socket: an in-process fake typed against Baileys v7. It emits the same connection.update, messages.upsert and history events a real socket does.'
              : 'Real Baileys 7.0.0-rc14 socket (markOnlineOnConnect off, no full history sync, read-only). Auth state is kept in data/live-auth/.'}
          </div>
          {c.linked?.pairingCode && (
            <Callout kind="info">
              Pairing code: <b className="mono" style={{ fontSize: 16, letterSpacing: 2 }}>{c.linked.pairingCode}</b>. On the phone: Linked devices → Link with phone number instead.
            </Callout>
          )}
          <div className="row wrap">
            {['disconnected', 'logged_out', 'error'].includes(s) ? (
              <button className="btn primary" disabled={busy === 'c'} onClick={() => run('c', () => post(`/api/channels/${c.id}/connect`), 'Connecting')}>
                <PlugZap size={14} /> Connect
              </button>
            ) : (
              <button className="btn" disabled={busy === 'd'} onClick={() => run('d', () => post(`/api/channels/${c.id}/disconnect`), 'Disconnected')}>
                Disconnect
              </button>
            )}
            {c.mode === 'live' && s === 'qr' && (
              <>
                <input className="input" style={{ maxWidth: 200 }} placeholder="Or pair by phone: +44…" value={phone} onChange={(e) => setPhone(e.target.value)} />
                <button className="btn" disabled={!phone} onClick={() => run('p', () => post(`/api/channels/${c.id}/pair`, { phone }))}>
                  Get pairing code
                </button>
              </>
            )}
            {s === 'open' && (
              <a className="btn" href="#/groups">
                <Radio size={14} /> Groups and consent
              </a>
            )}
            {c.mode === 'live' && (
              <>
                <span className="right" />
                {confirm ? (
                  <>
                    <button className="btn danger" onClick={() => run('del', () => del(`/api/channels/${c.id}`), 'Removed')}>
                      Unlink and delete data
                    </button>
                    <button className="btn ghost" onClick={() => setConfirm(false)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button className="btn ghost" onClick={() => setConfirm(true)}>
                    <Trash2 size={14} /> Remove
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
