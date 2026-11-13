import { Bot, HelpCircle, ListChecks, MessageCircleQuestion, ShieldAlert, Sparkles, Target } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Callout, Empty, LaneBadge, useAction } from '../components/ui'
import { post, timeAgo, useApi } from '../lib/api'

export function AgentPage({ initial }: { initial?: string }) {
  const { data: groups } = useApi<any>('/api/groups', ['groups'])
  const { data: boot } = useApi<any>('/api/bootstrap', ['channels'])
  const options = [
    ...(groups?.api ?? []).filter((g: any) => g.conversationId).map((g: any) => ({ id: g.conversationId, title: g.subject, lane: 'A' as const, consent: true })),
    ...(groups?.linked ?? []).filter((g: any) => g.kind !== 'community').map((g: any) => ({ id: g.id, title: g.title, lane: 'B' as const, consent: !!g.consent })),
  ]
  const [convId, setConvId] = useState(initial ?? '')
  useEffect(() => {
    if (!convId && options.length) setConvId(options.find((o) => o.consent)?.id ?? options[0].id)
  }, [options.length])
  useEffect(() => {
    if (initial) setConvId(initial)
  }, [initial])
  const selected = options.find((o) => o.id === convId)
  const { data: history } = useApi<any[]>(convId ? `/api/conversations/${convId}/digests` : null, ['digests'], [convId])
  const [question, setQuestion] = useState('')
  const { busy, run } = useAction()
  const latest = history?.find((h) => h.kind === 'digest')

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>AI agent</h1>
          <p>Digests and Q&A over stored group messages. Group text is redacted before storage, wrapped as untrusted data, and the model has no tools that can send messages.</p>
        </div>
        <span className="badge accent">
          <Bot size={12} /> {boot?.llm === 'claude' ? `Claude · ${boot?.settings?.providerModel ?? boot?.settings?.model}${boot?.settings?.provider === 'openrouter' ? ' via OpenRouter' : ''}` : 'Offline engine (no API key)'}
        </span>
      </div>
      {boot?.llm !== 'claude' && (
        <div style={{ marginBottom: 14 }}>
          <Callout kind="info">
            Running the offline heuristic engine. Add an Anthropic or OpenRouter API key in <a href="#/settings">Settings</a> to generate digests with Claude ({boot?.settings?.model ?? 'claude-opus-5-5'}).
          </Callout>
        </div>
      )}
      {!options.length ? (
        <Empty title="No groups yet">Link the member number and record consent, or create a Groups API group.</Empty>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(280px, 1fr)' }}>
          <div className="stack-lg">
            <div className="card card-pad row wrap">
              <select className="select" style={{ maxWidth: 360 }} value={convId} onChange={(e) => setConvId(e.target.value)} aria-label="Group">
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.lane === 'A' ? 'Official · ' : 'Linked · '}
                    {o.title}
                    {o.consent ? '' : ' (no consent)'}
                  </option>
                ))}
              </select>
              {selected && <LaneBadge lane={selected.lane} />}
              <button className="btn primary right" disabled={!convId || busy === 'digest'} onClick={() => run('digest', () => post(`/api/conversations/${convId}/digest`), 'Digest ready')}>
                <Sparkles size={15} /> {busy === 'digest' ? 'Generating…' : 'Generate digest'}
              </button>
            </div>
            {selected && !selected.consent && <Callout kind="warn">No admin consent for this group, so no messages are stored and the digest will be empty.</Callout>}
            {latest ? <DigestView d={latest} /> : <div className="card"><Empty icon={<Sparkles size={26} />} title="No digest yet">Generate one to summarise the stored messages.</Empty></div>}
          </div>
          <div className="stack-lg">
            <div className="card card-pad stack">
              <h2>Ask the group</h2>
              <textarea className="textarea" placeholder="e.g. When is the next meetup?" value={question} onChange={(e) => setQuestion(e.target.value)} />
              <button className="btn" disabled={!question.trim() || busy === 'ask'} onClick={async () => (await run('ask', () => post(`/api/conversations/${convId}/ask`, { question })), setQuestion(''))}>
                <MessageCircleQuestion size={15} /> {busy === 'ask' ? 'Thinking…' : 'Ask'}
              </button>
              {history
                ?.filter((h) => h.kind === 'qa')
                .slice(0, 5)
                .map((h) => (
                  <div key={h.id} className="callout plain small" style={{ flexDirection: 'column', gap: 4 }}>
                    <b>{h.question}</b>
                    <div>{h.content.answer}</div>
                    <div className="tiny faint">
                      {h.engine} · {timeAgo(h.created_at)} ago{h.content.cited?.length ? ` · cites ${h.content.cited.length} message(s)` : ''}
                    </div>
                  </div>
                ))}
            </div>
            <div className="card card-pad stack small">
              <h2>Guardrails</h2>
              <div>• Phones, emails and card numbers are redacted before storage.</div>
              <div>• Messages are passed to the model as data inside tags, never as instructions.</div>
              <div>• Injection attempts are flagged, not obeyed.</div>
              <div>• The 1:1 assistant only answers Northstar questions (Meta's 2026 policy bars general-purpose assistants).</div>
              <div>• Linked-lane groups are read-only: there is no send path.</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function DigestView({ d }: { d: any }) {
  const c = d.content
  const Section = ({ icon, title, items }: { icon: React.ReactNode; title: string; items: string[] }) =>
    items.length ? (
      <div>
        <div className="row" style={{ fontWeight: 650, marginBottom: 6 }}>
          {icon} {title}
        </div>
        <ul style={{ margin: 0, paddingLeft: 20 }} className="stack small">
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </div>
    ) : null
  return (
    <div className="card card-pad stack-lg">
      <div className="row between">
        <h2>Digest</h2>
        <span className="tiny faint">
          {c.engine} · {c.messageCount} messages · {timeAgo(d.created_at)} ago
        </span>
      </div>
      <Section icon={<ListChecks size={15} />} title="Summary" items={c.summary} />
      <Section icon={<Target size={15} />} title="Decisions" items={c.decisions} />
      <Section icon={<HelpCircle size={15} />} title="Open questions" items={c.open_questions.map((q: any) => `${q.question} (${q.asked_by})`)} />
      <Section icon={<ListChecks size={15} />} title="Action items" items={c.action_items} />
      {c.flagged.length > 0 && (
        <Callout kind="crit" icon={<ShieldAlert size={16} />}>
          <b>Flagged</b>
          {c.flagged.map((f: any, i: number) => (
            <div key={i} className="small">
              {f.reason}: <i>{f.excerpt}</i>
            </div>
          ))}
        </Callout>
      )}
    </div>
  )
}
