import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

export async function api<T = any>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  })
  const text = await res.text()
  const json = text ? JSON.parse(text) : {}
  if (!res.ok && json && typeof json === 'object' && !('ok' in json)) json.ok = false
  return json as T
}

export const post = <T = any>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body })
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' })

// ------------------------------------------------------------ live stream (SSE)

export interface WireEvent {
  id: number
  at: number
  kind: 'graph.request' | 'webhook.out' | 'webhook.in' | 'socket.event' | 'agent' | 'sandbox'
  lane: 'A' | 'B' | '-'
  live: boolean
  title: string
  status?: number
  detail?: string
  payload?: unknown
  headers?: Record<string, string>
}

type ChangeListener = (topic: string, data: any) => void

class Stream {
  wire: WireEvent[] = []
  connected = false
  private changeListeners = new Set<ChangeListener>()
  private wireListeners = new Set<() => void>()
  private es: EventSource | null = null
  private version = 0

  start() {
    if (this.es) return
    api<WireEvent[]>('/api/wire?limit=400').then((w) => {
      if (Array.isArray(w)) {
        const seen = new Set(this.wire.map((x) => x.id))
        this.wire = [...w.filter((x) => !seen.has(x.id)), ...this.wire].sort((a, b) => a.id - b.id).slice(-800)
        this.bumpWire()
      }
    })
    const es = new EventSource('/api/stream')
    this.es = es
    es.addEventListener('hello', () => {
      this.connected = true
      this.bumpWire()
    })
    es.addEventListener('wire', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as WireEvent
      this.wire.push(ev)
      if (this.wire.length > 800) this.wire.splice(0, this.wire.length - 800)
      this.bumpWire()
    })
    es.addEventListener('change', (e) => {
      const { topic, data } = JSON.parse((e as MessageEvent).data)
      for (const l of this.changeListeners) l(topic, data)
    })
    es.onerror = () => {
      this.connected = false
      this.bumpWire()
    }
  }

  private bumpWire() {
    this.version++
    for (const l of this.wireListeners) l()
  }

  subscribeWire = (l: () => void) => {
    this.wireListeners.add(l)
    return () => this.wireListeners.delete(l)
  }
  getVersion = () => this.version

  onChange(l: ChangeListener) {
    this.changeListeners.add(l)
    return () => {
      this.changeListeners.delete(l)
    }
  }

  clearLocal() {
    this.wire = []
    this.bumpWire()
  }
}

export const stream = new Stream()

export function useWire() {
  useSyncExternalStore(stream.subscribeWire, stream.getVersion)
  return { events: stream.wire, connected: stream.connected }
}

/**
 * Fetch JSON and refetch whenever the server announces a change on one of `topics`.
 * Refetches are debounced so a burst of status webhooks causes one request.
 */
export function useApi<T>(path: string | null, topics: string[] = [], deps: unknown[] = []) {
  const [data, setData] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const timer = useRef<number | null>(null)
  const pathRef = useRef(path)
  pathRef.current = path

  const load = useCallback(async () => {
    const p = pathRef.current
    if (!p) return
    try {
      const r = await api<T>(p)
      if (pathRef.current !== p) return
      if (r && typeof r === 'object' && (r as any).ok === false && (r as any).error) setError((r as any).error)
      else {
        setError(null)
        setData(r)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    setData(undefined)
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps])

  useEffect(() => {
    if (!topics.length) return
    return stream.onChange((topic) => {
      if (!topics.includes(topic) && !topics.includes('*')) return
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void load(), 200)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topics.join(',')])

  return { data, error, loading, reload: load, setData }
}

// ------------------------------------------------------------ formatting

export function timeAgo(ms?: number | null) {
  if (!ms) return ''
  const d = Date.now() - ms
  if (d < 45_000) return 'now'
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m`
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h`
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
export const hm = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

export function duration(ms: number) {
  if (ms <= 0) return '0m'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return h ? `${h}h ${m}m` : `${m}m`
}

export const initials = (name = '?') =>
  name
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?'

export function hueOf(s: string) {
  let h = 0
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

export const fmtPhone = (digits?: string) => (digits ? `+${digits}` : '')

export function copy(text: string) {
  return navigator.clipboard?.writeText(text).catch(() => undefined)
}
