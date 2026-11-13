import { EventEmitter } from 'node:events'

/** Where an event sits in the architecture; drives the event-log filters in the console. */
export type WireKind =
  | 'graph.request' // agent -> Graph API (sandbox facade or real Meta)
  | 'webhook.out' // sandbox -> agent webhook delivery (incl. retries)
  | 'webhook.in' // agent side: webhook received + verdict
  | 'socket.event' // linked-device socket events (fake or real Baileys)
  | 'agent' // agent decisions (onboarding step, consent gate, fallback...)
  | 'sandbox' // simulator world changes (persona actions, faults)

export type Lane = 'A' | 'B' | '-'

export interface WireEvent {
  id: number
  at: number
  kind: WireKind
  lane: Lane
  live: boolean
  title: string
  status?: number
  detail?: string
  /** Raw payload. Kept in memory only (ring buffer), never written to disk; stripped for live channels. */
  payload?: unknown
  headers?: Record<string, string>
}

export interface ChangeEvent {
  topic: string
  data?: unknown
}

const RING = 600

/** Process-wide event bus: feeds the SSE stream and the in-memory wire inspector. */
export class Bus extends EventEmitter {
  private ring: WireEvent[] = []
  private seq = 0

  constructor() {
    super()
    this.setMaxListeners(200)
  }

  log(e: Omit<WireEvent, 'id' | 'at' | 'live'> & { live?: boolean }): WireEvent {
    const ev: WireEvent = { ...e, id: ++this.seq, at: Date.now(), live: !!e.live }
    if (ev.live) {
      // Live traffic carries real people's data: keep metadata only.
      delete ev.payload
      delete ev.headers
    }
    this.ring.push(ev)
    if (this.ring.length > RING) this.ring.splice(0, this.ring.length - RING)
    this.emit('wire', ev)
    return ev
  }

  change(topic: string, data?: unknown) {
    this.emit('change', { topic, data } satisfies ChangeEvent)
  }

  recent(limit = 300): WireEvent[] {
    return this.ring.slice(-limit)
  }

  clear() {
    this.ring = []
  }
}
