import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { EQX_TEMPLATE, SEE_DETAILS, sign, SIGNATURE_HEADER, TIMESTAMP_HEADER, verify } from '../src/bridge/eqx'

const SECRET = 'bridge-test-secret-at-least-32-characters'
const QUOTE = 'eqx:quote:11111111-2222-4333-8444-555555555555:HOUR'

/** A stand-in for the EquipXchange API: checks signatures, records calls, answers taps. */
const fake = {
  calls: [] as { path: string; body: any }[],
  reply: 'Got it.' as string | undefined,
  /** Overrides the answer to a forwarded message (default: handled, with `reply`). */
  answer: null as null | ((body: any) => unknown),
  paid: false,
}
const PAY_ID = '11111111-2222-4333-8444-666666666666'
let api: Server
let ctx: Awaited<ReturnType<typeof createApp>>

beforeAll(async () => {
  api = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      // The app's public, token-checked pay endpoints (no signature).
      if (req.url?.startsWith(`/pay/${PAY_ID}`)) {
        if (!req.url.includes('t=good-token-123')) return void res.writeHead(404).end('{"message":"Payment link not found"}')
        if (req.method === 'POST') fake.paid = true
        const page = { link: { amount: 3800, kind: 'ADVANCE', status: fake.paid ? 'PAID' : 'PENDING' }, bookingCode: 'J-20261113-0001', sitePlace: 'Kazipet Junction', startAt: '2026-11-14T02:30:00.000Z', machineClass: 'BACKHOE_LOADER' }
        return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.method === 'POST' ? { ...page, result: 'paid' } : page))
      }
      if (!verify(SECRET, req.headers[TIMESTAMP_HEADER] as string, raw, req.headers[SIGNATURE_HEADER] as string)) return void res.writeHead(401).end('{}')
      const body = JSON.parse(raw)
      fake.calls.push({ path: req.url ?? '', body })
      const out = req.url === '/integrations/switchboard/inbound' ? (fake.answer?.(body) ?? { handled: true, reply: fake.reply }) : { machineId: 'm-1', code: 'M-000009', created: true, evidenceSaved: 1 }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out))
    })
  })
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r))
  const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
  ctx = await createApp({ port: 0, memory: true, web: false, dataDir: 'data/test', voiceStub: true, eqx: { apiUrl, secret: SECRET } })
})

afterAll(async () => {
  await ctx?.close()
  await new Promise((r) => api.close(r))
})

beforeEach(() => {
  fake.calls = []
  fake.reply = 'Got it.'
  fake.answer = null
  fake.paid = false
})

async function until<T>(fn: () => T | undefined | false, label: string, ms = 5000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** What the EquipXchange API does: a signed request to the bridge. */
function fromApp(method: 'POST' | 'GET', url: string, body?: unknown, secret = SECRET) {
  const raw = body === undefined ? '' : JSON.stringify(body)
  const ts = String(Date.now())
  return ctx.app.inject({
    method,
    url,
    payload: method === 'POST' ? raw : undefined,
    headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: sign(secret, ts, method === 'GET' ? `GET ${url}` : raw) },
  })
}

const dms = (persona: string) => (ctx.world.dms.get(persona) ?? []).filter((m) => m.from === 'business')

describe('EquipXchange bridge', () => {
  it('outside the 24-hour window sends the template, then the waiting message when the person taps "See details"', async () => {
    const send = await fromApp('POST', '/bridge/eqx/send', {
      id: 'out-1',
      phone: '+919000000040',
      name: 'Suresh Constructions',
      title: 'Your price for trench digging at Hanamkonda',
      text: '*Your price for trench digging at Hanamkonda*\n4 hours at the hourly rate: ₹3,800 all-in.',
      buttons: [
        { id: QUOTE, title: 'Hourly ₹3,800' },
        { id: 'eqx:quote:11111111-2222-4333-8444-555555555555:decline', title: 'No thanks' },
      ],
    })
    expect(send.statusCode).toBe(200)
    expect(send.json()).toMatchObject({ ok: true, mode: 'template' })
    const tpl = await until(() => dms('suresh').find((m) => m.templateName === EQX_TEMPLATE), 'the template')
    expect(JSON.stringify(tpl)).toContain('Your price for trench digging at Hanamkonda')
    // A second message before they reply joins the queue: no second paid template.
    expect((await fromApp('POST', '/bridge/eqx/send', { id: 'out-1b', phone: '+919000000040', title: 'Reminder', text: '*Reminder*' })).json().mode).toBe('queued')
    expect(dms('suresh').filter((m) => m.templateName === EQX_TEMPLATE)).toHaveLength(1)

    const seeDetails = tpl.buttons!.find((b) => b.title === SEE_DETAILS)!
    expect(ctx.world.personaTap('suresh', 'dm', tpl.id, seeDetails.id).ok).toBe(true)
    const price = await until(() => dms('suresh').find((m) => m.buttons?.some((b) => b.id === QUOTE)), 'the price with buttons')
    expect(price.text).toContain('₹3,800 all-in')
    await until(() => dms('suresh').find((m) => m.text === '*Reminder*'), 'the queued second message')

    // The same message again (the app retried): not sent twice.
    expect((await fromApp('POST', '/bridge/eqx/send', { id: 'out-1', phone: '+919000000040', title: 'x', text: 'x' })).json().mode).toBe('duplicate')

    // A tap on a price button goes to the app, signed, and its answer comes back.
    expect(ctx.world.personaTap('suresh', 'dm', price.id, QUOTE).ok).toBe(true)
    const call = await until(() => fake.calls.find((c) => c.path === '/integrations/switchboard/inbound'), 'the reply at the app')
    expect(call.body).toMatchObject({ phone: '+919000000040', replyId: QUOTE })
    await until(() => dms('suresh').find((m) => m.text === 'Got it.'), 'the app’s answer')

    // Inside the window the next message goes straight out with its buttons.
    const next = await fromApp('POST', '/bridge/eqx/send', { id: 'out-2', phone: '+919000000040', title: 'Booked', text: '*Booked*', buttons: [{ id: 'eqx:offer:x:accept', title: 'OK' }] })
    expect(next.json().mode).toBe('buttons')

    // The onboarding brain never answered these taps.
    expect(dms('suresh').some((m) => /consent|agree/i.test(m.text ?? ''))).toBe(false)
  })

  it('refuses unsigned or wrongly signed calls', async () => {
    const body = { id: 'x', phone: '+919000000040', title: 't', text: 't' }
    const unsigned = await ctx.app.inject({ method: 'POST', url: '/bridge/eqx/send', payload: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    expect(unsigned.statusCode).toBe(401)
    expect((await fromApp('POST', '/bridge/eqx/send', body, 'some-other-secret-that-is-long-enough!!')).statusCode).toBe(401)
  })

  it('sends the app’s sign-in code with the authentication template', async () => {
    const res = await fromApp('POST', '/bridge/eqx/otp', { phone: '+919000000001', code: '123456' })
    expect(res.json()).toMatchObject({ ok: true })
    const otp = await until(() => dms('ravi').find((m) => m.templateName === 'otp_login'), 'the code template')
    expect(JSON.stringify(otp)).toContain('123456')
  })

  it('sends a finished registration to the app with its papers, and mirrors the desk’s decision', async () => {
    const hx = ctx.hykr
    const owner = hx.store.ensurePerson(ctx.agent.store.createPerson('Mahesh Goud').id, '919000000003')
    hx.store.updatePerson(owner.id, { name: 'Mahesh Goud', village: 'Madikonda', owner_operator: 1 })
    hx.store.giveConsent(owner.id, 'C1', 'whatsapp', 'C1-en-v1', 'yes')
    hx.store.giveConsent(owner.id, 'C2', 'whatsapp', 'C2-en-v1', 'yes')
    const m = hx.store.createMachine(owner.id, 'test')
    hx.store.updateMachine(m.id, { class: 'backhoe_loader', make: 'TESTMAKE', reg_no: 'TS 00 TE 0003', base_lat: 17.9617, base_lng: 79.5303, base_label: 'Madikonda', rate_hour: 95000, rate_day: 700000, diesel: 'owner', radius_km: 20, insurance_expiry: '2027-01-31', status: 'pending' })
    const dir = resolve('data/test/eqx-evidence')
    mkdirSync(dir, { recursive: true })
    const bytes = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')
    const path = join(dir, 'photo.jpg')
    writeFileSync(path, bytes)
    const sha = createHash('sha256').update(bytes).digest('hex')
    ctx.agent.store.sql.run(
      'insert into hx_evidence(id, owner_id, machine_id, kind, mime, path, bytes, sha256, created_at) values(?,?,?,?,?,?,?,?,?)',
      'E-TEST1', owner.id, m.id, 'machine', 'image/jpeg', path, bytes.length, sha, Date.now(),
    )

    hx.store.addFlag(m.id, 'insurance_later')
    expect(await ctx.eqx!.pushOnboarded(m.id)).toBe(true)
    const sent = fake.calls.find((c) => c.path === '/integrations/switchboard/onboarded')!.body
    expect(sent).toMatchObject({
      ref: m.id,
      owner: { phone: '+919000000003', name: 'Mahesh Goud', village: 'Madikonda', drives: true, consents: { basicProfile: true, machinePapers: true } },
      machine: { machineClass: 'BACKHOE_LOADER', rateHour: 950, rateDay: 7000, dieselIncluded: true, radiusKm: 20, insuranceExpiry: '2027-01-31', base: { place: 'Madikonda' } },
      evidence: [{ id: 'E-TEST1', kind: 'MACHINE_PHOTO', mime: 'image/jpeg', sha256: sha }],
      deskNotes: ['Insurance paper still to come'],
    })

    // The app pulls the photo with a signed GET.
    const file = await fromApp('GET', '/bridge/eqx/evidence/E-TEST1')
    expect(file.statusCode).toBe(200)
    expect(Buffer.from(file.rawPayload).equals(bytes)).toBe(true)
    expect((await ctx.app.inject({ method: 'GET', url: '/bridge/eqx/evidence/E-TEST1' })).statusCode).toBe(401)

    // The desk approves in the app: STATUS on WhatsApp now says the same.
    expect((await fromApp('POST', '/bridge/eqx/machine-status', { id: 'st-1', ref: m.id, status: 'ACTIVE', note: null })).json()).toMatchObject({ ok: true })
    expect(hx.store.machine(m.id)!.status).toBe('active')
  })
})

describe('EquipXchange bridge: whole conversations on WhatsApp', () => {
  const persona = (id: string) => ctx.world.persona(id)!
  const personFor = (id: string) => ctx.agent.store.findByLink('pn', persona(id).pn)!

  it('forwards text, list taps and location pins; delivers list replies; people registering stay with the registration chat', async () => {
    fake.answer = (b) =>
      b.text === 'book'
        ? { handled: true, known: false, replies: [{ text: 'Which machine do you need?', list: { button: 'Choose machine', rows: [{ id: 'eqx:c:cls:BACKHOE_LOADER', title: 'Backhoe loader (JCB)' }] } }] }
        : b.location
          ? { handled: true, known: true, replies: [{ text: 'Which day?', buttons: [{ id: 'eqx:c:day:tomorrow', title: 'Tomorrow' }] }] }
          : { handled: false, known: false, replies: [] }
    expect(ctx.world.personaSend('suresh', 'dm', 'book').ok).toBe(true)
    const listMsg = await until(() => dms('suresh').find((m) => m.list?.sections[0]?.rows.some((r) => r.id === 'eqx:c:cls:BACKHOE_LOADER')), 'the list reply')
    expect(ctx.world.personaTap('suresh', 'dm', listMsg.id, 'eqx:c:cls:BACKHOE_LOADER').ok).toBe(true)
    const tapped = await until(() => fake.calls.find((c) => c.body.replyId === 'eqx:c:cls:BACKHOE_LOADER'), 'the list tap at the app')
    expect(tapped.body).toMatchObject({ phone: '+919000000040', type: 'list_reply' })
    expect(ctx.world.personaLocation('suresh', { lat: 17.98, lng: 79.51, name: 'My site' }).ok).toBe(true)
    const loc = await until(() => fake.calls.find((c) => c.body.location), 'the pin at the app')
    expect(loc.body.location).toMatchObject({ lat: 17.98, lng: 79.51, name: 'My site' })
    await until(() => dms('suresh').find((m) => m.text === 'Which day?'), 'the reply with buttons')

    // On the sandbox, someone the app doesn't know goes to the registration chat (no hire/list question)...
    fake.calls = []
    ctx.world.personaSend('anil', 'dm', 'hi')
    await until(() => fake.calls.find((c) => c.body.phone === '+919000000004'), 'hi forwarded first')
    await until(() => dms('anil').find((m) => /consent|agree|EquipXchange/i.test(m.text ?? '')), 'the registration chat answers')
    // ...and while he is registering, his messages are not forwarded at all.
    fake.calls = []
    ctx.world.personaSend('anil', 'dm', 'yes')
    await new Promise((r) => setTimeout(r, 400))
    expect(ctx.hykr.busy(personFor('anil'))).toBe(true)
    expect(fake.calls.filter((c) => c.body.phone === '+919000000004')).toHaveLength(0)
  })

  it('keeps photos for the app with the hour meter read from them, and serves them only with a signature', async () => {
    fake.answer = () => ({ handled: true, known: true, replies: [{ text: 'Got the photo.' }] })
    const bytes = readFileSync(resolve('fixtures/synthetic/hours-M-T01.jpg'))
    expect(ctx.world.personaImage('suresh', { name: 'hours-M-T01.jpg', bytes, mime: 'image/jpeg', doc: { kind: 'hour_meter', fields: { reading: '04821.6' } } }).ok).toBe(true)
    const call = await until(() => fake.calls.find((c) => c.body.media), 'the photo at the app')
    expect(call.body.media).toMatchObject({ mime: 'image/jpeg', reading: '04821.6', kind: 'hour_meter' })
    const file = await fromApp('GET', `/bridge/eqx/media/${call.body.media.ref}`)
    expect(file.statusCode).toBe(200)
    expect(createHash('sha256').update(file.rawPayload).digest('hex')).toBe(call.body.media.sha256)
    expect((await ctx.app.inject({ method: 'GET', url: `/bridge/eqx/media/${call.body.media.ref}` })).statusCode).toBe(401)
  })

  it('on the live number: messages go to people on the number they use, and a stranger is asked to hire or list', async () => {
    // A "live" channel that points at the simulator, so the test needs no Meta account.
    const sbx = ctx.agent.channels.get('sbx-cloud')!
    ctx.agent.channels.upsert({ id: 'live-test', kind: 'cloud', mode: 'live', name: 'Live (test)', config: sbx.config })
    ctx.world.personaSend('raju', 'dm', 'hello')
    await until(() => personFor('raju'), 'raju known')
    const raju = personFor('raju')
    expect(ctx.eqx!.channelFor(raju)).toBe('sbx-cloud')
    // Raju writes to the live number: from now on the app's messages reach him there.
    ctx.agent.store.sql.run("insert into conversations(id, channel_id, kind, lane, external_id, title, person_id, last_inbound_at, last_message_at) values('conv-live-raju','live-test','dm','A','dm:'||?,'Raju',?,?,?)", raju, raju, Date.now(), Date.now())
    expect(ctx.eqx!.channelFor(raju)).toBe('live-test')

    fake.answer = () => ({ handled: false, known: false, replies: [] })
    ctx.hykr.store.sql.run('delete from hx_flow where actor_id=?', raju)
    ctx.hykr.store.sql.run('delete from hx_people where person_id=?', raju)
    const handled = await ctx.eqx!.intercept({ channelId: 'live-test', personId: raju, type: 'text', text: 'hi' })
    expect(handled).toBe(true)
    const choice = await until(() => dms('raju').find((m) => m.buttons?.some((b) => b.id === 'eqx:role:hire')), 'hire or list?')
    expect(choice.buttons!.map((b) => b.title)).toEqual(['Hire a machine', 'List my machine'])

    // "List my machine" starts the registration chat; "Hire" goes to the app as a start.
    await ctx.eqx!.intercept({ channelId: 'live-test', personId: raju, type: 'button_reply', text: 'List my machine', replyId: 'eqx:role:list' })
    expect(ctx.hykr.store.flow(raju)).toBeTruthy()
    fake.calls = []
    await ctx.eqx!.intercept({ channelId: 'live-test', personId: raju, type: 'button_reply', text: 'Hire a machine', replyId: 'eqx:role:hire' })
    expect(fake.calls.find((c) => c.body.start === 'hire')).toBeTruthy()
  })

  it('an owner who does not drive is asked who does; the driver travels with the machine to the app (D80)', async () => {
    fake.answer = () => ({ handled: false, known: false, replies: [] })
    ctx.world.personaSend('srinivas', 'dm', 'hi')
    const pid = await until(() => personFor('srinivas'), 'srinivas known')
    await until(() => ctx.hykr.store.flow(pid), 'a registration chat')
    const owner = ctx.hykr.store.ensurePerson(pid, '919000000002')
    ctx.hykr.store.updatePerson(owner.id, { name: 'Srinivas Rao', village: 'Hasanparthy' })
    ctx.hykr.store.saveFlow({ ...ctx.hykr.store.flow(pid)!, owner_id: owner.id, role: 'owner', step: 'role', data: {} })

    ctx.world.personaSend('srinivas', 'dm', 'I have an operator')
    await until(() => dms('srinivas').find((m) => /Who drives your machine/.test(m.text ?? '')), 'the driver question')
    expect(ctx.hykr.busy(pid)).toBe(true)
    ctx.world.personaSend('srinivas', 'dm', 'my driver is ramesh 98480 12345')
    await until(() => dms('srinivas').find((m) => /Ramesh \(\+919848012345\) is down as the driver/.test(m.text ?? '')), 'driver noted')
    await until(() => dms('srinivas').find((m) => /Now let’s add your machine/.test(m.text ?? '')), 'on to the machine')
    expect(ctx.hykr.store.driver(owner.id)).toMatchObject({ phone: '919848012345', name: 'Ramesh' })

    // When the machine is sent to the app, the driver goes with it.
    ctx.hykr.store.giveConsent(owner.id, 'C1', 'whatsapp', 'C1-en-v1', 'yes')
    const m = ctx.hykr.store.createMachine(owner.id, 'test')
    ctx.hykr.store.updateMachine(m.id, { class: 'excavator', base_label: 'Hasanparthy', rate_hour: 140000, status: 'pending' })
    expect(ctx.eqx!.onboardedPayload(m.id)).toMatchObject({ owner: { drives: false }, operator: { phone: '+919848012345', name: 'Ramesh' } })
  })

  it('the app’s desk decides: its "ask for more" makes the owner’s next photo or contact the answer, sent back to the app; the console’s buttons are refused (D76, D79)', async () => {
    fake.answer = () => ({ handled: false, known: false, replies: [] })
    ctx.world.personaSend('venkat', 'dm', 'hi')
    const pid = await until(() => personFor('venkat'), 'venkat known')
    await until(() => ctx.hykr.store.flow(pid), 'a registration chat')
    const owner = ctx.hykr.store.ensurePerson(pid, '919000000005')
    ctx.hykr.store.updatePerson(owner.id, { name: 'Venkat Reddy', village: 'Kazipet', owner_operator: 0 })
    ctx.hykr.store.giveConsent(owner.id, 'C1', 'whatsapp', 'C1-en-v1', 'yes')
    ctx.hykr.store.giveConsent(owner.id, 'C2', 'whatsapp', 'C2-en-v1', 'yes')
    const m = ctx.hykr.store.createMachine(owner.id, 'test')
    ctx.hykr.store.updateMachine(m.id, { class: 'backhoe_loader', reg_status: 'unregistered', base_label: 'Kazipet', rate_hour: 130000, status: 'pending', submitted_at: Date.now() })
    ctx.hykr.store.saveFlow({ ...ctx.hykr.store.flow(pid)!, owner_id: owner.id, role: 'owner', step: 'registered', machine_id: null, data: {} })
    // The machine is already at the app.
    ctx.agent.store.sql.run("insert into eqx_sync(machine_id, status, attempts, eqx_machine_id, eqx_code, updated_at) values(?, 'done', 1, 'm-1', 'M-000009', ?)", m.id, Date.now())

    // The console's Verification page shows where it is decided and refuses to decide it here.
    const view = (await ctx.app.inject({ method: 'GET', url: '/api/hx/machines?status=all' })).json().find((x: any) => x.id === m.id)
    expect(view.decidedIn).toMatchObject({ app: 'EquipXchange', code: 'M-000009' })
    const approve = await ctx.app.inject({ method: 'POST', url: `/api/hx/machines/${m.id}/approve`, payload: { by: 'desk' } })
    expect(approve.statusCode).toBe(409)
    expect(approve.json().error).toMatch(/checked in EquipXchange \(M-000009\)/)
    expect(ctx.hykr.store.machine(m.id)!.status).toBe('pending')

    // The app's desk asks for the invoice (the app sends the message itself; Switchboard sends nothing).
    const before = dms('venkat').length
    expect((await fromApp('POST', '/bridge/eqx/machine-status', { id: 'st-inv', ref: m.id, status: 'PENDING', note: 'A photo of the purchase invoice', need: 'INVOICE' })).json()).toMatchObject({ ok: true })
    expect(ctx.hykr.store.flow(pid)!.step).toBe('needs_info')
    expect(ctx.hykr.store.machine(m.id)!.status).toBe('needs_info')
    expect(dms('venkat').length).toBe(before)

    // His photo is kept as the invoice (not sent to the app's chat), and the machine goes to the app again.
    fake.calls = []
    const bytes = readFileSync(resolve('fixtures/synthetic/invoice-M-T03.jpg'))
    expect(ctx.world.personaImage('venkat', { name: 'invoice.jpg', bytes, mime: 'image/jpeg' }).ok).toBe(true)
    const again = await until(() => fake.calls.find((c) => c.path === '/integrations/switchboard/onboarded' && c.body.ref === m.id), 'the machine sent again')
    expect(again.body.evidence.map((e: any) => e.kind)).toContain('INVOICE')
    expect(fake.calls.some((c) => c.path === '/integrations/switchboard/inbound' && c.body.media)).toBe(false)
    expect(ctx.hykr.store.flow(pid)!.step).toBe('registered')
    expect(ctx.hykr.store.machine(m.id)!.status).toBe('pending')

    // Then the driver: he shares a contact, and the machine goes again with the driver.
    expect((await fromApp('POST', '/bridge/eqx/machine-status', { id: 'st-drv', ref: m.id, status: 'PENDING', note: 'The name and number of the person who drives it', need: 'DRIVER' })).json()).toMatchObject({ ok: true })
    expect(ctx.hykr.store.flow(pid)!.step).toBe('driver')
    fake.calls = []
    expect(ctx.world.personaContact('venkat', { name: 'Ramesh', phone: '+91 98480 12345' }).ok).toBe(true)
    const withDriver = await until(() => fake.calls.find((c) => c.path === '/integrations/switchboard/onboarded' && c.body.operator), 'the machine sent with the driver')
    expect(withDriver.body.operator).toEqual({ phone: '+919848012345', name: 'Ramesh' })
    expect(ctx.hykr.store.flow(pid)!.step).toBe('registered')
    // Deciding it here is still refused; the app's decision is mirrored as before.
    expect((await ctx.app.inject({ method: 'POST', url: `/api/hx/machines/${m.id}/reject`, payload: { reason: 'no papers', by: 'desk' } })).statusCode).toBe(409)
    await fromApp('POST', '/bridge/eqx/machine-status', { id: 'st-ok', ref: m.id, status: 'ACTIVE', note: null })
    expect(ctx.hykr.store.machine(m.id)!.status).toBe('active')
  })

  it('fills pay-link placeholders with the public address and serves the test pay page there', async () => {
    expect(ctx.eqx!.links(`Pay here: [[pay:/pay/${PAY_ID}?t=good-token-123]]`)).toBe(`Pay here: ${ctx.eqx!.publicBase()}/pay/${PAY_ID}?t=good-token-123`)
    const page = await ctx.app.inject({ method: 'GET', url: `/pay/${PAY_ID}?t=good-token-123` })
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('Pay ₹3,800.00')
    expect(page.body).toContain('Test payment page')
    const paid = await ctx.app.inject({ method: 'POST', url: `/pay/${PAY_ID}?t=good-token-123`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: '' })
    expect(paid.body).toContain('Paid. Thank you.')
    expect((await ctx.app.inject({ method: 'GET', url: `/pay/${PAY_ID}?t=wrong-token-99` })).body).toContain('not found or has closed')
    // Reached through the tunnel: the pay page is public, the console is not.
    const viaTunnel = { host: 'x.trycloudflare.com', 'x-forwarded-for': '1.2.3.4' }
    expect((await ctx.app.inject({ method: 'GET', url: `/pay/${PAY_ID}?t=good-token-123`, headers: viaTunnel })).statusCode).toBe(200)
    expect((await ctx.app.inject({ method: 'GET', url: '/api/channels', headers: viaTunnel })).statusCode).toBe(403)
  })
})

