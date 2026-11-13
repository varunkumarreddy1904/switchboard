import type { Bus } from '../shared/bus'
import type { CloudChannel } from './channels'

export interface GraphResponse {
  ok: boolean
  status: number
  json: any
  error?: { code?: number; message: string; details?: string }
}

/**
 * Minimal WhatsApp Cloud API client. The only difference between the sandbox and
 * production is `graphBase` (http://<host>/graph vs https://graph.facebook.com) and credentials.
 */
export class CloudClient {
  constructor(
    private ch: CloudChannel,
    private bus: Bus,
    /** Called when Meta rejects the channel's own access token (#190: expired, revoked or malformed). */
    private onAuthError?: (detail: string) => void,
  ) {}

  private get cfg() {
    return this.ch.config
  }

  async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, bearer = this.cfg.accessToken): Promise<GraphResponse> {
    const url = `${this.cfg.graphBase.replace(/\/$/, '')}/${this.cfg.graphVersion}/${path.replace(/^\//, '')}`
    let status = 0
    let json: any = undefined
    try {
      const form = body instanceof FormData
      const res = await fetch(url, {
        method,
        // FormData sets its own multipart content-type (with the boundary).
        headers: { authorization: `Bearer ${bearer}`, ...(body && !form ? { 'content-type': 'application/json' } : {}) },
        body: form ? body : body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(form ? 60_000 : 20_000),
      })
      status = res.status
      const text = await res.text()
      try {
        json = text ? JSON.parse(text) : {}
      } catch {
        json = { raw: text.slice(0, 500) }
      }
    } catch (e) {
      json = { error: { message: (e as Error).message } }
    }
    const ok = status >= 200 && status < 300
    const err = json?.error
    // #190 on the channel's own token means Meta no longer accepts it (most often: a temporary token ran out).
    const authFail = !ok && err?.code === 190 && bearer === this.cfg.accessToken
    const details: string | undefined = err?.error_data?.details ?? (authFail ? 'The access token expired or was revoked. Paste a new one on the Live lab card.' : undefined)
    this.bus.log({
      kind: 'graph.request',
      lane: 'A',
      live: this.ch.mode === 'live',
      // Never put a token into the event log (debug_token takes one in the query string).
      title: `${method} /${this.cfg.graphVersion}/${path.replace(/((?:input|access)_token=)[^&]+/g, '$1••••')}`,
      status: status || undefined,
      detail: ok ? summarize(path, body, json) : `${err?.code ? `#${err.code} ` : ''}${err?.message ?? 'request failed'}${details ? ` — ${details}` : ''}`,
      payload: { request: body instanceof FormData ? Object.fromEntries([...body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<file ${v.type} ${v.size} bytes>`])) : body, response: json },
    })
    if (authFail) this.onAuthError?.(`Meta rejected the access token (#190${err?.error_subcode ? `, subcode ${err.error_subcode}` : ''}): ${String(err?.message ?? 'Authentication Error').replace(/\.?\s*$/, '.')} Paste a new token below.`)
    return {
      ok,
      status,
      json,
      error: ok ? undefined : { code: err?.code, message: err?.message ?? `HTTP ${status}`, details },
    }
  }

  private msg(to: string, payload: Record<string, unknown>) {
    return this.request('POST', `${this.cfg.phoneNumberId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload })
  }

  sendText(to: string, body: string) {
    return this.msg(to, { type: 'text', text: { preview_url: true, body } })
  }

  sendButtons(to: string, body: string, buttons: { id: string; title: string }[], footer?: string) {
    return this.msg(to, {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        ...(footer ? { footer: { text: footer } } : {}),
        action: { buttons: buttons.map((b) => ({ type: 'reply', reply: b })) },
      },
    })
  }

  sendList(to: string, body: string, button: string, rows: { id: string; title: string; description?: string }[], sectionTitle = 'Options') {
    return this.msg(to, { type: 'interactive', interactive: { type: 'list', body: { text: body }, action: { button, sections: [{ title: sectionTitle, rows }] } } })
  }

  sendTemplate(to: string, name: string, language: string, components: unknown[] = []) {
    return this.msg(to, { type: 'template', template: { name, language: { code: language }, components } })
  }

  /** Authentication template with a copy-code button: the code goes in the body and the URL button param. */
  sendOtp(to: string, code: string) {
    return this.sendTemplate(to, this.cfg.otpTemplate, this.cfg.otpLanguage, [
      { type: 'body', parameters: [{ type: 'text', text: code }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
    ])
  }

  sendGroupText(groupId: string, body: string) {
    return this.request('POST', `${this.cfg.phoneNumberId}/messages`, { messaging_product: 'whatsapp', recipient_type: 'group', to: groupId, type: 'text', text: { body } })
  }

  createGroup(subject: string, description?: string) {
    return this.request('POST', `${this.cfg.phoneNumberId}/groups`, { messaging_product: 'whatsapp', subject, ...(description ? { description } : {}), join_approval_mode: 'auto_approve' })
  }

  getGroup(groupId: string, fields = 'subject,participants,total_participant_count') {
    return this.request('GET', `${groupId}?fields=${fields}`)
  }

  inviteLink(groupId: string) {
    return this.request('GET', `${groupId}/invite_link`)
  }

  removeParticipants(groupId: string, participants: ({ user: string } | { user_id: string })[]) {
    return this.request('DELETE', `${groupId}/participants`, { messaging_product: 'whatsapp', participants })
  }

  listTemplates() {
    return this.request('GET', `${this.cfg.wabaId}/message_templates?limit=100`)
  }

  createTemplate(def: { name: string; language: string; category: string; components: unknown[] }) {
    return this.request('POST', `${this.cfg.wabaId}/message_templates`, def)
  }

  /**
   * Blue ticks for an inbound message, optionally with "typing…" (Meta shows it until we reply, or about
   * 25 seconds). Only valid for messages the user sent us.
   */
  markRead(messageId: string, typing = false) {
    return this.request('POST', `${this.cfg.phoneNumberId}/messages`, {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
      ...(typing ? { typing_indicator: { type: 'text' } } : {}),
    })
  }

  sendAudio(to: string, mediaId: string, voice = true) {
    return this.msg(to, { type: 'audio', audio: { id: mediaId, voice } })
  }

  /** GET /{media-id}: a short-lived download URL (Meta: valid 5 minutes) plus mime type, sha256 and size. */
  mediaInfo(mediaId: string) {
    return this.request('GET', mediaId)
  }

  /** Downloads media bytes from the URL mediaInfo returned. Meta requires the same bearer token. */
  async downloadMedia(url: string): Promise<{ ok: true; bytes: Buffer; mime: string } | { ok: false; error: string }> {
    const where = (() => {
      try {
        const u = new URL(url)
        return `${u.host}${u.pathname}`
      } catch {
        return 'media URL'
      }
    })()
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${this.cfg.accessToken}`, 'user-agent': 'switchboard-poc/0.1' }, signal: AbortSignal.timeout(60_000) })
      if (!res.ok) {
        this.bus.log({ kind: 'graph.request', lane: 'A', live: this.ch.mode === 'live', title: `GET ${where}`, status: res.status, detail: `media download failed (HTTP ${res.status})` })
        return { ok: false, error: `media download failed (HTTP ${res.status})` }
      }
      const bytes = Buffer.from(await res.arrayBuffer())
      const mime = res.headers.get('content-type') ?? 'application/octet-stream'
      this.bus.log({ kind: 'graph.request', lane: 'A', live: this.ch.mode === 'live', title: `GET ${where}`, status: res.status, detail: `media downloaded · ${mime} · ${bytes.length} bytes` })
      return { ok: true, bytes, mime }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  /** POST /{phone-number-id}/media (multipart). Returns { id } on success. */
  uploadMedia(bytes: Buffer, mime: string, filename: string) {
    const form = new FormData()
    form.append('messaging_product', 'whatsapp')
    form.append('type', mime)
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename)
    return this.request('POST', `${this.cfg.phoneNumberId}/media`, form)
  }

  phoneInfo() {
    return this.request('GET', `${this.cfg.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`)
  }

  /**
   * Asks Meta when this channel's access token expires: GET /app (which app the token belongs to), then
   * GET /debug_token read with the app access token (app_id|app_secret). `expiresAt` is ms; 0 means never
   * (a System User token set to "Never"). Temporary tokens from API Setup last about an hour.
   */
  async tokenInfo(appSecret: string) {
    const app = await this.request('GET', 'app')
    if (!app.ok) return { ok: false as const, error: app.error }
    const appId = String(app.json.id)
    const res = await this.request('GET', `debug_token?input_token=${encodeURIComponent(this.cfg.accessToken)}`, undefined, `${appId}|${appSecret}`)
    const d = res.json?.data
    if (!res.ok || !d) return { ok: false as const, error: res.error }
    return { ok: true as const, valid: !!d.is_valid, expiresAt: Number(d.expires_at ?? 0) * 1000, type: String(d.type ?? '') }
  }

  /**
   * Points this number's webhooks at `callbackUrl`, which is what you'd otherwise do in the App Dashboard:
   *  1. GET /app: which app the access token belongs to.
   *  2. POST /{waba}/subscribed_apps: subscribe that app to the WhatsApp account.
   *  3. POST /{app}/subscriptions with the app access token (app_id|app_secret): set the callback URL, verify
   *     token and fields. Meta then sends its GET verify handshake to the URL.
   * Meta's reference says WhatsApp webhooks are configured in the dashboard, but step 3 worked against a real
   * app on 2026-11-09 (callback verified, fields active). If it ever stops working, use the dashboard.
   */
  async pointWebhook(callbackUrl: string, verifyToken: string, appSecret: string, fields = ['messages', 'message_template_status_update']) {
    const app = await this.request('GET', 'app')
    if (!app.ok) return { ...app, step: 'app' as const }
    const appId = String(app.json.id)
    const sub = await this.request('POST', `${this.cfg.wabaId}/subscribed_apps`)
    if (!sub.ok) return { ...sub, step: 'waba' as const, appId }
    const hook = await this.request(
      'POST',
      `${appId}/subscriptions`,
      { object: 'whatsapp_business_account', callback_url: callbackUrl, verify_token: verifyToken, fields: fields.join(','), include_values: true },
      `${appId}|${appSecret}`,
    )
    if (!hook.ok) return { ...hook, step: 'app-webhook' as const, appId }
    const check = await this.request('GET', `${appId}/subscriptions`, undefined, `${appId}|${appSecret}`)
    const active = (check.json?.data ?? []).find((d: any) => d.object === 'whatsapp_business_account')
    return { ...hook, step: 'done' as const, appId, active }
  }

  subscribedApps() {
    return this.request('GET', `${this.cfg.wabaId}/subscribed_apps`)
  }
}

function summarize(path: string, body: any, json: any) {
  if (path.endsWith('/messages') && body?.status === 'read') return `read receipt${body.typing_indicator ? ' + typing…' : ''}`
  if (path.endsWith('/messages')) return `${body?.type ?? ''} → ${body?.to} · ${json?.messages?.[0]?.id?.slice(0, 22) ?? ''}…`
  if (path.endsWith('/groups') && body) return `request_id ${json?.request_id ?? '?'} (result arrives by webhook)`
  if (path.endsWith('/media') && body instanceof FormData) return `uploaded ${String(body.get('type'))} → media id ${json?.id ?? '?'}`
  if (json?.url && json?.mime_type) return `media info · ${json.mime_type} · ${json.file_size ?? '?'} bytes`
  return 'ok'
}
