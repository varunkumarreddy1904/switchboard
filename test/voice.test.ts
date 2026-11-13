import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { t, youCanSay } from '../src/agent/i18n'
import { cleanTranscript, listSayVoices, MacSay } from '../src/agent/voice/engines'
import { CADENCE_SAYS, extractName, matchCommand, matchOption, matchYesNo, ROLE_SAYS, spokenText } from '../src/agent/voice/match'
import { inspectOggOpus, STUB_OGG } from '../src/agent/voice/ogg'
import { findTools } from '../src/agent/voice/tools'
import { KeyedQueue } from '../src/shared/queue'

const roles = Object.entries(ROLE_SAYS).map(([id, says]) => ({ id, says }))
const cadences = Object.entries(CADENCE_SAYS).map(([id, says]) => ({ id, says }))

describe('understanding spoken answers', () => {
  it('reads yes and no in English, Hindi and Hinglish', () => {
    expect(matchYesNo('Yes, I agree.')).toBe('yes')
    expect(matchYesNo('हाँ, मैं सहमत हूँ')).toBe('yes')
    expect(matchYesNo('haan theek hai')).toBe('yes')
    expect(matchYesNo('हाँ, मैं एगरी करता हूँ')).toBe('yes')
    expect(matchYesNo('ठीक है ना')).toBe('yes') // "ना" here is a tag, not a no
    expect(matchYesNo('No thanks')).toBe('no')
    expect(matchYesNo('नहीं')).toBe('no')
  })

  it('treats mixed answers as unclear, so consent is never guessed', () => {
    expect(matchYesNo("I don't agree")).toBeNull()
    expect(matchYesNo('not sure')).toBeNull()
    expect(matchYesNo('जी नहीं')).toBeNull()
    expect(matchYesNo('what is this about?')).toBeNull()
  })

  it('picks roles and digest frequency from free speech', () => {
    expect(matchOption("I'm a founder", roles)).toBe('role_founder')
    expect(matchOption('मैं \u095Eाउंडर हूँ', roles)).toBe('role_founder') // precomposed फ़ (U+095E)
    expect(matchOption('मैं \u092B\u093Cाउंडर हूँ', roles)).toBe('role_founder') // फ + nukta (U+092B U+093C)
    expect(matchOption('I organise two groups', roles)).toBe('role_organiser')
    expect(matchOption('the second one', roles)).toBe('role_operator')
    expect(matchOption('founder and operator', roles)).toBeNull()
    expect(matchOption('हर हफ़्ते भेजना', cadences)).toBe('cadence_weekly')
    expect(matchOption('हर हफ़ते भेजना,', cadences)).toBe('cadence_weekly') // Whisper's spelling, no virama
    expect(matchYesNo('हां')).toBe('yes') // anusvara instead of chandrabindu
    expect(matchOption('roz bhejo', cadences)).toBe('cadence_daily')
    expect(matchOption('कभी नहीं', cadences)).toBe('cadence_never')
  })

  it('only treats short utterances as START / STOP / HELP', () => {
    expect(matchCommand('Stop.')).toBe('stop')
    expect(matchCommand('बंद करो')).toBe('stop')
    expect(matchCommand('How do I stop the digests?')).toBeNull()
    expect(matchCommand('शुरू करना है')).toBe('start')
    expect(matchCommand('Hi, I want to start')).toBe('start')
    expect(matchCommand('help')).toBe('help')
    expect(matchCommand('What is the pricing?')).toBeNull()
  })

  it('extracts a name to read back', () => {
    expect(extractName('My name is varun kumar.')).toBe('Varun Kumar')
    expect(extractName('मेरा नाम वरुण कुमार है।')).toBe('वरुण कुमार')
    expect(extractName('I’m Hiro')).toBe('Hiro')
    expect(extractName('Hello, this is Asha Rao')).toBe('Asha Rao')
    expect(extractName('call me on 98765 43210')).toBeNull()
    expect(extractName('my name is a very long sentence that is not a name at all')).toBeNull()
  })
})

describe('speaking replies', () => {
  it('drops links from speech and says the text must follow', () => {
    const r = spokenText('Sign in with this link (valid 15 minutes): https://x.test/app/magic/abc')
    expect(r.hadLink).toBe(true)
    expect(r.speech).toBe('Sign in with this link (valid 15 minutes).')
    expect(spokenText('Pro is $8 per month.').hadLink).toBe(false)
  })

  it('lists the options in the person’s language', () => {
    expect(youCanSay('en', ['Daily', 'Weekly', 'Never'])).toBe('You can say: Daily, Weekly, or Never.')
    expect(youCanSay('hi', [t('hi', 'daily'), t('hi', 'never')])).toBe('आप बोल सकते हैं: रोज़, या कभी नहीं।')
  })
})

describe('audio checks', () => {
  it('reads the Ogg/Opus header and length without ffprobe', () => {
    const info = inspectOggOpus(STUB_OGG)
    expect(info?.channels).toBe(1)
    expect(info?.durationSec).toBeGreaterThan(0.5)
    expect(info?.durationSec).toBeLessThan(0.7)
    expect(inspectOggOpus(Buffer.from('not audio at all, definitely not ogg'))).toBeNull()
  })

  it('drops Whisper non-speech markers and a prompt echoed on silence', () => {
    expect(cleanTranscript('[BLANK_AUDIO]')).toBe('')
    expect(cleanTranscript(' (music) ')).toBe('')
    expect(cleanTranscript('WhatsApp, START')).toBe('')
    // The business's own vocabulary hint (EquipXchange) echoed back on a silent note is dropped too.
    expect(cleanTranscript('EquipXchange, JCB, backhoe loader', 'EquipXchange, JCB, backhoe loader, excavator.')).toBe('')
    expect(cleanTranscript('Hi [noise] there')).toBe('Hi there')
  })

  const tools = findTools()
  it.skipIf(!tools.say || !tools.ffmpeg)('macOS voices produce a mono Ogg/Opus voice note', async () => {
    const voices = await listSayVoices(tools.say!)
    const en = voices.find((v) => v.locale.startsWith('en_'))
    if (!en) return
    const dir = mkdtempSync(join(tmpdir(), 'voice-test-'))
    try {
      const out = join(dir, 'a.ogg')
      await new MacSay(tools.say!, tools.ffmpeg!, { en: en.name, hi: en.name }, dir).speak('Hello from the test.', 'en', out)
      const info = inspectOggOpus(readFileSync(out))
      expect(info?.channels).toBe(1)
      expect(info?.durationSec).toBeGreaterThan(0.3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('per-person ordering', () => {
  it('runs tasks for the same key in arrival order, even if the first is slow', async () => {
    const q = new KeyedQueue()
    const done: string[] = []
    const slow = q.run('p1', async () => {
      await new Promise((r) => setTimeout(r, 40))
      done.push('voice note')
    })
    const fast = q.run('p1', async () => {
      done.push('text')
    })
    const other = q.run('p2', async () => {
      done.push('someone else')
    })
    await Promise.all([slow, fast, other])
    expect(done).toEqual(['someone else', 'voice note', 'text'])
  })
})
