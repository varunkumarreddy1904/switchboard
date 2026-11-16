import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SANDBOX_CLOUD } from '../src/agent/channels'
import { createApp } from '../src/app'
import { LINES, langOf } from '../src/ravi/copy'
import { isRegistrationCommand, sayDate, yesNo } from '../src/ravi/ravi'
import { addDays, isIsoDate, today } from '../src/ravi/store'
import { runScene } from '../src/sandbox/scenes'

describe('Ravi: reading messages', () => {
  it('leaves registration commands to the registration flow', () => {
    for (const t of ['START', 'start abc123', 'STOP', 'help', 'Status', 'PAPERS', 'add machine', 'I want to add another machine', 'add a manager', 'change my driver', 'Can I talk to a person please']) {
      expect(isRegistrationCommand(t, false), t).toBe(true)
    }
    for (const t of ['Any rental requests?', 'block my JCB tomorrow', 'accept Zeno’s price', 'నా మెషిన్లు చూపించు', 'what is the fee?']) {
      expect(isRegistrationCommand(t, false), t).toBe(false)
    }
  })

  it('reads a yes or no to an approval card in English, Hindi and Telugu', () => {
    expect(yesNo('Yes')).toBe('yes')
    expect(yesNo('हाँ')).toBe('yes')
    expect(yesNo('avunu')).toBe('yes')
    expect(yesNo('అవును')).toBe('yes')
    expect(yesNo('No')).toBe('no')
    expect(yesNo('vaddu')).toBe('no')
    expect(yesNo('వద్దు')).toBe('no')
    expect(yesNo('what will it cost?')).toBeNull()
  })

  it('picks the language of the fixed lines from the script', () => {
    expect(langOf('నా మెషిన్లు చూపించు')).toBe('te')
    expect(langOf('मेरी मशीनें दिखाओ')).toBe('hi')
    expect(langOf('naa machines chupinchu')).toBe('en')
  })

  it('says dates as people do, and keeps button titles within WhatsApp’s 20 characters', () => {
    expect(sayDate('2026-11-06')).toBe('6 Nov')
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02')
    expect(isIsoDate('2026-02-30')).toBe(true) // JS rolls it over; the tools also compare ranges
    expect(isIsoDate('tomorrow')).toBe(false)
    expect(today(Date.parse('2026-11-13T20:00:00Z'))).toBe('2026-11-14') // 01:30 the next day in India
    for (const l of Object.values(LINES)) for (const title of [l.yes, l.no]) expect([...title].length).toBeLessThanOrEqual(20)
  })
})

/**
 * The Claude path, with a stand-in for the model: it calls Ravi's real tools by name, the way Claude
 * would, so everything around the model (records, approval cards, hand-over, fall-back) is exercised
 * without an API key.
 */
describe('Ravi: a conversation with tools (stand-in model)', () => {
  let ctx: Awaited<ReturnType<typeof createApp>>
  let pid: string
  let ownerId: string
  let machineId: string
  type Tool = { name: string; run(input: unknown): Promise<string> }
  let script: (call: (name: string, input?: unknown) => Promise<any>, lastMessage: string) => Promise<string>

  const wait = async (cond: () => boolean, label: string) => {
    const end = Date.now() + 10_000
    while (Date.now() < end) {
      if (cond()) return
      await new Promise((r) => setTimeout(r, 50))
    }
    throw new Error(`Timed out waiting for: ${label}`)
  }
  const out = () => {
    const conv = ctx.agent.dmConversation(SANDBOX_CLOUD, pid)
    return ctx.agent.store.messages(conv.id, 500).filter((m) => m.dir === 'out')
  }
  /** Sends a message as the owner and returns what came back; `card` waits for the approval card after the words. */
  const say = async (text: string, card = false) => {
    const before = out().length
    expect(ctx.world.personaSend('ben', 'dm', text).ok).toBe(true)
    await wait(() => out().slice(before).some((m) => (card ? m.type === 'interactive' : true)), `${card ? 'a card' : 'a reply'} after "${text}"`)
    await new Promise((r) => setTimeout(r, 200)) // anything else from the same turn
    return out().slice(before)
  }
  const atRest = () => {
    const f = ctx.hykr.store.flow(pid)!
    ctx.hykr.store.saveFlow({ ...f, step: 'registered', machine_id: null, data: {} })
  }

  beforeAll(async () => {
    ctx = await createApp({ port: 0, memory: true, web: false, dataDir: 'data/test-ravi', voiceStub: true })
    const r = await runScene(ctx.app, ctx.world, ctx.agent, 22)
    expect(r.ok, r.error).toBe(true)
    pid = ctx.agent.store.findByLink('pn', ctx.world.persona('ben')!.pn)!
    ownerId = ctx.hykr.store.personBySwitchboard(pid)!.id
    machineId = ctx.hykr.store.machines(ownerId).find((m) => m.status === 'active')!.id
    atRest()
    Object.defineProperty(ctx.agent.llm, 'engine', { get: () => 'claude' })
    ctx.agent.llm.converse = async ({ tools, messages }) => {
      const last = messages[messages.length - 1].content as string
      const call = async (name: string, input: unknown = {}) => JSON.parse(await (tools as unknown as Tool[]).find((t) => t.name === name)!.run(input))
      return { text: await script(call, last), engine: 'stand-in' }
    }
  })

  afterAll(async () => {
    await ctx?.close()
  })

  it('gives the model today’s date and the owner, and only this owner’s records', async () => {
    let seen = ''
    let machines: any[] = []
    script = async (call, last) => {
      seen = last
      machines = (await call('list_machines')).machines
      return 'You have one machine live.'
    }
    const sent = await say('what machines do I have')
    expect(seen).toContain(`(${today()})`)
    expect(seen).toContain('The owner: Ben Carter')
    expect(seen.endsWith('what machines do I have')).toBe(true)
    expect(machines.map((m) => m.id)).toContain(machineId)
    expect(machines.find((m) => m.id === machineId).status).toBe('live')
    expect(sent.at(-1)!.text).toBe('You have one machine live.')
  })

  it('a quote waits on an approval card, and a typed “avunu” sends it', async () => {
    let request: any
    script = async (call) => {
      request = (await call('list_requests')).requests.find((r: any) => r.builder === 'Zeno Constructions')
      const r = await call('send_quote', { request_id: request.id, price: 'builder' })
      expect(r.status).toBe('waiting_for_approval')
      expect(r.total_rupees).toBe(Math.round(request.builder_price_per_day_rupees * request.days * 1.18))
      return 'Tap Yes and I will send it.'
    }
    const sent = await say('accept Zeno price', true)
    expect(request).toBeTruthy()
    const card = sent.find((m) => m.type === 'interactive')!
    expect(card.text).toContain('Send this quote to Zeno Constructions?')
    expect(JSON.parse(card.payload!).buttons.map((b: any) => b.id.slice(0, 7))).toEqual(['ravi:y:', 'ravi:n:'])
    expect(ctx.ravi.store.request(request.id)!.status).toBe('pending')
    const after = await say('avunu')
    expect(after.at(-1)!.text).toMatch(/has gone to Zeno Constructions/)
    expect(ctx.ravi.store.request(request.id)!.status).toBe('quoted')
  })

  it('refuses ids that are not this owner’s, and prices nobody stated', async () => {
    const results: any[] = []
    script = async (call) => {
      results.push(await call('send_quote', { request_id: 'RQ-notmine', price: 'builder' }))
      const mine = (await call('list_requests')).requests[0]
      results.push(await call('send_quote', { request_id: mine.id, price: 'stated' }))
      results.push(await call('set_rate', { machine_id: 'M-999999', daily_rate_rupees: 5000 }))
      results.push(await call('block_dates', { machine_id: machineId, from_date: 'tomorrow', to_date: 'friday' }))
      return 'I could not find that one.'
    }
    const sent = await say('send the quote')
    expect(results.map((r) => r.ok)).toEqual([false, false, false, false])
    expect(sent.some((m) => m.type === 'interactive')).toBe(false)
    expect(ctx.ravi.store.waiting(pid)).toBeUndefined()
  })

  it('blocks dates at once, reports requests on those dates, and lifts them only after a Yes', async () => {
    const from = addDays(today(), 9)
    const to = addDays(today(), 12)
    let blocked: any
    script = async (call) => {
      blocked = await call('block_dates', { machine_id: machineId, from_date: from, to_date: to, reason: 'engine repair' })
      return 'Blocked.'
    }
    await say('block my machine for repair')
    expect(blocked.ok).toBe(true)
    expect(blocked.requests_on_these_dates.map((r: any) => r.builder)).toContain('Sri Balaji Infra')
    expect(ctx.ravi.store.blocks(ownerId, machineId)).toHaveLength(1)

    script = async (call) => {
      await call('unblock_dates', { block_id: blocked.blocked.id })
      return 'Tap Yes to open those dates.'
    }
    const sent = await say('open those dates again', true)
    expect(sent.find((m) => m.type === 'interactive')!.text).toContain('Open your')
    expect(ctx.ravi.store.blocks(ownerId, machineId)).toHaveLength(1)
    await say('yes')
    expect(ctx.ravi.store.blocks(ownerId, machineId)).toHaveLength(0)
  })

  it('a new rate is saved only after the tap, exactly as the owner said it', async () => {
    script = async (call) => {
      await call('set_rate', { machine_id: machineId, daily_rate_rupees: 7500 })
      return 'Tap Yes to save it.'
    }
    const sent = await say('make it 7500 a day', true)
    const card = sent.find((m) => m.type === 'interactive')!
    expect(card.text).toContain('₹7,500 a day')
    expect(ctx.hykr.store.machine(machineId)!.rate_day).not.toBe(750_000)
    const yes = JSON.parse(card.payload!).buttons[0].id
    const conv = ctx.world.dms.get('ben')!
    const msg = [...conv].reverse().find((m) => m.buttons?.some((b) => b.id === yes))!
    expect(ctx.world.personaTap('ben', 'dm', msg.id, yes).ok).toBe(true)
    await wait(() => ctx.hykr.store.machine(machineId)!.rate_day === 750_000, 'rate saved after the tap')
    await wait(() => out().some((m) => /The new rate for your .* is saved/.test(m.text)), 'the owner is told it is saved')
  })

  it('hands “one more machine” to the registration flow, and falls back when the model fails', async () => {
    script = async () => {
      throw new Error('model down')
    }
    const scripted = await say('show my machines')
    expect(scripted[0].text).toMatch(/^Your machines:/)

    script = async (call) => {
      await call('add_machine')
      return ''
    }
    await say('I bought one more JCB')
    await wait(() => ctx.hykr.store.flow(pid)!.step === 'class', 'registration asks the machine type')
  })
})
