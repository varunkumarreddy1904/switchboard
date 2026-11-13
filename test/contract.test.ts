import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import type { WireEvent } from '../src/shared/bus'

let ctx: Awaited<ReturnType<typeof createApp>>
const captured: any[] = []

beforeAll(async () => {
  ctx = await createApp({ port: 0, memory: true, web: false, dataDir: 'data/test-contract', voiceStub: true })
  ctx.bus.on('wire', (e: WireEvent) => e.kind === 'webhook.out' && e.payload && captured.push(e.payload))
})
afterAll(async () => ctx?.close())

const keys = (o: object) => Object.keys(o).filter((k) => !k.startsWith('_')).sort()
const until = async (f: () => boolean, ms = 5000) => {
  const end = Date.now() + ms
  while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
  expect(f()).toBe(true)
}

describe('sandbox output matches the documented Cloud API webhook shape', () => {
  it('group participant message carries every documented key', async () => {
    const doc = JSON.parse(readFileSync('fixtures/docs/group-message.webhook.json', 'utf8'))
    const { world } = ctx
    world.graphCreateGroup(world.business.phoneNumberId, { messaging_product: 'whatsapp', subject: 'Contract test' })
    await until(() => world.apiGroups.size > 0)
    const g = [...world.apiGroups.values()][0]
    expect(world.personaJoin('asha', g.inviteCode).ok).toBe(true)
    expect(world.personaSend('asha', g.id, 'hello group').ok).toBe(true)
    let sim: any
    await until(() => {
      for (const p of captured)
        for (const ch of p.entry[0].changes)
          if (ch.field === 'messages' && ch.value.messages?.[0]?.group_id) sim = { payload: p, value: ch.value }
      return !!sim
    })
    const docValue = doc.entry[0].changes[0].value
    expect(keys(sim.payload)).toEqual(keys(doc))
    expect(keys(sim.value)).toEqual(keys(docValue))
    expect(keys(sim.value.metadata)).toEqual(keys(docValue.metadata))
    expect(keys(sim.value.contacts[0])).toEqual(keys(docValue.contacts[0]))
    expect(keys(sim.value.messages[0])).toEqual(keys(docValue.messages[0]))
  })

  it('hidden-number users arrive without wa_id / from, with BSUID only', async () => {
    const before = captured.length
    ctx.world.personaSend('fatima', 'dm', 'hi')
    let msg: any
    let contact: any
    await until(() => {
      for (const p of captured.slice(before))
        for (const ch of p.entry[0].changes)
          if (ch.value.messages?.[0]?.text?.body === 'hi') {
            msg = ch.value.messages[0]
            contact = ch.value.contacts[0]
          }
      return !!msg
    })
    expect(msg.from).toBeUndefined()
    expect(contact.wa_id).toBeUndefined()
    expect(msg.from_user_id).toMatch(/^[A-Z]{2}\.\d+$/)
  })
})
