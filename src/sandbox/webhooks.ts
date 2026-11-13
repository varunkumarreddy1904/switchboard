import type { Bus } from '../shared/bus'
import { signBody } from '../shared/crypto'

export interface Faults {
  /** 0..1 chance each webhook POST is delivered twice (Meta does not guarantee exactly-once). */
  duplicateRate: number
  /** Adds jitter to status webhooks so `delivered` can arrive before `sent`. */
  outOfOrder: boolean
}

interface Change {
  field: string
  value: unknown
}

interface Target {
  wabaId: string
  appSecret: string
  webhookUrl: string
}

const MAX_ATTEMPTS = 6
const BATCH_MS = 120
const MAX_CHANGES_PER_POST = 10

/**
 * Delivers Cloud-API-shaped webhooks to the agent: batches several changes per POST,
 * signs the exact bytes it sends, retries non-2xx with backoff, and can inject duplicates.
 */
export class WebhookDispatcher {
  private queue: Change[] = []
  private timer: NodeJS.Timeout | null = null
  private inflight = new Set<Promise<void>>()
  stopped = false

  constructor(
    private bus: Bus,
    private target: () => Target,
    readonly faults: Faults,
  ) {}

  enqueue(field: string, value: unknown, delayMs = 0) {
    if (this.stopped) return
    const push = () => {
      this.queue.push({ field, value })
      if (!this.timer) this.timer = setTimeout(() => this.flush(), BATCH_MS)
    }
    if (delayMs > 0) setTimeout(push, delayMs)
    else push()
  }

  private flush() {
    this.timer = null
    while (this.queue.length) {
      const changes = this.queue.splice(0, MAX_CHANGES_PER_POST)
      const t = this.target()
      const payload = { object: 'whatsapp_business_account', entry: [{ id: t.wabaId, changes }] }
      this.track(this.deliver(payload, 1))
      if (Math.random() < this.faults.duplicateRate) {
        setTimeout(() => this.track(this.deliver(payload, 1, true)), 600 + Math.random() * 1200)
      }
    }
  }

  private track(p: Promise<void>) {
    this.inflight.add(p)
    p.finally(() => this.inflight.delete(p))
  }

  private async deliver(payload: object, attempt: number, duplicate = false): Promise<void> {
    if (this.stopped) return
    const t = this.target()
    const raw = JSON.stringify(payload)
    const signature = signBody(t.appSecret, raw)
    const fields = (payload as { entry: { changes: Change[] }[] }).entry[0].changes.map((c) => c.field)
    let status = 0
    let error: string | undefined
    try {
      const res = await fetch(t.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hub-signature-256': signature,
          'user-agent': 'facebookexternalua (sandbox)',
        },
        body: raw,
        signal: AbortSignal.timeout(10_000),
      })
      status = res.status
      await res.arrayBuffer().catch(() => undefined)
    } catch (e) {
      error = (e as Error).message
    }
    const ok = status >= 200 && status < 300
    this.bus.log({
      kind: 'webhook.out',
      lane: 'A',
      title: `POST webhook · ${[...new Set(fields)].join(', ')}${duplicate ? ' · DUPLICATE' : ''}${attempt > 1 ? ` · retry #${attempt - 1}` : ''}`,
      status: status || undefined,
      detail: ok ? `${fields.length} change(s) delivered` : `failed: ${error ?? 'HTTP ' + status}`,
      payload,
      headers: { 'x-hub-signature-256': signature },
    })
    if (!ok && !this.stopped) {
      if (attempt >= MAX_ATTEMPTS) {
        this.bus.log({
          kind: 'webhook.out',
          lane: 'A',
          title: 'Webhook dropped after retries',
          detail: `Sandbox gives up after ${MAX_ATTEMPTS} attempts; production Meta keeps retrying with backoff for up to 7 days.`,
        })
        return
      }
      const delay = Math.min(1000 * 2 ** (attempt - 1), 16_000)
      await new Promise((r) => setTimeout(r, delay))
      return this.deliver(payload, attempt + 1, duplicate)
    }
  }

  async drain(timeoutMs = 5000) {
    const end = Date.now() + timeoutMs
    while ((this.queue.length || this.timer || this.inflight.size) && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  stop() {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }
}
