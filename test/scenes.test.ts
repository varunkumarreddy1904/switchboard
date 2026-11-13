import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app'
import { runScene, SCENES } from '../src/sandbox/scenes'

let ctx: Awaited<ReturnType<typeof createApp>>

beforeAll(async () => {
  ctx = await createApp({ port: 0, memory: true, web: false, dataDir: 'data/test', voiceStub: true })
})

afterAll(async () => {
  await ctx?.close()
})

describe('demo scenes (end to end over real HTTP webhooks)', () => {
  for (const scene of SCENES) {
    it(`scene ${scene.id}: ${scene.title}`, async () => {
      const r = await runScene(ctx.app, ctx.world, ctx.agent, scene.id)
      if (!r.ok) console.error(`scene ${scene.id} steps:\n  ${r.steps.join('\n  ')}\n  ERROR: ${r.error}`)
      expect(r.ok, r.error).toBe(true)
    })
  }
})
