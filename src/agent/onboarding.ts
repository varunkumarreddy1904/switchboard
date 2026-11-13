import { randomInt } from 'node:crypto'
import { readToken, sha256, signToken } from '../shared/crypto'
import { uid } from '../shared/ids'
import type { Agent } from './agent'

const NONCE_TTL = 10 * 60 * 1000
const MAGIC_TTL = 15 * 60 * 1000
const OTP_TTL = 10 * 60 * 1000
const OTP_ATTEMPTS = 5

export type { InboundDm } from './inbound'

/**
 * Sign-in for the app that sits next to WhatsApp (the HYKR app in PoC #12). Two ways in:
 *  Continue on WhatsApp: the app opens wa.me with `START <signed session token>`; the inbound message
 *          itself proves who holds the WhatsApp account, so no code is needed.
 *  Code (OTP): the user types a phone number in the app; we send a copy-code authentication template and
 *          the user types the code back into the app.
 * A sign-in link (magic link) sent on WhatsApp signs an existing user into the app.
 * What the conversation itself does is up to the brain (src/hykr), not this class.
 */
export class Onboarding {
  constructor(private agent: Agent) {}

  private get store() {
    return this.agent.store
  }
  private get bus() {
    return this.agent.bus
  }

  // ------------------------------------------------------------ app sessions

  createSession(channelId: string) {
    const ch = this.agent.cloudChannel(channelId)
    const id = uid('ses')
    this.store.sql.run("insert into app_sessions(id, channel_id, created_at, status, method) values(?,?,?, 'pending', null)", id, channelId, Date.now())
    const token = signToken(this.agent.secret, id, NONCE_TTL)
    const phone = (ch.config.displayPhone ?? '').replace(/\D/g, '')
    const waLink = `https://wa.me/${phone}?text=${encodeURIComponent(`START ${token}`)}`
    return { id, token, waLink, startText: `START ${token}`, expiresInMinutes: NONCE_TTL / 60000 }
  }

  session(id: string) {
    const s = this.store.sql.get<{ id: string; status: string; person_id: string | null; method: string | null; channel_id: string }>('select * from app_sessions where id=?', id)
    if (!s) return undefined
    const p = s.person_id ? this.store.person(s.person_id) : undefined
    return { ...s, person: p ? { id: p.id, name: p.display_name, status: p.account_status, role: p.role, cadence: p.cadence } : null }
  }

  private signIn(sessionId: string, personId: string, method: string) {
    this.store.sql.run("update app_sessions set status='signed_in', person_id=?, method=? where id=?", personId, method, sessionId)
    this.bus.log({ kind: 'agent', lane: 'A', title: 'App session signed in', detail: `method: ${method}` })
    this.bus.change('onboarding', { sessionId })
  }

  redeemMagic(token: string) {
    const r = readToken(this.agent.secret, token)
    if ('error' in r) return { ok: false as const, error: `Magic link ${r.error}` }
    const [sessionId, personId] = r.payload.split(':')
    const used = this.store.sql.get<{ magic_token: string | null }>('select magic_token from app_sessions where id=?', sessionId)
    if (used?.magic_token === 'used') return { ok: false as const, error: 'Magic link already used' }
    this.store.sql.run("update app_sessions set magic_token='used' where id=?", sessionId)
    this.signIn(sessionId, personId, 'magic_link')
    return { ok: true as const, session: this.session(sessionId) }
  }

  // ------------------------------------------------------------ path B: OTP

  async startOtp(sessionId: string, phoneInput: string) {
    const s = this.session(sessionId)
    if (!s) return { ok: false, error: 'unknown session' }
    const phone = phoneInput.replace(/\D/g, '')
    if (phone.length < 8 || phone.length > 15) return { ok: false, error: 'Enter the number in international format, e.g. +44 7700 900101' }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const id = uid('otp')
    const client = this.agent.client(s.channel_id)
    const res = await client.sendOtp(phone, code)
    const wamid = res.json?.messages?.[0]?.id
    this.store.sql.run(
      'insert into otps(id, session_id, channel_id, phone, code_hash, expires_at, attempts, status, wamid, error) values(?,?,?,?,?,?,0,?,?,?)',
      id,
      sessionId,
      s.channel_id,
      phone,
      sha256(`${id}:${code}`),
      Date.now() + OTP_TTL,
      res.ok ? 'sent' : 'failed',
      wamid,
      res.ok ? null : res.error?.message,
    )
    this.bus.log({ kind: 'agent', lane: 'A', title: res.ok ? 'OTP sent via authentication template' : 'OTP send failed', detail: res.ok ? `to +${phone}; code is never stored in plain text` : res.error?.message })
    return res.ok ? { ok: true, otpId: id } : { ok: false, error: res.error?.message ?? 'send failed', otpId: id }
  }

  otpStatus(otpId: string) {
    return this.store.sql.get<{ id: string; status: string; error: string | null; attempts: number; expires_at: number }>('select id, status, error, attempts, expires_at from otps where id=?', otpId)
  }

  /** Called from status webhooks: an undeliverable OTP should show in the app, not hang. */
  onOtpStatus(wamid: string, status: string, error?: string) {
    const o = this.store.sql.get<{ id: string; status: string }>('select id, status from otps where wamid=?', wamid)
    if (!o || o.status === 'verified') return
    if (status === 'failed') this.store.sql.run("update otps set status='failed', error=? where id=?", error ?? 'delivery failed', o.id)
    else if (status === 'delivered' || status === 'read') this.store.sql.run("update otps set status='delivered' where id=? and status='sent'", o.id)
    this.bus.change('onboarding', { otpId: o.id })
  }

  verifyOtp(otpId: string, code: string) {
    const o = this.store.sql.get<{ id: string; session_id: string; channel_id: string; phone: string; code_hash: string; expires_at: number; attempts: number; status: string }>('select * from otps where id=?', otpId)
    if (!o) return { ok: false, error: 'unknown code request' }
    if (o.status === 'verified') return { ok: false, error: 'code already used' }
    if (o.status === 'failed') return { ok: false, error: 'code was never delivered' }
    if (Date.now() > o.expires_at) return { ok: false, error: 'code expired, request a new one' }
    if (o.attempts >= OTP_ATTEMPTS) return { ok: false, error: 'too many attempts, request a new code' }
    this.store.sql.run('update otps set attempts=attempts+1 where id=?', o.id)
    if (sha256(`${o.id}:${code.trim()}`) !== o.code_hash) return { ok: false, error: `wrong code (${OTP_ATTEMPTS - o.attempts - 1} attempts left)` }
    this.store.sql.run("update otps set status='verified' where id=?", o.id)
    let personId = this.store.findByLink('pn', o.phone)
    if (!personId) personId = this.store.createPerson(`+${o.phone}`).id
    personId = this.agent.identity.attachPhone(personId, o.phone, 'otp', o.channel_id)
    this.store.sql.run("update persons set account_status='active' where id=? and account_status!='active'", personId)
    this.signIn(o.session_id, personId, 'otp')
    this.bus.change('contacts')
    return { ok: true, session: this.session(o.session_id) }
  }

  /**
   * The brain calls this when a message starts with `START <token>`: ties the app session to the person who
   * sent it and signs the app in. Returns the session id, or null if the token is bad or already used.
   */
  linkStartToken(token: string, personId: string): string | null {
    const r = readToken(this.agent.secret, token)
    if ('error' in r) {
      this.bus.log({ kind: 'agent', lane: 'A', title: 'START token rejected', detail: r.error })
      return null
    }
    const used = this.store.sql.get<{ nonce_used: number }>('select nonce_used from app_sessions where id=?', r.payload)
    if (!used || used.nonce_used) {
      this.bus.log({ kind: 'agent', lane: 'A', title: 'START token already used', detail: 'single-use nonce' })
      return null
    }
    this.store.sql.run('update app_sessions set nonce_used=1 where id=?', r.payload)
    this.signIn(r.payload, personId, 'whatsapp')
    return r.payload
  }

  /** A fresh, already-linked session, for sign-in links sent to someone who started on WhatsApp. */
  newSessionFor(channelId: string, personId: string) {
    const id = uid('ses')
    this.store.sql.run("insert into app_sessions(id, channel_id, created_at, person_id, status, nonce_used) values(?,?,?,?, 'linked', 1)", id, channelId, Date.now(), personId)
    return id
  }

  /** A one-time link that signs this person into the app (valid 15 minutes). */
  magicLink(sessionId: string, personId: string) {
    const token = signToken(this.agent.secret, `${sessionId}:${personId}`, MAGIC_TTL)
    return `${this.agent.publicBase()}/app/magic/${token}`
  }

  /** The app's view of a session: who is signed in. */
  signedInPerson(sessionId: string | undefined): string | null {
    if (!sessionId) return null
    const s = this.store.sql.get<{ status: string; person_id: string | null }>('select status, person_id from app_sessions where id=?', sessionId)
    return s?.status === 'signed_in' && s.person_id ? s.person_id : null
  }

  signOut(sessionId: string) {
    this.store.sql.run("update app_sessions set status='signed_out' where id=?", sessionId)
  }
}
