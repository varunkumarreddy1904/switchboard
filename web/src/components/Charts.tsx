import { useState } from 'react'

/**
 * Messages per hour, inbound vs outbound: two series over time → grouped bars.
 * Thin bars, 4px rounded data ends anchored to the baseline, 2px gap between neighbours,
 * recessive grid, legend for 2 series, hover tooltip per hour, table view via <details>.
 */
export function GroupedBars({ data }: { data: { label: string; inbound: number; outbound: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 640
  const H = 200
  const pad = { l: 30, r: 8, t: 10, b: 24 }
  const max = Math.max(4, ...data.flatMap((d) => [d.inbound, d.outbound]))
  const nice = Math.ceil(max / 4) * 4
  const iw = W - pad.l - pad.r
  const ih = H - pad.t - pad.b
  const slot = iw / data.length
  const bw = Math.max(3, Math.min(14, (slot - 10) / 2))
  const y = (v: number) => pad.t + ih - (v / nice) * ih
  const ticks = [0, nice / 4, nice / 2, (3 * nice) / 4, nice]
  const rect = (x: number, v: number, fill: string) => {
    const h = Math.max(0, (v / nice) * ih)
    if (h === 0) return null
    const r = Math.min(4, h, bw / 2)
    const top = pad.t + ih - h
    // rounded top only, flat on the baseline
    return <path d={`M${x},${pad.t + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${pad.t + ih} Z`} fill={fill} />
  }
  const hv = hover !== null ? data[hover] : null
  return (
    <div className="chart">
      <div className="legend" style={{ marginBottom: 6 }}>
        <span>
          <span className="sw" style={{ background: 'var(--series-1)' }} />
          Inbound
        </span>
        <span>
          <span className="sw" style={{ background: 'var(--series-2)' }} />
          Outbound
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Messages per hour over the last 12 hours, inbound and outbound">
        {ticks.map((t) => (
          <g key={t}>
            <line className="gridline" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
            <text className="axis-label" x={pad.l - 6} y={y(t) + 4} textAnchor="end">
              {t}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x0 = pad.l + i * slot + (slot - (bw * 2 + 2)) / 2
          return (
            <g key={d.label}>
              {rect(x0, d.inbound, 'var(--series-1)')}
              {rect(x0 + bw + 2, d.outbound, 'var(--series-2)')}
              {i % 2 === (data.length - 1) % 2 && (
                <text className="axis-label" x={pad.l + i * slot + slot / 2} y={H - 6} textAnchor="middle">
                  {new Date(d.label).toLocaleTimeString(undefined, { hour: 'numeric' })}
                </text>
              )}
              <rect className="hit" x={pad.l + i * slot} y={pad.t} width={slot} height={ih} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)} />
            </g>
          )
        })}
      </svg>
      {hv && hover !== null && (
        <div className="chart-tip" style={{ left: `${((pad.l + hover * slot + slot / 2) / W) * 100}%`, top: `${(y(Math.max(hv.inbound, hv.outbound)) / H) * 100}%` }}>
          <div className="faint tiny">Hour ending {new Date(hv.label).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</div>
          <div className="row between">
            <span>
              <span className="sw" style={{ background: 'var(--series-1)', width: 8, height: 8, borderRadius: 2, display: 'inline-block', marginRight: 6 }} />
              Inbound
            </span>
            <b>{hv.inbound}</b>
          </div>
          <div className="row between">
            <span>
              <span className="sw" style={{ background: 'var(--series-2)', width: 8, height: 8, borderRadius: 2, display: 'inline-block', marginRight: 6 }} />
              Outbound
            </span>
            <b>{hv.outbound}</b>
          </div>
        </div>
      )}
      <details className="tiny faint" style={{ marginTop: 6 }}>
        <summary>Table view</summary>
        <table className="table" style={{ marginTop: 6 }}>
          <thead>
            <tr>
              <th>Hour ending</th>
              <th>Inbound</th>
              <th>Outbound</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.label}>
                <td>{new Date(d.label).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</td>
                <td>{d.inbound}</td>
                <td>{d.outbound}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  )
}

/** Funnel: stage counts with the drop-off between stages; one series, so no legend. */
export function Funnel({ stages }: { stages: { label: string; value: number }[] }) {
  const top = Math.max(1, stages[0]?.value ?? 1)
  return (
    <div className="stack" role="list">
      {stages.map((s, i) => {
        const prev = i > 0 ? stages[i - 1].value : null
        const drop = prev && prev > 0 ? Math.round(((prev - s.value) / prev) * 100) : null
        return (
          <div className="funnel-row" key={s.label} role="listitem" title={`${s.label}: ${s.value}${drop !== null ? ` (−${drop}% from previous)` : ''}`}>
            <span className="muted ellipsis">{s.label}</span>
            <div className="funnel-track">
              <div className="funnel-bar" style={{ width: `${(s.value / top) * 100}%` }} />
            </div>
            <span style={{ fontVariantNumeric: 'tabular-nums', textAlign: 'right', whiteSpace: 'nowrap' }}>
              {drop !== null && drop > 0 && <span className="tiny faint">−{drop}% </span>}
              <b>{s.value}</b>
            </span>
          </div>
        )
      })}
    </div>
  )
}
