import { ArrowRight, ShieldCheck, Smartphone } from 'lucide-react'
import { Funnel, GroupedBars } from '../components/Charts'
import { LaneBadge, ModeBadge, StatusPill } from '../components/ui'
import { useApi } from '../lib/api'

export function Dashboard() {
  const { data: d } = useApi<any>('/api/dashboard', ['conversations', 'contacts', 'groups', 'onboarding', 'channels'])
  if (!d) return <div className="page" />
  const tiles = [
    { label: 'Contacts', value: d.contacts, sub: `${d.activeAccounts} with an active account` },
    { label: 'Open chats', value: d.openConversations, sub: `${d.unread} unread` },
    { label: 'Messages (24h)', value: d.inbound24h + d.outbound24h, sub: `${d.inbound24h} in · ${d.outbound24h} out` },
    { label: 'Failed deliveries (24h)', value: d.failed24h, sub: 'async status webhooks' },
    { label: 'Groups monitored', value: d.apiGroups + d.linkedGroups, sub: `${d.apiGroups} official · ${d.linkedGroups} linked` },
    { label: 'Consent on record', value: d.consentedGroups, sub: `${d.blockedMessages} messages dropped by the gate` },
    { label: 'PII redactions', value: d.redactions, sub: 'before storage and AI' },
  ]
  const f = d.funnel
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Dashboard</h1>
          <p>Two WhatsApp lanes feeding one agent: an official Cloud API number for onboarding and small groups, and an isolated member number reading large groups through a linked device.</p>
        </div>
        <a className="btn primary" href="#/simulator">
          <Smartphone size={15} /> Open simulator
        </a>
      </div>

      <div className="kpis">
        {tiles.map((t) => (
          <div className="card kpi" key={t.label}>
            <div className="kpi-label">{t.label}</div>
            <div className="kpi-value">{t.value}</div>
            <div className="kpi-sub">{t.sub}</div>
          </div>
        ))}
      </div>

      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Message volume</h2>
              <p>Per hour, last 12 hours, both lanes</p>
            </div>
          </div>
          <div className="card-body">
            <GroupedBars data={d.series} />
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <div>
              <h2>Onboarding funnel</h2>
              <p>WhatsApp-first path; {f.otpVerified} app-first sign-ups verified by OTP</p>
            </div>
            <a className="btn sm ghost" href="/app" target="_blank" rel="noreferrer">
              App stub <ArrowRight size={13} />
            </a>
          </div>
          <div className="card-body">
            <Funnel
              stages={[
                { label: 'Sent START', value: f.started },
                { label: 'Gave consent', value: f.consented },
                { label: 'Shared details', value: f.details },
                { label: 'Account active', value: f.done },
              ]}
            />
            {f.declined > 0 && <div className="tiny faint" style={{ marginTop: 8 }}>{f.declined} declined consent</div>}
          </div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-head">
            <h2>Channels</h2>
            <a className="btn sm ghost" href="#/live">
              Live lab <ArrowRight size={13} />
            </a>
          </div>
          <div className="card-body stack">
            {d.channels.map((c: any) => (
              <div key={c.id} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <LaneBadge lane={c.kind === 'cloud' ? 'A' : 'B'} short />
                <div className="grow">
                  <div className="ellipsis" style={{ fontWeight: 600 }}>{c.name}</div>
                  <div className="tiny faint ellipsis">{c.linked?.detail ?? c.status_detail ?? c.statusDetail ?? (c.kind === 'cloud' ? c.webhookUrl : '')}</div>
                </div>
                <ModeBadge mode={c.mode} />
                <StatusPill status={c.linked?.status ?? c.status} />
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>What each lane can do</h2>
          </div>
          <div className="card-body">
            <table className="table">
              <thead>
                <tr>
                  <th>Need</th>
                  <th>Lane A · Official</th>
                  <th>Lane B · Linked</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Onboard users (OTP, buttons, lists)</td>
                  <td>Yes</td>
                  <td className="faint">No templates; ban risk</td>
                </tr>
                <tr>
                  <td>Read a group you create</td>
                  <td>Yes, 8 people max, needs blue tick</td>
                  <td>Yes</td>
                </tr>
                <tr>
                  <td>Read existing large groups</td>
                  <td className="faint">No</td>
                  <td>Yes, if the number is a member</td>
                </tr>
                <tr>
                  <td>Communities</td>
                  <td className="faint">No API</td>
                  <td>Yes</td>
                </tr>
                <tr>
                  <td>Ban risk</td>
                  <td>Low</td>
                  <td>High: keep it on its own number</td>
                </tr>
              </tbody>
            </table>
            <div className="row tiny faint" style={{ marginTop: 10 }}>
              <ShieldCheck size={13} /> AI: {d.llm === 'claude' ? `Claude via ${d.llmProvider === 'openrouter' ? 'OpenRouter' : 'the Anthropic API'}` : 'offline engine; add an Anthropic or OpenRouter API key in Settings for Claude digests'}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
