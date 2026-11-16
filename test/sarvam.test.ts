import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { t, youCanSay } from '../src/agent/i18n'
import { SARVAM_SPEAKERS, SarvamStt, SarvamTts } from '../src/agent/voice/engines'
import { scriptLang } from '../src/agent/voice/match'
import { inspectOggOpus, STUB_OGG } from '../src/agent/voice/ogg'
import { findTools, run } from '../src/agent/voice/tools'
import { createApp } from '../src/app'

/** Half a second of a 220 Hz tone as 16-bit mono WAV: what Sarvam's text-to-speech answers with, in shape. */
function wav(seconds = 0.5, rate = 24_000): Buffer {
  const n = Math.round(seconds * rate)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n * 2, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36)
  b.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / rate)), 44 + i * 2)
  return b
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const tools = findTools()
let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'sarvam-test-'))
})
afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('Sarvam speech-to-text (the service is faked: no key, no network)', () => {
  it('sends a WhatsApp voice note as it is and reads back the words and the language', async () => {
    const calls: { url: string; headers: any; form: FormData }[] = []
    const fake = (async (url: any, init: any) => {
      calls.push({ url: String(url), headers: init.headers, form: init.body })
      return json({ request_id: 'r1', transcript: '  నా JCB కి  రిక్వెస్ట్‌లు ఉన్నాయా ', language_code: 'te-IN' })
    }) as typeof fetch
    const file = join(dir, 'note.ogg')
    writeFileSync(file, STUB_OGG)
    const r = await new SarvamStt('test-key', { ffmpeg: null, tmpDir: dir, fetch: fake }).transcribe({ file })
    expect(r.text).toBe('నా JCB కి రిక్వెస్ట్‌లు ఉన్నాయా')
    expect(r.language).toBe('te')
    expect(r.engine).toBe('Sarvam · saaras:v4')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.sarvam.ai/speech-to-text')
    expect(calls[0].headers['api-subscription-key']).toBe('test-key')
    expect(calls[0].form.get('model')).toBe('saaras:v4')
    expect(calls[0].form.get('mode')).toBe('codemix')
    expect(calls[0].form.get('language_code')).toBe('unknown')
    expect((calls[0].form.get('file') as Blob).type).toBe('audio/ogg')
  })

  it('says why in plain words when Sarvam refuses', async () => {
    const file = join(dir, 'refused.ogg')
    writeFileSync(file, STUB_OGG)
    const refuse = (async () => json({ error: { message: 'invalid key' } }, 403)) as typeof fetch
    await expect(new SarvamStt('bad', { ffmpeg: null, tmpDir: dir, fetch: refuse }).transcribe({ file })).rejects.toThrow('Sarvam speech-to-text 403: the API key was refused')
  })

  it.skipIf(!tools.ffmpeg)('cuts a long note into short pieces and joins the words', async () => {
    const file = join(dir, 'long.ogg')
    const made = await run(tools.ffmpeg!, ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=60', '-ac', '1', '-c:a', 'libopus', file])
    expect(made.code, made.stderr).toBe(0)
    const types: string[] = []
    const fake = (async (_url: any, init: any) => {
      types.push((init.body.get('file') as Blob).type)
      return json({ transcript: `part ${types.length}`, language_code: types.length === 1 ? null : 'hi-IN' })
    }) as typeof fetch
    const r = await new SarvamStt('k', { ffmpeg: tools.ffmpeg, tmpDir: dir, fetch: fake }).transcribe({ file })
    expect(types).toEqual(['audio/wav', 'audio/wav', 'audio/wav'])
    expect(r.text).toBe('part 1 part 2 part 3')
    expect(r.language).toBe('hi')
  })
})

describe('Sarvam text-to-speech (the service is faked)', () => {
  it.skipIf(!tools.ffmpeg)('asks for the language’s voice and turns the answer into a WhatsApp voice note', async () => {
    const bodies: any[] = []
    const fake = (async (url: any, init: any) => {
      expect(String(url)).toBe('https://api.sarvam.ai/text-to-speech')
      expect(init.headers['api-subscription-key']).toBe('test-key')
      bodies.push(JSON.parse(init.body))
      return json({ request_id: 'r', audios: [wav().toString('base64')] })
    }) as typeof fetch
    const out = join(dir, 'reply.ogg')
    await new SarvamTts('test-key', tools.ffmpeg!, dir, { fetch: fake }).speak('మీ JCB లైవ్‌లో ఉంది.', 'te', out)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ text: 'మీ JCB లైవ్‌లో ఉంది.', target_language_code: 'te-IN', model: 'bulbul:v4-flash', speaker: SARVAM_SPEAKERS.te, output_audio_codec: 'wav' })
    const info = inspectOggOpus(readFileSync(out))
    expect(info?.channels).toBe(1)
    expect(info?.durationSec).toBeGreaterThan(0.3)
  })

  it.skipIf(!tools.ffmpeg)('uses a chosen speaker, and the other name of the language field if the first is refused', async () => {
    const bodies: any[] = []
    const fake = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body)
      bodies.push(body)
      return body.target_language_code ? json({ error: { message: 'unknown field' } }, 422) : json({ audios: [wav().toString('base64')] })
    }) as typeof fetch
    const out = join(dir, 'reply2.ogg')
    await new SarvamTts('k', tools.ffmpeg!, dir, { speakers: { hi: 'my_hi_voice' }, fetch: fake }).speak('नमस्ते', 'hi', out)
    expect(bodies.map((b) => [b.target_language_code, b.language_code, b.speaker])).toEqual([
      ['hi-IN', undefined, 'my_hi_voice'],
      [undefined, 'hi-IN', 'my_hi_voice'],
    ])
    expect(inspectOggOpus(readFileSync(out))?.channels).toBe(1)
  })

  it('reports a refusal instead of sending silence', async () => {
    const refuse = (async () => json({ error: { message: 'no credits' } }, 429)) as typeof fetch
    await expect(new SarvamTts('k', 'ffmpeg', dir, { fetch: refuse }).speak('Hello', 'en', join(dir, 'x.ogg'))).rejects.toThrow('Sarvam text-to-speech 429: rate limit or credits used up')
  })
})

describe('three languages', () => {
  it('tells Telugu, Hindi and English apart by script', () => {
    expect(scriptLang('మీ మెషిన్ లైవ్‌లో ఉంది')).toBe('te')
    expect(scriptLang('आपकी मशीन लाइव है')).toBe('hi')
    expect(scriptLang('Your machine is live')).toBe('en')
    expect(scriptLang('JCB కి రేటు')).toBe('te')
  })

  it('has the voice layer’s own lines in Telugu, and falls back to English for the rest', () => {
    expect(t('te', 'couldntHear')).toMatch(/వాయిస్ నోట్/)
    expect(youCanSay('te', ['అవును, చేయండి', 'వద్దు'])).toBe('మీరు ఇలా చెప్పవచ్చు: అవును, చేయండి, లేదా వద్దు.')
    expect(t('te', 'askName')).toBe(t('en', 'askName'))
  })
})

describe('choosing the speech engine', () => {
  it('uses Sarvam once a key is saved, this Mac when told to, and says so when Sarvam is chosen without a key', async () => {
    const saved = process.env.SARVAM_API_KEY
    delete process.env.SARVAM_API_KEY
    const ctx = await createApp({ port: 0, memory: true, web: false, dataDir: 'data/test-sarvam', appPort: 0 })
    try {
      const post = (payload: unknown) => ctx.app.inject({ method: 'POST', url: '/api/settings', payload: payload as any })
      const status = async () => (await ctx.app.inject({ method: 'GET', url: '/api/voice/status' })).json() as any

      let st = await status()
      expect(st.sarvam).toMatchObject({ hasKey: false, inUse: false })
      expect(st.stt.detail).not.toMatch(/Sarvam/)

      await post({ voice: { engine: 'sarvam' } })
      st = await status()
      expect(st.stt).toEqual({ ok: false, detail: expect.stringMatching(/no Sarvam API key is set/) })

      const res = (await post({ sarvamApiKey: 'sk_test_not_a_real_key', voice: { engine: 'auto' } })).json() as any
      expect(JSON.stringify(res)).not.toContain('sk_test_not_a_real_key')
      expect(res.settings).toMatchObject({ hasSarvamKey: true, sarvamKeySource: 'settings' })
      st = await status()
      expect(JSON.stringify(st)).not.toContain('sk_test_not_a_real_key')
      expect(st.sarvam).toMatchObject({ hasKey: true, keySource: 'settings', inUse: true })
      expect(st.stt).toEqual({ ok: true, detail: 'Sarvam · saaras:v4' })
      if (tools.ffmpeg) expect(st.tts).toEqual({ ok: true, detail: 'Sarvam · bulbul:v4-flash' })

      await post({ voice: { engine: 'local' } })
      expect((await status()).sarvam.inUse).toBe(false)

      await post({ sarvamApiKey: null, voice: { engine: 'auto' } })
      expect((await status()).sarvam.hasKey).toBe(false)
    } finally {
      await ctx.close()
      if (saved !== undefined) process.env.SARVAM_API_KEY = saved
    }
  })
})
