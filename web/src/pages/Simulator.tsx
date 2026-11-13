import { ArrowLeft, Ban, Camera, CheckCircle2, ChevronRight, Clock, Contact, Copy, EyeOff, Link2, Lock, MapPin, Megaphone, Mic, Play, QrCode, RotateCcw, Send, Smartphone, Timer, UserRoundX, Users, XCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Avatar, Callout, Field, StatusPill, Tabs, useAction, useToast } from '../components/ui'
import { api, copy, fmtPhone, hm, post, useApi } from '../lib/api'

export function Simulator() {
  const { data: state } = useApi<any>('/sandbox/api/state', ['sandbox', 'scenes'])
  const [pid, setPid] = useState('asha')
  if (!state) return <div className="page" />
  const persona = state.personas.find((p: any) => p.id === pid)
  return (
    <div className="sim">
      <div className="sim-col stack">
        <div>
          <h1>Simulator</h1>
          <p className="small muted" style={{ marginTop: 4 }}>
            Act as any persona. Their phone talks to the official number (Cloud API webhooks) or posts in groups the member number reads (linked-device events). Numbers are from fictional ranges.
          </p>
        </div>
        <div className="stack" style={{ gap: 2 }}>
          {state.personas.map((p: any) => (
            <div key={p.id} className={`persona ${p.id === pid ? 'active' : ''}`} onClick={() => setPid(p.id)}>
              <Avatar name={p.name} size="sm" hue={p.hue} />
              <div className="grow">
                <div className="ellipsis" style={{ fontWeight: 600, fontSize: 13 }}>
                  {p.name}
                </div>
                <div className="tiny faint ellipsis">{p.id === 'member' ? 'linked-device member number' : fmtPhone(p.pn)}</div>
              </div>
              {p.hiddenNumber && <EyeOff size={13} aria-label="hidden number" />}
              {p.windowOpen && <span className="dot good" title="24h service window open" />}
            </div>
          ))}
          <div className="tiny faint" style={{ padding: '6px 10px' }}>
            + {state.syntheticCount} synthetic members fill the large groups
          </div>
        </div>
      </div>
      <div className="sim-col" style={{ overflow: 'hidden' }}>
        <Phone key={pid} pid={pid} state={state} />
      </div>
      <div className="sim-col">
        <Controls state={state} persona={persona} />
      </div>
    </div>
  )
}

// ------------------------------------------------------------ phone

function Phone({ pid, state }: { pid: string; state: any }) {
  const { data: view } = useApi<any>(`/sandbox/api/personas/${pid}`, ['sandbox'], [pid])
  const [chatId, setChatId] = useState<string | null>(null)
  if (!view) return <div className="phone" />
  const chat = chatId ? view.chats.find((c: any) => c.id === chatId) : null
  const p = view.persona
  return (
    <div className="phone" aria-label={`${p.name}'s phone`}>
      <div className="phone-screen" style={{ position: 'relative' }}>
        {chat ? (
          <ChatScreen pid={pid} chat={chat} onBack={() => setChatId(null)} />
        ) : (
          <>
            <div className="phone-bar">
              <Avatar name={p.name} size="sm" hue={p.hue} />
              <div className="grow">
                <div style={{ fontWeight: 650 }}>{p.name}</div>
                <div className="tiny faint">{fmtPhone(p.pn)}{p.hiddenNumber ? ' · number hidden from businesses' : ''}</div>
              </div>
              <Smartphone size={16} className="faint" />
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {pid === 'member' && <DevicePanel device={view.device} />}
              {view.chats.map((c: any) => {
                const last = c.messages[c.messages.length - 1]
                return (
                  <div key={c.id} className="chat-row" onClick={() => setChatId(c.id)}>
                    <Avatar name={c.title} size="sm" group={c.kind !== 'dm'} />
                    <div className="grow">
                      <div className="row">
                        <span className="ellipsis grow" style={{ fontWeight: 600, fontSize: 13 }}>
                          {c.title}
                        </span>
                        {last && <span className="tiny faint">{hm(last.at)}</span>}
                      </div>
                      <div className="tiny faint ellipsis">{last ? `${last.senderName && c.kind !== 'dm' ? last.senderName + ': ' : ''}${last.text}` : c.subtitle}</div>
                    </div>
                    <ChevronRight size={14} className="faint" />
                  </div>
                )
              })}
              {pid === 'member' &&
                state.linkedGroups
                  .filter((g: any) => !g.memberJoined && g.kind !== 'community')
                  .map((g: any) => <JoinRow key={g.jid} g={g} />)}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function JoinRow({ g }: { g: any }) {
  const { run } = useAction()
  return (
    <div className="chat-row" style={{ cursor: 'default' }}>
      <Avatar name={g.subject} size="sm" group />
      <div className="grow">
        <div style={{ fontWeight: 600, fontSize: 13 }}>{g.subject}</div>
        <div className="tiny faint">Not a member: messages here are invisible to the member number</div>
      </div>
      <button className="btn sm" onClick={() => run('join', () => post('/sandbox/api/member/join', { jid: g.jid }), `Joined ${g.subject}`)}>
        Join
      </button>
    </div>
  )
}

function DevicePanel({ device }: { device: any }) {
  const { run } = useAction()
  return (
    <div style={{ padding: 12, borderBottom: '1px solid var(--border)', background: 'var(--surface)' }} className="stack">
      <div className="row">
        <Link2 size={15} />
        <b>Linked devices</b>
        <span className="right" />
        <span className={`badge ${device.state === 'open' ? 'good' : device.state === 'logged_out' ? 'crit' : 'warn'}`}>{device.state.replace('_', ' ')}</span>
      </div>
      {device.state === 'awaiting_scan' && (
        <>
          <div className="tiny muted">The agent's linked client is showing a QR code (see Live lab). Scanning it links this number as a device.</div>
          <button className="btn primary sm" onClick={() => run('scan', () => post('/sandbox/api/device/scan'), 'Scanned: pairing, then 515 restart')}>
            <QrCode size={14} /> Scan QR
          </button>
        </>
      )}
      {device.state === 'open' && (
        <button className="btn danger sm" onClick={() => run('ban', () => post('/sandbox/api/device/ban'), 'Number banned (401 loggedOut)')}>
          <Ban size={14} /> Simulate ban
        </button>
      )}
      {(device.state === 'unlinked' || device.state === 'logged_out') && (
        <button className="btn sm" onClick={() => run('connect', () => post('/api/channels/sbx-linked/connect'), 'Linked client started: QR shown')}>
          <QrCode size={14} /> Start linking (show QR)
        </button>
      )}
    </div>
  )
}

function ChatScreen({ pid, chat, onBack }: { pid: string; chat: any; onBack: () => void }) {
  const [text, setText] = useState('')
  const [kind, setKind] = useState<'text' | 'ephemeral' | 'view_once'>('text')
  const [replyTo, setReplyTo] = useState<any>(null)
  const [editing, setEditing] = useState<any>(null)
  const [sheet, setSheet] = useState<any>(null)
  const [voiceMode, setVoiceMode] = useState(false)
  const [attach, setAttach] = useState<'none' | 'photo' | 'contact'>('none')
  const [contact, setContact] = useState({ name: 'Kiran (manager)', phone: '+91 90000 00012' })
  const { data: fixtures } = useApi<any[]>(chat.kind === 'dm' ? '/sandbox/api/fixtures' : null)
  const [voiceLang, setVoiceLang] = useState<'en' | 'hi'>('en')
  const body = useRef<HTMLDivElement>(null)
  const toast = useToast()
  const { run } = useAction()
  const linked = !['dm', 'api_group'].includes(chat.kind)
  useEffect(() => {
    body.current?.scrollTo({ top: body.current.scrollHeight })
  }, [chat.messages.length])

  const send = async () => {
    if (!text.trim()) return
    if (linked) {
      const payload = editing ? { jid: chat.id, kind: 'edit', text, targetId: editing.id } : replyTo ? { jid: chat.id, kind: 'reply', text, targetId: replyTo.id } : { jid: chat.id, kind, text }
      const r: any = await run('send', () => post(`/sandbox/api/personas/${pid}/linked`, payload))
      if (r?.ok) {
        setText('')
        setReplyTo(null)
        setEditing(null)
      }
    } else if (voiceMode && chat.kind === 'dm') {
      const r: any = await run('send', () => post(`/sandbox/api/personas/${pid}/voice`, { chatId: chat.id, text, lang: voiceLang }))
      if (r?.ok) setText('')
    } else {
      const r: any = await run('send', () => post(`/sandbox/api/personas/${pid}/send`, { chatId: chat.id, text }))
      if (r?.ok) setText('')
    }
  }

  const tap = async (m: any, b: any) => {
    const r: any = await api(`/sandbox/api/personas/${pid}/tap`, { body: { chatId: chat.id, messageId: m.id, buttonId: b.id } })
    if (!r.ok) return toast(r.error ?? 'failed', true)
    if (r.copied) {
      copy(r.copied)
      toast(`Code ${r.copied} copied. Paste it into the app.`)
    }
    if (r.joined) toast('Joined the group')
  }

  const linkedAction = (kind: string, m: any, t = '') => run('a', () => post(`/sandbox/api/personas/${pid}/linked`, { jid: chat.id, kind, text: t, targetId: m.id }))

  return (
    <>
      <div className="phone-bar">
        <button className="btn ghost icon" onClick={onBack} aria-label="Back">
          <ArrowLeft size={16} />
        </button>
        <Avatar name={chat.title} size="sm" group={chat.kind !== 'dm'} />
        <div className="grow">
          <div className="ellipsis" style={{ fontWeight: 650, fontSize: 13 }}>
            {chat.title}
          </div>
          <div className="tiny faint ellipsis">{chat.subtitle}</div>
        </div>
        {chat.kind === 'api_group' && (
          <button className="btn ghost sm" onClick={() => run('leave', () => post(`/sandbox/api/personas/${pid}/leave`, { groupId: chat.id }), 'Left group').then(onBack)}>
            <UserRoundX size={14} />
          </button>
        )}
      </div>
      {chat.kind === 'dm' && (
        <div className="tiny" style={{ padding: '5px 12px', background: chat.windowOpen ? 'var(--good-soft)' : 'var(--warn-soft)', color: chat.windowOpen ? 'var(--good-text)' : 'var(--warn-text)' }}>
          {chat.windowOpen ? 'Service window open: the business can reply freely for 24h' : 'No open service window: the business can only send templates'}
        </div>
      )}
      {linked && !chat.memberNumberJoined && <div className="tiny" style={{ padding: '5px 12px', background: 'var(--surface-3)' }}>The member number is not in this group: nothing here reaches the agent.</div>}
      <div className="phone-body" ref={body}>
        {chat.messages.map((m: any) => {
          const mine = m.personaId === pid || m.from === 'persona'
          if (['stub_add', 'stub_leave'].includes(m.kind) || m.kind === 'system') {
            return (
              <div key={m.id} className="msg sys">
                <div className="bubble">{m.senderName} {m.kind === 'stub_add' ? 'joined' : 'left'}</div>
              </div>
            )
          }
          if (m.kind === 'ciphertext') {
            return (
              <div key={m.id} className="msg sys">
                <div className="bubble">
                  <Lock size={10} /> {m.senderName}: waiting for this message (simulated decryption failure)
                </div>
              </div>
            )
          }
          const fromBiz = m.from === 'business'
          return (
            <div key={m.id} className={`msg ${mine && !fromBiz ? 'mine' : 'theirs'}`}>
              <div className="bubble">
                {chat.kind !== 'dm' && !mine && <div className="msg-sender">{m.senderName}</div>}
                {m.quoted && <div className="tiny faint" style={{ borderLeft: '3px solid var(--accent)', paddingLeft: 6, marginBottom: 4 }}>{m.quoted}</div>}
                {m.kind === 'image' ? (
                  <div className="stack" style={{ gap: 4 }}>
                    <img src={`/sandbox/api/media/${m.image?.mediaId}`} alt={m.image?.file} style={{ maxWidth: 200, borderRadius: 8, display: 'block' }} />
                    {m.text && <span>{m.text}</span>}
                  </div>
                ) : m.kind === 'location' ? (
                  <span className="row">
                    <MapPin size={13} /> {m.location?.name ?? 'Location'} ({m.location?.lat}, {m.location?.lng})
                  </span>
                ) : m.kind === 'contacts' ? (
                  <span className="row">
                    <Contact size={13} /> {m.contact?.name} · {m.contact?.phone}
                  </span>
                ) : m.kind === 'audio' ? (
                  <div className="stack" style={{ gap: 4 }}>
                    <span className="row tiny faint" style={{ gap: 4 }}>
                      <Mic size={12} /> {m.audio?.voice ? 'Voice message' : 'Audio file'}
                      {m.audio?.seconds ? ` · ${Math.floor(m.audio.seconds / 60)}:${String(Math.round(m.audio.seconds % 60)).padStart(2, '0')}` : ''}
                    </span>
                    <audio controls preload="none" src={`/sandbox/api/media/${m.audio?.mediaId}`} style={{ width: 210, height: 32 }} />
                    {m.spoken && <span className="tiny faint">said: “{m.spoken}”</span>}
                  </div>
                ) : m.kind === 'view_once' ? (
                  <span className="row">
                    <EyeOff size={13} /> View-once photo{m.text ? `: ${m.text}` : ''}
                  </span>
                ) : m.kind === 'ephemeral' ? (
                  <span className="row">
                    <Timer size={13} /> {m.text}
                  </span>
                ) : m.deleted ? (
                  <i className="faint">{m.text}</i>
                ) : (
                  m.text
                )}
                {m.footer && <div className="tiny faint" style={{ marginTop: 4 }}>{m.footer}</div>}
                {m.templateName && <div className="tiny faint" style={{ marginTop: 2 }}>template · {m.templateName}</div>}
                {m.buttons?.length > 0 && (
                  <div className="tpl-btns">
                    {m.buttons.map((b: any) => (
                      <button key={b.id} className="tpl-btn" disabled={!!m.tapped && b.kind !== 'copy_code' && b.kind !== 'join_group'} onClick={() => tap(m, b)}>
                        {b.kind === 'copy_code' && <Copy size={12} />} {b.kind === 'join_group' && <Users size={12} />} {b.title}
                        {m.tapped === b.id && ' ✓'}
                      </button>
                    ))}
                  </div>
                )}
                {m.list && (
                  <div className="tpl-btns">
                    <button className="tpl-btn" disabled={!!m.tapped} onClick={() => setSheet(m)}>
                      ☰ {m.list.button}
                    </button>
                  </div>
                )}
              </div>
              {m.reactions?.length > 0 && <div className="reactions">{m.reactions.join(' ')}</div>}
              <div className="msg-meta">
                {hm(m.at)}
                {m.edited && <span>· edited</span>}
                {mine && chat.kind === 'dm' && m.from === 'persona' && <span style={{ color: m.readByBusiness ? 'var(--lane-a)' : undefined }} title={m.readByBusiness ? 'Read by the business' : 'Delivered'}>{m.readByBusiness ? '✓✓' : '✓'}</span>}
                {fromBiz && m.pricing && <span title="Pricing label (sandbox estimate)">· {m.pricing}</span>}
                {linked && !m.deleted && (
                  <span className="msg-actions">
                    <button onClick={() => linkedAction('reaction', m, '👍')}>👍</button>
                    <button onClick={() => linkedAction('reaction', m, '❤️')}>❤️</button>
                    <button onClick={() => setReplyTo(m)}>reply</button>
                    {m.personaId === pid && <button onClick={() => (setEditing(m), setText(m.text))}>edit</button>}
                    {(m.personaId === pid || chat.isAdmin) && <button onClick={() => linkedAction('revoke', m)}>delete</button>}
                  </span>
                )}
              </div>
            </div>
          )
        })}
        {!chat.messages.length && <div className="tiny faint" style={{ textAlign: 'center', marginTop: 20 }}>No messages yet</div>}
        {chat.typing && <div className="tiny faint pulse" style={{ padding: '4px 12px' }}>{chat.title} is typing…</div>}
      </div>
      {sheet && (
        <div className="sheet">
          <div className="row between" style={{ marginBottom: 6 }}>
            <b>{sheet.list.button}</b>
            <button className="btn ghost sm" onClick={() => setSheet(null)}>
              Close
            </button>
          </div>
          {sheet.list.sections.map((s: any, i: number) => (
            <div key={i}>
              {s.title && <div className="tiny faint" style={{ padding: '4px 6px' }}>{s.title}</div>}
              {s.rows.map((r: any) => (
                <div
                  key={r.id}
                  className="sheet-row"
                  onClick={async () => {
                    await tap(sheet, r)
                    setSheet(null)
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{r.title}</div>
                  {r.description && <div className="tiny faint">{r.description}</div>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {chat.canPost === false ? (
        <div className="phone-foot tiny faint">
          <Megaphone size={13} /> Only admins can send messages to this group
        </div>
      ) : (
        <div className="stack" style={{ gap: 0 }}>
          {(replyTo || editing) && (
            <div className="row tiny" style={{ padding: '4px 10px', background: 'var(--surface-3)' }}>
              <span className="grow ellipsis">{editing ? `Editing: ${editing.text}` : `Replying to ${replyTo.senderName}: ${replyTo.text}`}</span>
              <button className="btn ghost sm" onClick={() => (setReplyTo(null), setEditing(null), setText(''))}>
                ✕
              </button>
            </div>
          )}
          <div className="phone-foot">
            {linked && !replyTo && !editing && (
              <select className="select" style={{ width: 92, padding: '6px 4px' }} value={kind} onChange={(e) => setKind(e.target.value as any)} aria-label="Message type">
                <option value="text">Text</option>
                <option value="ephemeral">Disappearing</option>
                <option value="view_once">View-once</option>
              </select>
            )}
            {chat.kind === 'dm' && (
              <>
                <button className={`btn icon ${attach === 'photo' ? 'primary' : 'ghost'}`} onClick={() => setAttach(attach === 'photo' ? 'none' : 'photo')} aria-label="Send a photo" title="Send a photo (synthetic test documents)">
                  <Camera size={15} />
                </button>
                <button
                  className="btn icon ghost"
                  aria-label="Share location"
                  title="Share a location (Kazipet)"
                  onClick={() => run('loc', () => post(`/sandbox/api/personas/${pid}/location`, { lat: 17.9971, lng: 79.5854, name: 'Kazipet yard' }))}
                >
                  <MapPin size={15} />
                </button>
                <button className={`btn icon ${attach === 'contact' ? 'primary' : 'ghost'}`} onClick={() => setAttach(attach === 'contact' ? 'none' : 'contact')} aria-label="Share a contact" title="Share a contact">
                  <Contact size={15} />
                </button>
              </>
            )}
            {chat.kind === 'dm' && (
              <button
                className={`btn icon ${voiceMode ? 'primary' : 'ghost'}`}
                onClick={() => setVoiceMode((v) => !v)}
                aria-label="Voice note"
                aria-pressed={voiceMode}
                title="Voice note: type what the persona says; it is spoken and sent as a WhatsApp voice note"
              >
                <Mic size={15} />
              </button>
            )}
            {voiceMode && chat.kind === 'dm' && (
              <select className="select" style={{ width: 82, padding: '6px 4px' }} value={voiceLang} onChange={(e) => setVoiceLang(e.target.value as 'en' | 'hi')} aria-label="Spoken language">
                <option value="en">English</option>
                <option value="hi">हिंदी</option>
              </select>
            )}
            <input
              className="input"
              placeholder={voiceMode && chat.kind === 'dm' ? (voiceLang === 'hi' ? 'क्या बोलना है…' : 'What do you say…') : 'Message'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send()}
            />
            <button className="btn primary icon" onClick={send} aria-label={voiceMode && chat.kind === 'dm' ? 'Send voice note' : 'Send'}>
              {voiceMode && chat.kind === 'dm' ? <Mic size={15} /> : <Send size={15} />}
            </button>
          </div>
          {attach === 'photo' && chat.kind === 'dm' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, padding: '6px 10px', maxHeight: 210, overflowY: 'auto', borderTop: '1px solid var(--border)' }}>
              {(fixtures ?? []).map((f) => (
                <button
                  key={f.file}
                  className="btn ghost"
                  style={{ padding: 2, flexDirection: 'column', gap: 2 }}
                  title={`${f.file} (${f.kind})`}
                  onClick={async () => {
                    await run('pic', () => post(`/sandbox/api/personas/${pid}/media`, { file: f.file }))
                    setAttach('none')
                  }}
                >
                  <img src={`/sandbox/api/fixtures/${f.file}`} alt={f.kind} style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', borderRadius: 6 }} />
                  <span className="tiny">{f.file.replace(/\.jpg$/, '')}</span>
                </button>
              ))}
            </div>
          )}
          {attach === 'contact' && chat.kind === 'dm' && (
            <div className="row wrap" style={{ padding: '6px 10px', borderTop: '1px solid var(--border)' }}>
              <input className="input" style={{ flex: 1, minWidth: 110 }} value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} aria-label="Contact name" />
              <input className="input" style={{ flex: 1, minWidth: 120 }} value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} aria-label="Contact phone" />
              <button className="btn sm primary" onClick={async () => (await run('ct', () => post(`/sandbox/api/personas/${pid}/contact`, contact)), setAttach('none'))}>
                Share
              </button>
            </div>
          )}
          {voiceMode && chat.kind === 'dm' && (
            <div className="tiny faint" style={{ padding: '4px 10px 6px' }}>
              Your words are spoken with this Mac's voice and sent as a voice note. In the sandbox the agent uses your words as the transcript; live numbers use Whisper.
            </div>
          )}
        </div>
      )}
    </>
  )
}

// ------------------------------------------------------------ controls

function Controls({ state, persona }: { state: any; persona: any }) {
  const [tab, setTab] = useState<'scenes' | 'faults' | 'tools'>('scenes')
  return (
    <div className="stack-lg">
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'scenes', label: 'Demo scenes' },
          { id: 'faults', label: 'Faults & rules' },
          { id: 'tools', label: 'Tools' },
        ]}
      />
      {tab === 'scenes' && <Scenes />}
      {tab === 'faults' && <Faults state={state} />}
      {tab === 'tools' && <Tools state={state} persona={persona} />}
    </div>
  )
}

function Scenes() {
  const { data: scenes } = useApi<any[]>('/sandbox/api/scenes', ['scenes'])
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const { run } = useAction()
  const toast = useToast()
  const runOne = (id: number) => run(`s${id}`, () => post(`/sandbox/api/scenes/${id}/run`))
  const runAll = async () => {
    setAll(true)
    let pass = 0
    for (const s of scenes ?? []) {
      const r: any = await runOne(s.id)
      if (r?.ok) pass++
    }
    setAll(false)
    toast(`${pass}/${scenes?.length} scenes passed`, pass !== scenes?.length)
  }
  const anyRunning = scenes?.some((s) => s.running) || all
  return (
    <div className="stack">
      <div className="row between">
        <div className="small muted">Each scene drives the personas and asserts what the agent did. They double as the automated test suite.</div>
        <button className="btn primary" disabled={anyRunning} onClick={runAll}>
          <Play size={14} /> Run all
        </button>
      </div>
      {scenes?.map((s) => (
        <div key={s.id} className="scene">
          <div className="row">
            {s.running ? <Clock size={15} className="pulse" /> : s.result ? s.result.ok ? <CheckCircle2 size={15} color="var(--good)" /> : <XCircle size={15} color="var(--crit)" /> : <span className="dot idle" />}
            <b className="grow small">
              {s.id}. {s.title}
            </b>
            {s.result && <span className="tiny faint">{(s.result.ms / 1000).toFixed(1)}s</span>}
            {s.result && (
              <button className="btn ghost sm" onClick={() => setOpen(open === s.id ? null : s.id)}>
                {open === s.id ? 'Hide' : 'Steps'}
              </button>
            )}
            <button className="btn sm" disabled={anyRunning} onClick={() => runOne(s.id)}>
              <Play size={12} /> Run
            </button>
          </div>
          <div className="tiny faint" style={{ marginTop: 3, marginLeft: 23 }}>
            {s.shows}
          </div>
          {open === s.id && s.result && (
            <ul className="scene-steps">
              {s.result.steps.map((st: string, i: number) => (
                <li key={i}>{st}</li>
              ))}
              {s.result.error && <li style={{ color: 'var(--crit-text)' }}>{s.result.error}</li>}
            </ul>
          )}
        </div>
      ))}
    </div>
  )
}

function Faults({ state }: { state: any }) {
  const { run } = useAction()
  const f = state.faults
  const set = (body: any, msg: string) => run('f', () => post('/sandbox/api/faults', body), msg)
  return (
    <div className="stack-lg">
      <div className="card card-pad stack">
        <h2>Webhook delivery</h2>
        <Field label={`Duplicate deliveries: ${Math.round(f.duplicateRate * 100)}% of POSTs`} hint="Meta does not guarantee exactly-once delivery. The agent dedupes on (field, id, status).">
          <input type="range" min={0} max={100} step={25} value={f.duplicateRate * 100} onChange={(e) => set({ duplicateRate: Number(e.target.value) / 100 }, 'Duplicate rate updated')} />
        </Field>
        <label className="check">
          <input type="checkbox" checked={f.outOfOrder} onChange={(e) => set({ outOfOrder: e.target.checked }, 'Out-of-order statuses ' + (e.target.checked ? 'on' : 'off'))} />
          <span>
            Out-of-order statuses
            <div className="tiny faint">Adds jitter so "delivered" can arrive before "sent". The agent never downgrades a status.</div>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={state.autoRead} onChange={(e) => set({ autoRead: e.target.checked }, 'Auto-read ' + (e.target.checked ? 'on' : 'off'))} />
          <span>
            Personas read messages automatically
            <div className="tiny faint">Off: messages stop at "delivered".</div>
          </span>
        </label>
        <div className="row">
          <button className="btn" onClick={() => run('fail', () => post('/api/test/fail-webhooks', { count: 2 }), 'Agent will 500 the next 2 webhooks; watch the retries')}>
            Make agent return 500 twice
          </button>
        </div>
      </div>
      <div className="card card-pad stack">
        <h2>Business number</h2>
        <label className="check">
          <input type="checkbox" checked={state.business.oba} onChange={(e) => run('oba', () => post('/sandbox/api/business/oba', { on: e.target.checked }))} />
          <span>
            Official Business Account (blue tick)
            <div className="tiny faint">Groups API requires it. Turn it off and create a group to see the async failure.</div>
          </span>
        </label>
        <dl className="kv">
          <dt>Display</dt>
          <dd>{fmtPhone(state.business.displayPhone)}</dd>
          <dt>Phone number ID</dt>
          <dd><code>{state.business.phoneNumberId}</code></dd>
          <dt>WABA ID</dt>
          <dd><code>{state.business.wabaId}</code></dd>
        </dl>
      </div>
    </div>
  )
}

function Tools({ state, persona }: { state: any; persona: any }) {
  const { busy, run } = useAction()
  const [confirmReset, setConfirmReset] = useState(false)
  const startFromApp = async () => {
    const s: any = await post('/api/app/session', {})
    await run('start', () => post(`/sandbox/api/personas/${persona.id}/send`, { chatId: 'dm', text: s.startText }), `${persona.name} opened the wa.me link from the app`)
  }
  return (
    <div className="stack-lg">
      <div className="card card-pad stack">
        <h2>Scripted group chatter</h2>
        <div className="small muted">40 events across the 300-member Founders Circle and the City Runners Community: edits, deletes, reactions, view-once, PII, an injection, an admin-only post attempt, and the member number joining Gear Talk late.</div>
        <button className="btn primary" disabled={state.chatterRunning} onClick={() => run('chat', () => post('/sandbox/api/chatter/play'), 'Playing chatter (about 15s)')}>
          <Play size={14} /> {state.chatterRunning ? 'Playing…' : 'Play chatter'}
        </button>
        <div className="tiny faint">Tip: record admin consent on the Groups page first, or watch the consent gate drop everything.</div>
      </div>
      {persona && (
        <div className="card card-pad stack">
          <div className="row">
            <Avatar name={persona.name} size="sm" hue={persona.hue} />
            <h2>{persona.name}</h2>
          </div>
          <dl className="kv">
            <dt>Phone</dt>
            <dd>{fmtPhone(persona.pn)}{persona.hiddenNumber ? ' (hidden from the Cloud API)' : ''}</dd>
            <dt>BSUID</dt>
            <dd><code>{persona.bsuid}</code></dd>
            <dt>LID</dt>
            <dd><code>{persona.lid}@lid</code></dd>
            <dt>Phone in groups</dt>
            <dd>{persona.pnInGroups ? 'exposed (participantAlt)' : 'hidden'}</dd>
          </dl>
          <div className="row wrap">
            <button className="btn sm" disabled={busy === 'start' || persona.id === 'member'} onClick={startFromApp}>
              <Link2 size={13} /> Open wa.me link from the app
            </button>
            <button className="btn sm" onClick={() => run('exp', () => post(`/sandbox/api/personas/${persona.id}/expire-window`), '24h window expired')}>
              <Timer size={13} /> Expire 24h window
            </button>
            {!persona.pnInGroups && (
              <button className="btn sm" onClick={() => run('lid', () => post(`/sandbox/api/personas/${persona.id}/reveal-lid`), 'lid-mapping.update emitted')}>
                Reveal LID → phone
              </button>
            )}
          </div>
        </div>
      )}
      <div className="card card-pad stack">
        <h2>Linked device</h2>
        <div className="row">
          <StatusPill status={state.device.state === 'open' ? 'open' : state.device.state === 'awaiting_scan' ? 'qr' : state.device.state === 'logged_out' ? 'logged_out' : 'disconnected'} />
          <span className="tiny faint">member number {fmtPhone('15555550199')}</span>
        </div>
        <div className="row wrap">
          {state.device.state === 'awaiting_scan' && (
            <button className="btn sm primary" onClick={() => run('scan', () => post('/sandbox/api/device/scan'), 'Scanned')}>
              <QrCode size={13} /> Scan QR as member phone
            </button>
          )}
          {(state.device.state === 'unlinked' || state.device.state === 'logged_out') && (
            <button className="btn sm" onClick={() => run('conn', () => post('/api/channels/sbx-linked/connect'), 'QR shown')}>
              <QrCode size={13} /> Start linking
            </button>
          )}
          {state.device.state === 'open' && (
            <button className="btn sm danger" onClick={() => run('ban', () => post('/sandbox/api/device/ban'), 'Banned')}>
              <Ban size={13} /> Simulate ban
            </button>
          )}
        </div>
      </div>
      <div className="card card-pad stack">
        <h2>Reset</h2>
        <Callout kind="plain">Re-seeds the simulated world and clears sandbox conversations, contacts and digests. Live channels are untouched.</Callout>
        {confirmReset ? (
          <div className="row">
            <button className="btn danger" onClick={async () => (await run('reset', () => post('/sandbox/api/reset'), 'Sandbox reset'), setConfirmReset(false))}>
              <RotateCcw size={14} /> Yes, reset the sandbox
            </button>
            <button className="btn ghost" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <button className="btn" onClick={() => setConfirmReset(true)}>
            <RotateCcw size={14} /> Reset sandbox…
          </button>
        )}
      </div>
    </div>
  )
}
