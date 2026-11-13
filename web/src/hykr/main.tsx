import {
  AlertTriangle,
  BadgeCheck,
  Camera,
  CheckCircle2,
  Clock,
  FileCheck2,
  Fuel,
  IndianRupee,
  KeyRound,
  Loader2,
  LogOut,
  MapPin,
  MessageCircle,
  RefreshCw,
  Route,
  ShieldCheck,
  Smartphone,
  Truck,
  User,
} from 'lucide-react'
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './app.css'

/**
 * The HYKR (EquipXchange) app for machine owners, PoC #12. Registration itself happens on WhatsApp; the app
 * signs owners in (Continue on WhatsApp, or a code sent on WhatsApp) and shows their registration live.
 * Served at /app on the main server (reachable through the tunnel) and on its own port (default 5175).
 */

const BASE = location.pathname.startsWith('/app') ? '/app' : ''
const KEY = 'hx_session'
const CH_KEY = 'hx_channel'
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string | null) => {
    try {
      if (v === null) localStorage.removeItem(k)
      else localStorage.setItem(k, v)
    } catch {
      /* private mode */
    }
  },
}

async function call<T = any>(path: string, opts: { method?: string; body?: unknown; session?: string | null } = {}): Promise<T> {
  const res = await fetch(`/api/app${path}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.session ? { 'x-app-session': opts.session } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { status: res.status })
  return json as T
}

const TEST_OWNERS = [
  ['ravi', 'Ravi Kumar (O1, owner-operator)'],
  ['srinivas', 'Srinivas Rao (O2, fleet owner)'],
  ['mahesh', 'Mahesh Goud (O3, no papers)'],
  ['venkat', 'Venkat Reddy (O5, RC in father’s name)'],
  ['anil', 'Anil Reddy'],
  ['raju', 'Raju Yadav'],
] as const

const KIND: Record<string, string> = {
  machine: 'Machine',
  rc: 'RC',
  invoice: 'Invoice',
  insurance: 'Insurance',
  pin_plate: 'PIN plate',
  hour_meter: 'Hour meter',
  video: 'Video',
  relationship_proof: 'Relationship proof',
  paper_form: 'Consent form',
  rc_unreadable: 'RC (unclear)',
  other: 'Document',
}
const FLAG: Record<string, string> = {
  no_papers: 'No RC or invoice: our team will inspect the machine',
  insurance_later: 'Insurance photo still to come',
  insurance_expired: 'Insurance expired: renew it before jobs',
  pin_plate_missing: 'PIN plate photo missing',
  rc_in_family_name: 'RC is in a family member’s name',
  rc_other_person: 'RC is in someone else’s name: ownership check needed',
  relationship_proof_later: 'Relationship document still to come',
  no_papers_consent: 'Papers not shared yet',
  owner_denied_mitra: 'You said this registration was wrong',
}
const rupees = (paise: number | null) => (paise == null ? '—' : `₹${Math.round(paise / 100).toLocaleString('en-IN')}`)
const when = (t: number) => new Date(t).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

function App() {
  const [session, setSession] = useState<string | null>(() => store.get(KEY))
  const [me, setMe] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)

  const signIn = useCallback((id: string) => {
    store.set(KEY, id)
    setSession(id)
  }, [])
  const signOut = useCallback(async () => {
    if (session) await call('/logout', { method: 'POST', session }).catch(() => undefined)
    store.set(KEY, null)
    setSession(null)
    setMe(null)
  }, [session])

  // Sign-in link sent on WhatsApp: /app/magic/<token>
  useEffect(() => {
    const m = /\/magic\/([^/?#]+)/.exec(location.pathname)
    if (!m) return
    call<any>('/magic', { body: { token: decodeURIComponent(m[1]) } })
      .then((r) => {
        if (r.ok && r.session?.id) signIn(r.session.id)
        else setError(r.error ?? 'This sign-in link has expired. Ask for a new one on WhatsApp by sending START.')
      })
      .catch((e) => setError(e.message))
      .finally(() => history.replaceState(null, '', `${BASE}/`))
  }, [signIn])

  // Live view: refresh every few seconds while registration happens on WhatsApp.
  useEffect(() => {
    if (!session) return
    let alive = true
    const load = () =>
      call('/me', { session })
        .then((r) => alive && setMe(r))
        .catch((e) => {
          if (alive && e.status === 401) {
            store.set(KEY, null)
            setSession(null)
            setMe(null)
          }
        })
    load()
    const t = setInterval(load, 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [session])

  return (
    <div className="app">
      <header className="bar">
        <div className="logo" aria-hidden>
          <Truck size={18} />
        </div>
        <div className="brand">
          EquipXchange<span>by HYKR</span>
        </div>
        {me && (
          <button className="ghost" onClick={signOut} aria-label="Sign out">
            <LogOut size={16} /> <span className="hide-sm">Sign out</span>
          </button>
        )}
      </header>
      <main>
        {error && (
          <div className="note warn" role="alert">
            <AlertTriangle size={16} /> {error}
          </div>
        )}
        {session && me ? <Home me={me} /> : session ? <div className="loading"><Loader2 className="spin" size={22} /> Loading your account…</div> : <SignIn onSignedIn={signIn} />}
      </main>
      <footer>Proof of concept · PoC #12 · registration happens on WhatsApp</footer>
    </div>
  )
}

// ====================================================================== sign in

function SignIn({ onSignedIn }: { onSignedIn: (id: string) => void }) {
  const [channels, setChannels] = useState<any[]>([])
  const [channelId, setChannelId] = useState<string>(() => store.get(CH_KEY) ?? '')
  const [mode, setMode] = useState<'home' | 'whatsapp' | 'code'>('home')
  useEffect(() => {
    call<any[]>('/channels').then((cs) => {
      setChannels(cs)
      setChannelId((cur) => (cs.some((c) => c.id === cur) ? cur : (cs.find((c) => c.mode === 'sandbox')?.id ?? cs[0]?.id ?? '')))
    })
  }, [])
  const channel = channels.find((c) => c.id === channelId)
  const pick = (id: string) => {
    setChannelId(id)
    store.set(CH_KEY, id)
  }

  return (
    <div className="stack">
      <section className="hero">
        <h1>Get work for your machines</h1>
        <p>Contractors near Warangal, Hanamkonda and Kazipet book backhoes, excavators and breakers through WhatsApp. You get paid the same evening.</p>
        <ol className="steps">
          <li>
            <MessageCircle size={16} /> Say hi on WhatsApp
          </li>
          <li>
            <Camera size={16} /> Send photos of your machine and papers
          </li>
          <li>
            <ShieldCheck size={16} /> We verify it within 24 hours
          </li>
          <li>
            <IndianRupee size={16} /> Get job offers, paid the same day
          </li>
        </ol>
      </section>

      {mode === 'home' && (
        <section className="card stack">
          <button className="primary big" onClick={() => setMode('whatsapp')} disabled={!channel}>
            <MessageCircle size={18} /> Continue on WhatsApp
          </button>
          <button className="secondary big" onClick={() => setMode('code')} disabled={!channel}>
            <KeyRound size={18} /> Sign in with a code
          </button>
          <p className="muted small">No app download or password. WhatsApp proves it’s your number.</p>
        </section>
      )}
      {mode === 'whatsapp' && channel && <ContinueOnWhatsApp channel={channel} onSignedIn={onSignedIn} onBack={() => setMode('home')} />}
      {mode === 'code' && channel && <CodeSignIn channel={channel} onSignedIn={onSignedIn} onBack={() => setMode('home')} />}

      {channels.length > 1 && (
        <label className="channel muted small">
          Number:{' '}
          <select value={channelId} onChange={(e) => pick(e.target.value)}>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.mode === 'sandbox' ? 'Sandbox (simulated phones)' : `Live · ${c.name}`}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}

function ContinueOnWhatsApp({ channel, onSignedIn, onBack }: { channel: any; onSignedIn: (id: string) => void; onBack: () => void }) {
  const [s, setS] = useState<any>(null)
  const [persona, setPersona] = useState('ravi')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    call('/session', { body: { channelId: channel.id } }).then(setS).catch((e) => setErr(e.message))
  }, [channel.id])
  useEffect(() => {
    if (!s) return
    const t = setInterval(() => {
      call<any>(`/session/${s.id}`).then((r) => r.status === 'signed_in' && onSignedIn(s.id))
    }, 1500)
    return () => clearInterval(t)
  }, [s, onSignedIn])

  return (
    <section className="card stack">
      <h2>Continue on WhatsApp</h2>
      {err && <div className="note warn">{err}</div>}
      {!s ? (
        <div className="loading">
          <Loader2 className="spin" size={18} /> Preparing…
        </div>
      ) : (
        <>
          <p>Tap the button on your phone, or scan the code with your phone’s camera. WhatsApp opens with a message ready: just press send.</p>
          <div className="qr-row">
            <img src={s.qr} alt="QR code that opens WhatsApp" width={180} height={180} />
            <div className="stack">
              <a className="primary big" href={s.waLink} target="_blank" rel="noreferrer">
                <MessageCircle size={18} /> Open WhatsApp
              </a>
              <div className="waiting">
                <Loader2 className="spin" size={16} /> Waiting for your message…
              </div>
            </div>
          </div>
          {channel.mode === 'sandbox' && (
            <div className="sandbox stack">
              <div className="small">
                <b>Sandbox:</b> no real phone needed. Send the message as a test owner, then answer them in the console’s Simulator.
              </div>
              <div className="row">
                <select value={persona} onChange={(e) => setPersona(e.target.value)} aria-label="Test owner">
                  {TEST_OWNERS.map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      await call('/sandbox-start', { body: { sessionId: s.id, persona } })
                    } catch (e) {
                      setErr((e as Error).message)
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  <Smartphone size={16} /> Send as test owner
                </button>
              </div>
            </div>
          )}
        </>
      )}
      <button className="link" onClick={onBack}>
        ← Back
      </button>
    </section>
  )
}

function CodeSignIn({ channel, onSignedIn, onBack }: { channel: any; onSignedIn: (id: string) => void; onBack: () => void }) {
  const [phone, setPhone] = useState(channel.mode === 'sandbox' ? '+91 90000 00001' : '+91 ')
  const [otp, setOtp] = useState<{ sessionId: string; otpId: string } | null>(null)
  const [status, setStatus] = useState<string>('')
  const [code, setCode] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const codeRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!otp) return
    codeRef.current?.focus()
    const t = setInterval(() => call<any>(`/otp/${otp.otpId}`).then((r) => setStatus(r.status)).catch(() => undefined), 1500)
    return () => clearInterval(t)
  }, [otp])

  const send = async () => {
    setErr(null)
    setBusy(true)
    try {
      const s = await call<any>('/session', { body: { channelId: channel.id } })
      const r = await call<any>('/otp/start', { body: { sessionId: s.id, phone } })
      if (!r.ok) throw new Error(r.error ?? 'Could not send the code')
      setOtp({ sessionId: s.id, otpId: r.otpId })
      setStatus('sent')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const verify = async () => {
    setErr(null)
    setBusy(true)
    try {
      const r = await call<any>('/otp/verify', { body: { otpId: otp!.otpId, code } })
      if (!r.ok) throw new Error(r.error)
      onSignedIn(otp!.sessionId)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card stack">
      <h2>Sign in with a code</h2>
      {!otp ? (
        <>
          <label className="field">
            Your WhatsApp number
            <input inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <button className="primary big" onClick={send} disabled={busy || phone.replace(/\D/g, '').length < 10}>
            {busy ? <Loader2 className="spin" size={18} /> : <MessageCircle size={18} />} Send code on WhatsApp
          </button>
        </>
      ) : (
        <>
          <p>
            We sent a 6-digit code to <b>{phone}</b> on WhatsApp.{' '}
            <span className={`pill ${status === 'failed' ? 'bad' : status === 'delivered' ? 'good' : ''}`}>{status === 'failed' ? 'not delivered' : status || 'sending'}</span>
          </p>
          {channel.mode === 'sandbox' && <div className="sandbox small">Sandbox: open the console → Simulator → this person’s chat to see the code.</div>}
          <label className="field">
            Code
            <input ref={codeRef} inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </label>
          <button className="primary big" onClick={verify} disabled={busy || code.length !== 6}>
            {busy ? <Loader2 className="spin" size={18} /> : <CheckCircle2 size={18} />} Sign in
          </button>
          <button className="link" onClick={() => (setOtp(null), setCode(''))}>
            Use a different number
          </button>
        </>
      )}
      {err && <div className="note warn">{err}</div>}
      <button className="link" onClick={onBack}>
        ← Back
      </button>
    </section>
  )
}

// ====================================================================== signed in

function Home({ me }: { me: any }) {
  const p = me.person ?? {}
  const first = (p.name ?? '').split(' ')[0]
  const machines: any[] = me.machines ?? []
  return (
    <div className="stack">
      <section className="hello">
        <h1>{first ? `Namaste, ${first}` : 'Welcome'}</h1>
        <div className="muted small">
          {p.phone ?? ''} {me.channel?.mode === 'sandbox' && <span className="pill">Sandbox</span>}
        </div>
      </section>

      <section className={`card next ${me.step === 'registered' ? 'done' : ''}`}>
        <div className="next-row">
          {me.step === 'registered' ? <BadgeCheck size={22} /> : <Clock size={22} />}
          <div>
            <div className="label">{me.step === 'registered' ? 'Registration' : 'Next step'}</div>
            <div className="next-text">{me.next ?? 'Continue on WhatsApp'}</div>
          </div>
        </div>
        {me.waLink && me.step !== 'registered' && (
          <a className="primary" href={me.waLink} target="_blank" rel="noreferrer">
            <MessageCircle size={16} /> Continue on WhatsApp
          </a>
        )}
      </section>

      {me.registered && (
        <section className="card">
          <h2>
            <User size={18} /> Your profile
          </h2>
          <dl className="kv">
            <dt>Name</dt>
            <dd>{p.name ?? '—'}</dd>
            <dt>Village</dt>
            <dd>{p.village ?? '—'}</dd>
            <dt>Role</dt>
            <dd>{(p.roles ?? []).includes('operator') ? 'Owner, drives the machine' : 'Owner, has an operator'}</dd>
            <dt>Verification</dt>
            <dd>{p.kyc_level === 'T1' ? 'Level 1 (a machine is verified)' : 'Level 0 (profile)'}</dd>
            <dt>Owner ID</dt>
            <dd className="mono">{p.id}</dd>
          </dl>
        </section>
      )}

      <section className="stack">
        <h2 className="section">
          <Truck size={18} /> Your machines {machines.length > 0 && <span className="muted">({machines.length})</span>}
        </h2>
        {!machines.length && <div className="card muted">No machines yet. Add one on WhatsApp: send a photo of your machine.</div>}
        {machines.map((m) => (
          <Machine key={m.id} m={m} />
        ))}
      </section>

      {me.consents?.length > 0 && (
        <section className="card">
          <h2>
            <FileCheck2 size={18} /> What you agreed to
          </h2>
          <ul className="consents">
            {me.consents.map((c: any) => (
              <li key={c.id} className={c.withdrawn_at ? 'withdrawn' : ''}>
                <b>{c.purpose === 'C1' ? 'Basic profile' : c.purpose === 'C2' ? 'Machine papers' : c.purpose}</b>
                <span className="muted small">
                  {c.withdrawn_at ? `withdrawn ${when(c.withdrawn_at)}` : `agreed ${when(c.given_at)} · ${c.channel === 'paper' ? 'paper form' : 'WhatsApp'}`}
                </span>
              </li>
            ))}
          </ul>
          <p className="muted small">Send STOP on WhatsApp at any time to withdraw.</p>
        </section>
      )}
      <div className="live muted small">
        <RefreshCw size={12} /> Updates automatically
      </div>
    </div>
  )
}

function Machine({ m }: { m: any }) {
  const status = m.status as string
  const flags: string[] = m.flags ?? []
  return (
    <article className={`card machine s-${status}`}>
      <header>
        <div>
          <div className="m-title">{m.label || m.classLabel}</div>
          <div className="muted small">
            {[m.reg_no ? `Reg. ${m.reg_no}` : null, m.year].filter(Boolean).join(' · ') || m.id}
          </div>
        </div>
        <span className={`status ${status}`}>
          {status === 'active' ? <BadgeCheck size={14} /> : status === 'needs_info' ? <AlertTriangle size={14} /> : <Clock size={14} />} {m.statusLabel}
        </span>
      </header>
      {status === 'needs_info' && m.desk_note && (
        <div className="note warn">
          <AlertTriangle size={16} /> Our team needs: {m.desk_note}. Send it on WhatsApp.
        </div>
      )}
      {status === 'rejected' && m.desk_note && <div className="note bad">Not approved: {m.desk_note}</div>}
      {m.evidence?.length > 0 && (
        <div className="photos">
          {m.evidence.map((e: any) =>
            /^image\//.test(e.mime) ? (
              <a key={e.id} href={e.url} target="_blank" rel="noreferrer" className="photo">
                <img src={e.url} alt={KIND[e.kind] ?? e.kind} loading="lazy" />
                <span>{KIND[e.kind] ?? e.kind}</span>
              </a>
            ) : (
              <div key={e.id} className="photo file">
                <FileCheck2 size={22} />
                <span>{KIND[e.kind] ?? e.kind}</span>
              </div>
            ),
          )}
        </div>
      )}
      <dl className="kv">
        {(m.make || m.model) && (
          <>
            <dt>Make, model</dt>
            <dd>{[m.make, m.model].filter(Boolean).join(' ')}</dd>
          </>
        )}
        {m.pin && (
          <>
            <dt>PIN</dt>
            <dd className="mono">{m.pin}</dd>
          </>
        )}
        <dt>
          <MapPin size={14} /> Based at
        </dt>
        <dd>{m.base_label ?? '—'}</dd>
        <dt>
          <IndianRupee size={14} /> Lowest rate
        </dt>
        <dd>
          {rupees(m.rate_hour)}/hour{m.rate_day ? ` · ${rupees(m.rate_day)}/day` : ''}
        </dd>
        <dt>
          <Fuel size={14} /> Diesel
        </dt>
        <dd>{m.diesel === 'owner' ? 'You provide' : m.diesel === 'customer' ? 'Customer provides' : '—'}</dd>
        <dt>
          <Route size={14} /> Travels up to
        </dt>
        <dd>{m.radius_km ? `${m.radius_km} km` : '—'}</dd>
        {m.insurance_expiry && (
          <>
            <dt>Insurance till</dt>
            <dd>{m.insurance_expiry}</dd>
          </>
        )}
        {m.hour_reading && (
          <>
            <dt>Hour meter</dt>
            <dd>{m.hour_reading} h</dd>
          </>
        )}
      </dl>
      {flags.filter((f) => FLAG[f]).length > 0 && (
        <ul className="flags">
          {flags
            .filter((f) => FLAG[f])
            .map((f) => (
              <li key={f}>
                <AlertTriangle size={13} /> {FLAG[f]}
              </li>
            ))}
        </ul>
      )}
    </article>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
