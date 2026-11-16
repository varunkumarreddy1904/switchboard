import { CheckCircle2, Mic, XCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Callout, Field, useAction } from '../components/ui'
import { post, useApi } from '../lib/api'

export function Settings() {
  const { data, reload } = useApi<any>('/api/settings', ['channels'])
  const [publicBaseUrl, setPublic] = useState('')
  const [key, setKey] = useState('')
  const [model, setModel] = useState('')
  const { busy, run } = useAction()
  useEffect(() => {
    if (data) {
      setPublic(data.publicBaseUrl)
      setModel(data.model)
    }
  }, [data?.publicBaseUrl, data?.model])
  if (!data) return <div className="page" />
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Everything is stored locally in <code>data/agent.db</code>. Secrets are stored in plain text because this is a local proof of concept; use a secrets manager before deploying anywhere.</p>
        </div>
      </div>
      <div className="grid cols-2">
        <div className="card card-pad stack-lg">
          <h2>Public URL</h2>
          <Field label="Public base URL" hint={`Used for webhook URLs shown in Live lab and for magic links. Now: ${data.effectivePublicBase}`}>
            <input className="input" placeholder="https://your-tunnel.trycloudflare.com" value={publicBaseUrl} onChange={(e) => setPublic(e.target.value)} />
          </Field>
          <button className="btn primary" disabled={busy === 'pub'} onClick={async () => (await run('pub', () => post('/api/settings', { publicBaseUrl }), 'Saved'), reload())}>
            Save
          </button>
          <Callout kind="plain">
            Run <code>cloudflared tunnel --url http://localhost:4000</code> and paste the https URL here. Sandbox traffic keeps using <code>{data.internalBase}</code>.
          </Callout>
        </div>
        <div className="card card-pad stack-lg">
          <h2>Claude (digests, Q&A, support replies)</h2>
          <div className="small">
            Status:{' '}
            {data.hasApiKey ? (
              <span className="badge good">
                {data.provider === 'openrouter' ? 'OpenRouter' : 'Anthropic'} key set ({data.apiKeySource})
              </span>
            ) : (
              <span className="badge">No key: offline engine</span>
            )}
            {data.hasApiKey && data.provider === 'openrouter' && <span className="tiny faint"> · calls go to OpenRouter as {data.providerModel}</span>}
          </div>
          <Field label="API key (Anthropic or OpenRouter)" hint="sk-ant-… goes to Anthropic; sk-or-… goes to OpenRouter's Claude endpoint. Leave empty to keep the current key.">
            <input className="input" type="password" placeholder="sk-ant-… or sk-or-…" value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <Field
            label="Model"
            hint={
              data.provider === 'openrouter'
                ? 'Claude ids are translated for OpenRouter (claude-haiku-5-5 → anthropic/claude-haiku-5.5). OpenRouter does not take Anthropic’s server-side refusal fallbacks.'
                : 'Default claude-opus-5-5. Refusals fall back server-side (fallbacks: default).'
            }
          >
            <input className="input" value={model} onChange={(e) => setModel(e.target.value)} />
          </Field>
          <div className="row">
            <button className="btn primary" disabled={busy === 'key'} onClick={async () => (await run('key', () => post('/api/settings', { ...(key ? { anthropicApiKey: key } : {}), anthropicModel: model }), 'Saved'), setKey(''), reload())}>
              Save
            </button>
            {data.apiKeySource === 'settings' && (
              <button className="btn danger" onClick={async () => (await run('rm', () => post('/api/settings', { anthropicApiKey: null }), 'Key removed'), reload())}>
                Remove stored key
              </button>
            )}
          </div>
        </div>
      </div>
      <VoiceSettings />
      <HykrSettings />
    </div>
  )
}

/** PoC #12: whether simulator photos are read by Claude (real call, small cost) or from the fixtures' known contents. */
function HykrSettings() {
  const { data, reload } = useApi<any>('/api/hx/settings', ['hykr'])
  const { run } = useAction()
  if (!data) return null
  return (
    <div className="card card-pad stack" style={{ marginTop: 16 }}>
      <h2>EquipXchange onboarding (PoC #12)</h2>
      <label className="row small" style={{ gap: 8 }}>
        <input type="checkbox" checked={data.claudeInSandbox} onChange={async (e) => (await run('hx', () => post('/api/hx/settings', { claudeInSandbox: e.target.checked }), 'Saved'), reload())} />
        Read simulator photos with Claude too (a real call, about $0.0002 per photo). Off: the sandbox uses each test document’s known contents, so scenes are exact. Live numbers always use Claude when a key is set.
      </label>
    </div>
  )
}

const Check = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => (
  <div className="row small" style={{ gap: 6, alignItems: 'flex-start' }}>
    {ok ? <CheckCircle2 size={15} style={{ color: 'var(--good)', flex: 'none', marginTop: 2 }} /> : <XCircle size={15} style={{ color: 'var(--crit)', flex: 'none', marginTop: 2 }} />}
    <span>{children}</span>
  </div>
)

/** Voice notes: what is installed, how the bot answers, which voices, and how long recordings are kept. */
function VoiceSettings() {
  const { data: st, reload } = useApi<any>('/api/voice/status', ['channels'])
  const [f, setF] = useState<any>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const { busy, run } = useAction()
  useEffect(() => {
    if (st) setF(st.settings)
  }, [st])
  if (!st || !f) return null
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value })
  const voices = (prefix: string) => (st.voices as { name: string; locale: string }[]).filter((v) => v.locale.startsWith(prefix))
  const voicePicker = (k: 'voiceEn' | 'voiceHi' | 'voiceTe', prefix: string) => {
    const list = voices(prefix)
    // `say -v Tara` picks "Tara (English (India))", so a short saved name matches the full one.
    const current = list.find((v) => v.name === f[k] || v.name.startsWith(`${f[k]} (`))
    return list.length ? (
      <select className="select" value={current?.name ?? f[k]} onChange={set(k)}>
        {!current && <option value={f[k]}>{f[k]} (not installed)</option>}
        {list.map((v) => (
          <option key={v.name} value={v.name}>
            {v.name} · {v.locale}
          </option>
        ))}
      </select>
    ) : (
      <input className="input" value={f[k]} onChange={set(k)} />
    )
  }
  const [sarvamKey, setSarvamKey] = useState('')
  const speak = async (lang: 'en' | 'hi' | 'te') => {
    const r: any = await run(`pv-${lang}`, () => post('/api/voice/preview', { lang }))
    if (r?.ok) setPreview(r.id)
  }
  return (
    <div className="card card-pad stack-lg" style={{ marginTop: 16 }}>
      <div className="row" style={{ gap: 8 }}>
        <Mic size={18} />
        <h2>Voice notes</h2>
      </div>
      <p className="small faint" style={{ margin: 0 }}>
        People can onboard and ask questions with WhatsApp voice notes. {st.sarvam.inUse
          ? 'Speech goes through Sarvam: each recording is sent to Sarvam to be turned into text, and the words of a spoken reply are sent to Sarvam to be voiced.'
          : "Each note is turned into text on this Mac with Whisper, and replies are spoken back with the Mac's voices. Audio is not sent to any other service."}{' '}
        The transcript goes to Claude only if a key is set (through OpenRouter when it is an OpenRouter key), with phone numbers and emails masked.
      </p>
      <div className="grid cols-2">
        <div className="stack">
          <Check ok={st.stt.ok}>Speech-to-text: {st.stt.detail}</Check>
          <Check ok={st.tts.ok}>Text-to-speech: {st.tts.detail}</Check>
          <Check ok={!!st.tools.ffmpeg}>ffmpeg: {st.tools.ffmpeg ?? 'not installed (brew install ffmpeg)'}</Check>
          <Check ok={st.model.found}>
            Whisper model: <code>{st.model.path}</code>
            {st.model.found ? ` (${Math.round(st.model.bytes / 1e6)} MB)` : ' not found'}
          </Check>
          <div className="small faint">
            Recordings kept now: {st.stored.files} ({Math.round(st.stored.bytes / 1024)} KB). Raw audio is deleted after {st.settings.retentionHours} h; transcripts stay in the inbox.
          </div>
        </div>
        <div className="stack">
          <Field label="Reply with voice" hint="Mirror: answer with a voice note when the person's last message was one. Links and buttons are always sent as text too.">
            <select className="select" value={f.replies} onChange={set('replies')}>
              <option value="mirror">When they sent a voice note</option>
              <option value="always">Always</option>
              <option value="never">Never (text only)</option>
            </select>
          </Field>
          <Field label="Speech engine" hint="Sarvam hears and speaks Telugu, Hindi and English. With Sarvam, recordings and the words to speak are sent to Sarvam's servers.">
            <select className="select" value={f.engine} onChange={set('engine')}>
              <option value="auto">Sarvam when a key is set, otherwise this Mac</option>
              <option value="sarvam">Sarvam</option>
              <option value="local">This Mac only (Whisper and macOS voices)</option>
            </select>
          </Field>
          <Field label="Sarvam API key" hint={st.sarvam.hasKey ? `A key is set (${st.sarvam.keySource === 'env' ? 'from SARVAM_API_KEY' : 'saved in Settings'}). Paste a new one to replace it.` : 'From dashboard.sarvam.ai. Kept in this Mac’s database; never shown again.'}>
            <div className="row" style={{ gap: 8 }}>
              <input className="input" type="password" autoComplete="off" placeholder={st.sarvam.hasKey ? '••••••••' : 'Paste the key'} value={sarvamKey} onChange={(e) => setSarvamKey(e.target.value)} />
              {st.sarvam.keySource === 'settings' && (
                <button className="btn" disabled={busy === 'sarvam-rm'} onClick={async () => (await run('sarvam-rm', () => post('/api/settings', { sarvamApiKey: null }), 'Sarvam key removed'), reload())}>
                  Remove
                </button>
              )}
            </div>
          </Field>
          {st.sarvam.inUse ? (
            <div className="grid cols-2">
              <Field label="Sarvam voice: English" hint={`Default ${st.sarvam.defaultSpeakers.en}`}>
                <input className="input" value={f.sarvamSpeakerEn} onChange={set('sarvamSpeakerEn')} />
              </Field>
              <Field label="Sarvam voice: Hindi" hint={`Default ${st.sarvam.defaultSpeakers.hi}`}>
                <input className="input" value={f.sarvamSpeakerHi} onChange={set('sarvamSpeakerHi')} />
              </Field>
              <Field label="Sarvam voice: Telugu" hint={`Default ${st.sarvam.defaultSpeakers.te}`}>
                <input className="input" value={f.sarvamSpeakerTe} onChange={set('sarvamSpeakerTe')} />
              </Field>
            </div>
          ) : (
            <div className="grid cols-2">
              <Field label="English voice">{voicePicker('voiceEn', 'en_')}</Field>
              <Field label="Hindi voice">{voicePicker('voiceHi', 'hi_')}</Field>
              <Field label="Telugu voice" hint="macOS needs a Telugu voice downloaded; otherwise use Sarvam.">
                {voicePicker('voiceTe', 'te_')}
              </Field>
            </div>
          )}
          <div className="grid cols-2">
            <Field label="Longest voice note (seconds)">
              <input className="input" type="number" min={5} max={600} value={f.maxSeconds} onChange={set('maxSeconds')} />
            </Field>
            <Field label="Delete recordings after (hours)">
              <input className="input" type="number" min={1} value={f.retentionHours} onChange={set('retentionHours')} />
            </Field>
          </div>
          <Field label="Whisper model file" hint="Relative to the project folder.">
            <input className="input" value={f.whisperModel} onChange={set('whisperModel')} />
          </Field>
          <label className="row small" style={{ gap: 8 }}>
            <input type="checkbox" checked={f.sandboxWhisper} onChange={set('sandboxWhisper')} />
            Run Whisper on simulator voice notes too (slower; by default the sandbox uses the words you typed)
          </label>
        </div>
      </div>
      <div className="row wrap">
        <button
          className="btn primary"
          disabled={busy === 'voice'}
          onClick={async () => {
            await run('voice', () => post('/api/settings', { ...(sarvamKey.trim() ? { sarvamApiKey: sarvamKey.trim() } : {}), voice: { ...f, maxSeconds: Number(f.maxSeconds), retentionHours: Number(f.retentionHours) } }), 'Voice settings saved')
            setSarvamKey('')
            reload()
          }}
        >
          Save
        </button>
        <button className="btn" disabled={!st.tts.ok || busy === 'pv-en'} onClick={() => speak('en')}>
          Hear English voice
        </button>
        <button className="btn" disabled={!st.tts.ok || busy === 'pv-hi'} onClick={() => speak('hi')}>
          Hear Hindi voice
        </button>
        <button className="btn" disabled={!st.tts.ok || busy === 'pv-te'} onClick={() => speak('te')}>
          Hear Telugu voice
        </button>
        {preview && <audio key={preview} controls autoPlay src={`/api/media/${preview}`} style={{ height: 34 }} />}
      </div>
      {!st.stt.ok && (
        <Callout kind="warn">
          Without speech-to-text, voice notes still arrive in the inbox (playable) and the bot asks the person to type instead. Install with <code>brew install whisper-cpp</code> and download a model into <code>models/whisper/</code>.
        </Callout>
      )}
    </div>
  )
}
