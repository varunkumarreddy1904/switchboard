#!/usr/bin/env node
/**
 * Renders the synthetic test images used by the simulator and the PoC #12 scenes:
 * RCs, insurance, PIN plate, hour meter, invoice, a paper consent form and machine pictures.
 * Everything is invented and watermarked TEST; plates use RTO "00" and series "TE", PINs start with "TST"
 * (the shared kit's synthetic data rules). Needs Google Chrome; the PNG/JPEGs are committed, so this only
 * runs when the fixtures change:  node scripts/make-fixtures.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const OUT = resolve('fixtures/synthetic')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
mkdirSync(OUT, { recursive: true })

const watermark = `<div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none">
  <div style="font:900 120px Arial;color:rgba(220,0,0,.14);transform:rotate(-24deg);letter-spacing:12px">TEST</div></div>`
const page = (w, h, body, bg = '#f4f1e8') =>
  `<!doctype html><html><body style="margin:0;width:${w}px;height:${h}px;background:${bg};position:relative;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:#1d2433">${body}${watermark}</body></html>`
const row = (k, v) => `<tr><td style="padding:5px 14px 5px 0;color:#5b6475;font-size:15px;white-space:nowrap">${k}</td><td style="padding:5px 0;font-size:17px;font-weight:700">${v}</td></tr>`

function rc(f) {
  return page(
    860,
    540,
    `<div style="margin:24px;border:3px solid #28507a;border-radius:14px;height:486px;background:linear-gradient(135deg,#eaf1fb,#f7fafc)">
      <div style="background:#28507a;color:#fff;padding:12px 18px;border-radius:10px 10px 0 0;display:flex;justify-content:space-between">
        <div><div style="font-size:13px;letter-spacing:2px">GOVERNMENT OF TELANGANA (SAMPLE)</div><div style="font-size:21px;font-weight:700">CERTIFICATE OF REGISTRATION</div></div>
        <div style="text-align:right;font-size:13px">FORM 23 · SYNTHETIC<br/>NOT A REAL DOCUMENT</div></div>
      <table style="margin:14px 18px;border-collapse:collapse">
        ${row('Registration No.', f.reg_no)}${row('Date of Regn.', f.reg_date)}${row("Owner's Name", f.owner_name)}${row('Son/Wife/Daughter of', f.relation)}
        ${row('Vehicle Class', f.vehicle_class)}${row("Maker's Name", f.make)}${row('Model', f.model)}${row('Mfg. Year', f.year)}
        ${row('Chassis No. (PIN)', f.chassis)}${row('Engine No.', f.engine_no)}${row('Hypothecated to', f.loan ?? 'NIL')}
      </table></div>`,
  )
}

function insurance(f) {
  return page(
    800,
    560,
    `<div style="margin:26px;background:#fff;border:2px solid #1f7a4d;border-radius:10px;height:504px;padding:20px 26px;box-sizing:border-box">
      <div style="font-size:24px;font-weight:800;color:#1f7a4d">TESTSURE GENERAL INSURANCE (SAMPLE)</div>
      <div style="font-size:15px;color:#5b6475;margin-bottom:12px">Commercial vehicle package policy · Certificate of insurance · synthetic test document</div>
      <table style="border-collapse:collapse">${row('Policy No.', f.policy_no)}${row('Insured', f.insured)}${row('Registration No.', f.reg_no)}${row('Chassis No.', f.chassis)}${row('Valid from', f.valid_from)}${row('Valid till', f.valid_till)}${row('Vehicle', f.vehicle)}</table></div>`,
    '#e9efe9',
  )
}

function pinPlate(f) {
  return page(
    760,
    430,
    `<div style="margin:60px auto;width:620px;height:300px;border-radius:18px;background:linear-gradient(160deg,#c9ced6,#9aa3ae);box-shadow:inset 0 0 0 6px #7d8692,0 10px 30px rgba(0,0,0,.35);padding:26px 32px;box-sizing:border-box;font-family:'Courier New',monospace;color:#22262d">
      <div style="font:800 26px Arial">${f.make} · PRODUCT IDENTIFICATION</div>
      <div style="margin-top:22px;font-size:15px">PIN</div><div style="font-size:40px;font-weight:700;letter-spacing:3px">${f.pin}</div>
      <div style="margin-top:14px;font-size:20px">MODEL ${f.model} &nbsp; YEAR ${f.year} &nbsp; MASS ${f.mass}</div>
      <div style="margin-top:6px;font-size:14px">SYNTHETIC TEST PLATE · ISO 10261</div></div>`,
    '#3d3f42',
  )
}

function hourMeter(f) {
  const digits = f.reading.replace('.', '').split('')
  return page(
    640,
    420,
    `<div style="margin:70px auto;width:480px;height:270px;border-radius:24px;background:#16191e;box-shadow:0 0 0 10px #2b2f36;padding:30px;box-sizing:border-box;text-align:center;color:#d9dde4">
      <div style="font:700 18px Arial;letter-spacing:3px">HOURS ⏱</div>
      <div style="margin:24px auto;display:inline-flex;gap:6px">${digits
        .map((d, i) => `<span style="display:inline-block;width:52px;height:78px;line-height:78px;font:700 54px 'Courier New';background:${i === digits.length - 1 ? '#c9302c' : '#f2f2f2'};color:${i === digits.length - 1 ? '#fff' : '#111'};border-radius:6px">${d}</span>`)
        .join('')}</div>
      <div style="font:13px Arial;color:#8b93a1">SYNTHETIC TEST HOUR METER · reads ${f.reading} h</div></div>`,
    '#0d0f12',
  )
}

function invoice(f) {
  return page(
    760,
    620,
    `<div style="margin:30px;background:#fff;height:560px;padding:26px 30px;box-sizing:border-box;border:1px solid #c7ccd4">
      <div style="display:flex;justify-content:space-between"><div style="font:800 24px Arial">TEST EARTHMOVERS (SAMPLE DEALER)</div><div style="font-size:15px">TAX INVOICE<br/>No. ${f.invoice_no}</div></div>
      <div style="font-size:14px;color:#5b6475;margin:6px 0 16px">Synthetic test document · not a real invoice</div>
      <table style="border-collapse:collapse">${row('Date', f.date)}${row('Sold to', f.buyer)}${row('Machine', f.machine)}${row('PIN / Serial', f.pin)}${row('Engine No.', f.engine_no)}${row('Amount', f.amount)}</table></div>`,
  )
}

function paperForm(f) {
  const tick = (label) => `<div style="display:flex;gap:10px;align-items:center;margin:7px 0;font-size:16px"><span style="width:22px;height:22px;border:2px solid #333;display:inline-flex;align-items:center;justify-content:center;font-weight:800">✓</span>${label}</div>`
  return page(
    720,
    900,
    `<div style="margin:28px;background:#fffef7;height:844px;padding:26px 30px;box-sizing:border-box;border:1px solid #ccc;transform:rotate(-1.2deg)">
      <div style="font:800 24px Arial">EquipXchange · Owner consent form (TEST)</div>
      <div style="font-size:14px;color:#5b6475;margin-bottom:18px">Filled by a field partner (Mitra) · synthetic sample</div>
      <table style="border-collapse:collapse">${row('Owner name', f.owner_name)}${row('Mobile', f.phone)}${row('Village', f.village)}${row('Machines', f.machines)}</table>
      <div style="margin-top:18px">${tick('C1 Basic profile: name, mobile, village')}${tick('C2 Machine papers: RC/invoice, insurance, PIN plate, photos')}</div>
      <div style="margin-top:40px;display:flex;justify-content:space-between;font-size:15px">
        <div>Owner signature / thumb<div style="margin-top:12px;width:120px;height:70px;border-radius:50%;background:radial-gradient(circle,#5a6fb0 0 30%,#8796c9 31% 50%,transparent 51%)"></div></div>
        <div>Witness (Mitra): <b>${f.mitra}</b><br/>Date: ${f.date}<br/>Place: ${f.village}</div></div></div>`,
    '#d9d4c7',
  )
}

/** Simple machine pictures by class (the vision model should recognise the class). */
function machine(cls, label) {
  const art = {
    backhoe_loader: `<rect x="250" y="250" width="300" height="110" rx="10" fill="#f2b705"/><rect x="430" y="170" width="110" height="90" rx="8" fill="#f2b705" stroke="#222" stroke-width="5"/><rect x="445" y="185" width="80" height="55" fill="#9ad0f5"/>
      <circle cx="310" cy="380" r="55" fill="#222"/><circle cx="510" cy="390" r="45" fill="#222"/><path d="M550 300 L690 330 L700 400 L640 400" stroke="#f2b705" stroke-width="22" fill="none"/><path d="M630 390 h80 l-20 40 h-50 z" fill="#555"/>
      <path d="M250 280 L150 190 L90 260" stroke="#f2b705" stroke-width="20" fill="none"/><path d="M70 250 l50 10 l-10 60 l-50 -20 z" fill="#555"/>`,
    excavator: `<rect x="200" y="360" width="360" height="60" rx="30" fill="#333"/><rect x="250" y="250" width="280" height="110" rx="10" fill="#f2b705"/><rect x="420" y="180" width="110" height="80" rx="8" fill="#f2b705" stroke="#222" stroke-width="5"/>
      <path d="M260 290 L150 150 L80 260" stroke="#f2b705" stroke-width="24" fill="none"/><path d="M55 250 l60 10 l-10 70 l-60 -25 z" fill="#555"/>`,
    tipper: `<rect x="120" y="210" width="380" height="150" fill="#c0392b"/><rect x="510" y="230" width="140" height="130" rx="10" fill="#2c3e50"/><rect x="530" y="245" width="90" height="50" fill="#9ad0f5"/>
      <circle cx="200" cy="385" r="42" fill="#222"/><circle cx="420" cy="385" r="42" fill="#222"/><circle cx="590" cy="385" r="42" fill="#222"/>`,
    roller: `<rect x="300" y="230" width="230" height="120" rx="10" fill="#e67e22"/><rect x="430" y="160" width="100" height="80" fill="#e67e22" stroke="#222" stroke-width="5"/><circle cx="210" cy="350" r="80" fill="#7f8c8d"/><circle cx="480" cy="380" r="50" fill="#222"/>`,
  }[cls]
  return page(
    900,
    600,
    `<svg width="900" height="600" viewBox="0 0 800 520" style="position:absolute;inset:0"><rect width="800" height="520" fill="#cfe3f3"/><rect y="420" width="800" height="100" fill="#a98b62"/>${art}</svg>
     <div style="position:absolute;left:18px;bottom:14px;background:rgba(0,0,0,.55);color:#fff;padding:6px 12px;border-radius:6px;font:700 16px Arial">TEST PHOTO · ${label}</div>`,
    '#cfe3f3',
  )
}

const RAVI = { reg_no: 'TS 00 TE 0001', reg_date: '12-03-2019', owner_name: 'RAVI KUMAR', relation: 'S/O RAMESH KUMAR', vehicle_class: 'CONSTRUCTION EQUIPMENT VEHICLE (BACKHOE LOADER)', make: 'TESTMAKE', model: '3DX-T', year: '2019', chassis: 'TSTBHL19C00000001', engine_no: 'TSTE1900001' }

const FIXTURES = [
  { file: 'machine-backhoe.jpg', kind: 'machine', fields: { equipment_class: 'backhoe_loader' }, html: machine('backhoe_loader', 'BACKHOE LOADER') },
  { file: 'machine-excavator.jpg', kind: 'machine', fields: { equipment_class: 'excavator' }, html: machine('excavator', 'EXCAVATOR') },
  { file: 'machine-tipper.jpg', kind: 'machine', fields: { equipment_class: 'tipper' }, html: machine('tipper', 'TIPPER') },
  { file: 'machine-roller.jpg', kind: 'machine', fields: { equipment_class: 'roller' }, html: machine('roller', 'ROLLER') },
  { file: 'rc-M-T01.jpg', kind: 'rc', fields: RAVI, html: rc(RAVI) },
  {
    file: 'rc-M-T02.jpg',
    kind: 'rc',
    fields: { ...RAVI, reg_no: 'TS 00 TE 0002', reg_date: '04-07-2021', owner_name: 'SRINIVAS RAO', relation: 'S/O VENKAT RAO', year: '2021', chassis: 'TSTBHL21C00000002', engine_no: 'TSTE2100002', loan: 'TEST FINANCE LTD' },
    get html() { return rc(this.fields) },
  },
  {
    file: 'rc-M-T04.jpg',
    kind: 'rc',
    fields: { reg_no: 'TS 00 TE 0004', reg_date: '18-01-2020', owner_name: 'SRINIVAS RAO', relation: 'S/O VENKAT RAO', vehicle_class: 'GOODS CARRIER (TIPPER)', make: 'TESTTRUCKS', model: 'TT-1618', year: '2020', chassis: 'TSTTRK20C00000004', engine_no: 'TSTT2000004' },
    get html() { return rc(this.fields) },
  },
  {
    file: 'rc-M-T07.jpg',
    kind: 'rc',
    fields: { ...RAVI, reg_no: 'TS 00 TE 0007', reg_date: '23-09-2016', owner_name: 'K. NARAYANA', relation: 'S/O K. RAMAIAH', year: '2016', chassis: 'TSTBHL16C00000007', engine_no: 'TSTE1600007' },
    get html() { return rc(this.fields) },
  },
  {
    file: 'insurance-M-T01.jpg',
    kind: 'insurance',
    fields: { policy_no: 'TEST-INS-0001', insured: 'RAVI KUMAR', reg_no: 'TS 00 TE 0001', chassis: 'TSTBHL19C00000001', valid_from: '01-04-2026', valid_till: '31-03-2027', vehicle: 'BACKHOE LOADER TESTMAKE 3DX-T' },
    get html() { return insurance(this.fields) },
  },
  { file: 'pin-M-T01.jpg', kind: 'pin_plate', fields: { make: 'TESTMAKE', pin: 'TSTBHL19C00000001', model: '3DX-T', year: '2019', mass: '7400 KG' }, get html() { return pinPlate(this.fields) } },
  { file: 'hours-M-T01.jpg', kind: 'hour_meter', fields: { reading: '04821.6' }, get html() { return hourMeter(this.fields) } },
  {
    file: 'invoice-M-T03.jpg',
    kind: 'invoice',
    fields: { invoice_no: 'TEST/INV/0003', date: '09-11-2022', buyer: 'SRINIVAS RAO', machine: 'TESTMAKE EX-T 140 EXCAVATOR', pin: 'TSTEXC22C00000003', engine_no: 'TSTX2200003', amount: '₹ 38,50,000 (TEST)' },
    get html() { return invoice(this.fields) },
  },
  {
    file: 'paper-form-raju.jpg',
    kind: 'paper_form',
    fields: { owner_name: 'Raju Yadav', phone: '+91 90000 00021', village: 'Dharmasagar', machines: '1 backhoe loader', mitra: 'Lakshmi (Mitra)', date: '10-11-2026' },
    get html() { return paperForm(this.fields) },
  },
]

// ---------------------------------------------------------------- render with headless Chrome (CDP)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = mkdtempSync(join(tmpdir(), 'fixtures-'))
const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', `--user-data-dir=${join(tmp, 'prof')}`, '--remote-debugging-port=9334', 'about:blank'], { stdio: 'ignore' })
let target
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250)
  try {
    target = (await (await fetch('http://127.0.0.1:9334/json')).json()).find((t) => t.type === 'page')
  } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) (pending.get(m.id)(m.result), pending.delete(m.id))
}
const send = (method, params = {}) =>
  new Promise((r) => {
    const i = ++id
    pending.set(i, r)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
await send('Page.enable')
const manifest = []
for (const f of FIXTURES) {
  const [w, h] = [...f.html.matchAll(/width:(\d+)px;height:(\d+)px/g)][0].slice(1).map(Number)
  const file = join(tmp, f.file.replace(/\.\w+$/, '.html'))
  writeFileSync(file, f.html)
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: `file://${file}` })
  await sleep(600)
  const shot = await send('Page.captureScreenshot', { format: 'jpeg', quality: 82 })
  writeFileSync(join(OUT, f.file), Buffer.from(shot.data, 'base64'))
  manifest.push({ file: f.file, kind: f.kind, fields: f.fields })
  console.log('rendered', f.file)
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(manifest, null, 2) + '\n')
ws.close()
proc.kill()
await sleep(800) // Chrome releases its profile files after exiting
try {
  rmSync(tmp, { recursive: true, force: true })
} catch {
  /* leftover temp profile: harmless */
}
console.log(`${manifest.length} fixtures → ${OUT}`)
