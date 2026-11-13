import { AlertTriangle, CheckCircle2, CircleDashed, Copy, Loader2, OctagonX, PlugZap, QrCode, ShieldAlert } from 'lucide-react'
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { copy, hueOf, initials } from '../lib/api'

export function Avatar({ name, size, group, hue }: { name: string; size?: 'sm' | 'lg'; group?: boolean; hue?: number }) {
  const h = hue ?? hueOf(name)
  return (
    <div className={`avatar ${size ?? ''} ${group ? 'group' : ''}`} style={{ background: `oklch(0.58 0.12 ${h})` }} aria-hidden>
      {initials(name)}
    </div>
  )
}

export function LaneBadge({ lane, short }: { lane: 'A' | 'B'; short?: boolean }) {
  return lane === 'A' ? (
    <span className="badge lane-a" title="Lane A · official WhatsApp Cloud API">
      {short ? 'Official' : 'Lane A · Official'}
    </span>
  ) : (
    <span className="badge lane-b" title="Lane B · unofficial linked device (ban risk)">
      {short ? 'Linked' : 'Lane B · Linked device'}
    </span>
  )
}

export function ModeBadge({ mode }: { mode: 'sandbox' | 'live' }) {
  return mode === 'live' ? <span className="badge crit">LIVE</span> : <span className="badge outline">Sandbox</span>
}

const STATUS: Record<string, { cls: string; label: string; Icon: typeof CheckCircle2 }> = {
  ready: { cls: 'good', label: 'Ready', Icon: CheckCircle2 },
  open: { cls: 'good', label: 'Connected', Icon: CheckCircle2 },
  qr: { cls: 'warn', label: 'Waiting for QR scan', Icon: QrCode },
  connecting: { cls: 'warn', label: 'Connecting', Icon: Loader2 },
  untested: { cls: 'warn', label: 'Not tested', Icon: CircleDashed },
  disconnected: { cls: '', label: 'Disconnected', Icon: PlugZap },
  logged_out: { cls: 'crit', label: 'Logged out / banned', Icon: ShieldAlert },
  error: { cls: 'crit', label: 'Error', Icon: OctagonX },
}

/** Status is never colour alone: icon + label + colour. */
export function StatusPill({ status }: { status: string }) {
  const s = STATUS[status] ?? { cls: '', label: status, Icon: CircleDashed }
  return (
    <span className={`badge ${s.cls}`}>
      <s.Icon size={12} className={status === 'connecting' ? 'pulse' : undefined} />
      {s.label}
    </span>
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <div style={{ fontWeight: 600, color: 'var(--text-2)' }}>{title}</div>
      {children && <div className="small">{children}</div>}
    </div>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  )
}

export function Callout({ kind = 'info', icon, children }: { kind?: 'info' | 'warn' | 'crit' | 'lane-b' | 'plain'; icon?: ReactNode; children: ReactNode }) {
  return (
    <div className={`callout ${kind}`}>
      {icon ?? (kind === 'warn' || kind === 'crit' || kind === 'lane-b' ? <AlertTriangle size={16} /> : null)}
      <div>{children}</div>
    </div>
  )
}

export function CopyField({ value, label }: { value: string; label?: string }) {
  const toast = useToast()
  return (
    <div className="copyfield" title={value}>
      {label && <span className="tiny faint">{label}</span>}
      <code>{value}</code>
      <button
        className="btn ghost sm"
        onClick={() => {
          copy(value)
          toast('Copied')
        }}
        aria-label="Copy"
      >
        <Copy size={13} />
      </button>
    </div>
  )
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode }[] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((i) => (
        <button key={i.id} role="tab" aria-selected={value === i.id} className={`tab ${value === i.id ? 'active' : ''}`} onClick={() => onChange(i.id)}>
          {i.label}
        </button>
      ))}
    </div>
  )
}

/** Tiny syntax-highlighted JSON view (no deps). */
export function JsonView({ value }: { value: unknown }) {
  const json = JSON.stringify(value, null, 2) ?? 'undefined'
  const html = json
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(-?\d+(?:\.\d+)?)\b|\b(true|false|null)\b/g, (m, str, colon, num, lit) => {
      if (str) return colon ? `<span class="k">${str}</span>${colon}` : `<span class="s">${str}</span>`
      if (num) return `<span class="n">${num}</span>`
      if (lit) return `<span class="n">${lit}</span>`
      return m
    })
  return <pre className="json" dangerouslySetInnerHTML={{ __html: html }} />
}

// ------------------------------------------------------------ toasts

type Toast = { id: number; text: string; err?: boolean }
const ToastCtx = createContext<(text: string, err?: boolean) => void>(() => undefined)

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const push = useCallback((text: string, err?: boolean) => {
    const id = Date.now() + Math.random()
    setItems((x) => [...x.slice(-3), { id, text, err }])
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), err ? 6000 : 2600)
  }, [])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-host" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.err ? 'err' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)

/** Runs an async action with a busy flag and an error toast. */
export function useAction() {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
      setBusy(key)
      try {
        const r: any = await fn()
        if (r && typeof r === 'object' && r.ok === false) {
          toast(r.error ?? 'Request failed', true)
        } else if (ok) toast(ok)
        return r
      } catch (e) {
        toast((e as Error).message, true)
      } finally {
        setBusy(null)
      }
    },
    [toast],
  )
  return { busy, run }
}
