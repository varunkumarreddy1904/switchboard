import {
  Activity,
  BadgeCheck,
  Bot,
  Gauge,
  HardHat,
  ExternalLink,
  FlaskConical,
  LayoutDashboard,
  Megaphone,
  Menu,
  MessagesSquare,
  Moon,
  Radio,
  Settings as SettingsIcon,
  Smartphone,
  Sun,
  FileText,
  Users,
  UsersRound,
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useApi, useWire } from './lib/api'
import { AgentPage } from './pages/AgentPage'
import { Broadcasts } from './pages/Broadcasts'
import { Contacts } from './pages/Contacts'
import { Dashboard } from './pages/Dashboard'
import { Events } from './pages/Events'
import { Groups } from './pages/Groups'
import { HxFunnel, HxOwners, HxVerify } from './pages/Hykr'
import { Inbox } from './pages/Inbox'
import { LiveLab } from './pages/LiveLab'
import { Settings } from './pages/Settings'
import { Simulator } from './pages/Simulator'
import { Templates } from './pages/Templates'

export type Route = { page: string; arg?: string }

function parse(): Route {
  const [page = 'dashboard', arg] = location.hash.replace(/^#\/?/, '').split('/')
  return { page: page || 'dashboard', arg: arg ? decodeURIComponent(arg) : undefined }
}

export const go = (page: string, arg?: string) => {
  location.hash = `#/${page}${arg ? '/' + encodeURIComponent(arg) : ''}`
}

const NAV: { section: string; items: { id: string; label: string; icon: ReactNode }[] }[] = [
  {
    section: 'Workspace',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={16} /> },
      { id: 'inbox', label: 'Team inbox', icon: <MessagesSquare size={16} /> },
      { id: 'contacts', label: 'Contacts', icon: <Users size={16} /> },
      { id: 'broadcasts', label: 'Broadcasts', icon: <Megaphone size={16} /> },
      { id: 'templates', label: 'Templates', icon: <FileText size={16} /> },
    ],
  },
  {
    section: 'HYKR · PoC #12',
    items: [
      { id: 'hx-owners', label: 'Owners', icon: <HardHat size={16} /> },
      { id: 'hx-verify', label: 'Verification', icon: <BadgeCheck size={16} /> },
      { id: 'hx-funnel', label: 'Funnel & speed', icon: <Gauge size={16} /> },
    ],
  },
  {
    section: 'Groups & AI',
    items: [
      { id: 'groups', label: 'Groups', icon: <UsersRound size={16} /> },
      { id: 'agent', label: 'AI agent', icon: <Bot size={16} /> },
    ],
  },
  {
    section: 'Sandbox',
    items: [
      { id: 'simulator', label: 'Simulator', icon: <Smartphone size={16} /> },
      { id: 'events', label: 'Event log', icon: <Activity size={16} /> },
    ],
  },
  {
    section: 'Setup',
    items: [
      { id: 'live', label: 'Live lab', icon: <Radio size={16} /> },
      { id: 'settings', label: 'Settings', icon: <SettingsIcon size={16} /> },
    ],
  },
]

function ThemeToggle() {
  const [theme, setTheme] = useState<string | undefined>(document.documentElement.dataset.theme)
  const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches
  return (
    <button
      className="btn ghost sm"
      onClick={() => {
        const next = dark ? 'light' : 'dark'
        document.documentElement.dataset.theme = next
        setTheme(next)
        try {
          localStorage.setItem('theme', next)
        } catch {
          /* ignore */
        }
      }}
    >
      {dark ? <Sun size={14} /> : <Moon size={14} />} {dark ? 'Light' : 'Dark'} theme
    </button>
  )
}

export function Console() {
  const [route, setRoute] = useState<Route>(parse)
  const [menu, setMenu] = useState(false)
  const { connected } = useWire()
  const { data: convs } = useApi<any[]>('/api/conversations?filter=unread', ['conversations'])
  const { data: boot } = useApi<any>('/api/bootstrap', ['channels'])
  const unread = (convs ?? []).reduce((s, c) => s + (c.unread ?? 0), 0)
  const live = (boot?.channels ?? []).filter((c: any) => c.mode === 'live').length

  useEffect(() => {
    const on = () => {
      setRoute(parse())
      setMenu(false)
    }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])

  const page = (() => {
    switch (route.page) {
      case 'inbox':
        return <Inbox activeId={route.arg} />
      case 'contacts':
        return <Contacts />
      case 'broadcasts':
        return <Broadcasts />
      case 'templates':
        return <Templates />
      case 'groups':
        return <Groups />
      case 'agent':
        return <AgentPage initial={route.arg} />
      case 'simulator':
        return <Simulator />
      case 'events':
        return <Events />
      case 'live':
        return <LiveLab />
      case 'settings':
        return <Settings />
      case 'hx-owners':
        return <HxOwners id={route.arg} />
      case 'hx-verify':
        return <HxVerify />
      case 'hx-funnel':
        return <HxFunnel />
      default:
        return <Dashboard />
    }
  })()

  return (
    <div className="shell">
      <div className="topbar">
        <button className="btn ghost icon" onClick={() => setMenu(!menu)} aria-label="Menu">
          <Menu size={18} />
        </button>
        <b>Switchboard</b>
      </div>
      <nav className={`sidebar ${menu ? 'open' : ''}`} aria-label="Main">
        <div className="brand">
          <div className="brand-mark">
            <FlaskConical size={16} />
          </div>
          <div>
            <div className="brand-name">Switchboard</div>
            <div className="brand-sub">WhatsApp POC · EquipXchange</div>
          </div>
        </div>
        {NAV.map((s) => (
          <div key={s.section}>
            <div className="nav-section">{s.section}</div>
            {s.items.map((i) => (
              <a key={i.id} href={`#/${i.id}`} className={`nav-item ${route.page === i.id ? 'active' : ''}`}>
                {i.icon}
                {i.label}
                {i.id === 'inbox' && unread > 0 && <span className="count">{unread}</span>}
                {i.id === 'live' && live > 0 && <span className="count" style={{ background: 'var(--crit)', color: '#fff' }}>{live}</span>}
              </a>
            ))}
          </div>
        ))}
        <a className="nav-item" href={`${location.protocol}//${location.hostname}:5175`} target="_blank" rel="noreferrer">
          <ExternalLink size={16} />
          HYKR app (:5175)
        </a>
        <div className="sidebar-foot">
          <div className="row">
            <span className={`dot ${connected ? 'good' : 'crit'}`} /> {connected ? 'Live event stream' : 'Reconnecting…'}
          </div>
          <div className="row">
            <Bot size={13} /> {boot?.llm === 'claude' ? `Claude (${boot?.settings?.model}${boot?.settings?.provider === 'openrouter' ? ' via OpenRouter' : ''})` : 'Offline AI engine'}
          </div>
          <ThemeToggle />
        </div>
      </nav>
      <main className="main">{page}</main>
    </div>
  )
}
