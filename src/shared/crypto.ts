import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** Meta's webhook signature: `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(app_secret, raw body)>`. */
export function signBody(appSecret: string, raw: Buffer | string): string {
  return 'sha256=' + createHmac('sha256', appSecret).update(raw).digest('hex')
}

/** Constant-time check over the exact raw bytes received (never a re-serialised JSON). */
export function verifySignature(appSecret: string, raw: Buffer, header: string | undefined): boolean {
  if (!appSecret || !header || !header.startsWith('sha256=')) return false
  const expected = Buffer.from(signBody(appSecret, raw))
  const got = Buffer.from(header)
  return expected.length === got.length && timingSafeEqual(expected, got)
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url')

/** Signed, expiring token: `<payload>.<exp>.<sig>`; used for the wa.me START nonce and magic links. */
export function signToken(secret: string, payload: string, ttlMs: number): string {
  const exp = Date.now() + ttlMs
  const sig = createHmac('sha256', secret).update(`${payload}.${exp}`).digest('base64url').slice(0, 22)
  return `${payload}.${exp}.${sig}`
}

export function readToken(secret: string, token: string): { payload: string } | { error: string } {
  const parts = token.split('.')
  if (parts.length !== 3) return { error: 'malformed' }
  const [payload, expStr, sig] = parts
  const exp = Number(expStr)
  const want = createHmac('sha256', secret).update(`${payload}.${exp}`).digest('base64url').slice(0, 22)
  const a = Buffer.from(want)
  const b = Buffer.from(sig)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { error: 'bad signature' }
  if (!Number.isFinite(exp) || Date.now() > exp) return { error: 'expired' }
  return { payload }
}
