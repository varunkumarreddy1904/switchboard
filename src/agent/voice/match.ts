/**
 * Offline understanding of short spoken answers (English, Hindi, Hinglish), so voice onboarding works
 * without an API key. Claude is only asked when these rules find nothing clear.
 * Rule of thumb: when in doubt return null, and the bot asks again with buttons.
 */

export const hasDevanagari = (s: string) => /[ऀ-ॿ]/.test(s)

/** Lower-case, NFC (so फ़ and फ + nukta compare equal), punctuation → spaces, any script kept. */
export function normalize(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const wordCount = (n: string) => (n ? n.split(' ').length : 0)

/**
 * Looser form for matching only: Whisper spells Hindi inconsistently (हफ़्ते / हफ़ते / हफ्ते, हाँ / हां),
 * so nukta (़) and virama (्) are dropped and chandrabindu (ँ) is treated as anusvara (ं).
 */
const loose = (n: string) => n.normalize('NFD').replace(/[\u093C\u094D]/g, '').replace(/\u0901/g, '\u0902').normalize('NFC')

/** True if any phrase occurs as whole words in the normalized text. */
function hasPhrase(n: string, phrases: string[]): boolean {
  const padded = ` ${loose(n)} `
  return phrases.some((p) => {
    const q = loose(normalize(p))
    return !!q && padded.includes(` ${q} `)
  })
}

const YES = [
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'agree', 'i agree', 'agreed', 'fine', 'correct', 'right', 'thats right', 'go ahead', 'of course', 'absolutely', 'alright', 'accept',
  'haan', 'haa', 'han', 'hanji', 'haanji', 'ji', 'ji haan', 'theek', 'thik', 'theek hai', 'thik hai', 'sahi', 'sahi hai', 'chalega', 'bilkul', 'manzoor',
  'हाँ', 'हां', 'हा', 'जी', 'जी हाँ', 'हाँ जी', 'ठीक', 'ठीक है', 'सही', 'सही है', 'चलेगा', 'बिल्कुल', 'बिलकुल', 'मंज़ूर', 'मंजूर', 'सहमत', 'एग्री', 'एगरी', 'ओके', 'यस',
]
const NO = [
  'no', 'nope', 'nah', 'no thanks', 'not now', 'dont', 'do not', 'disagree', 'cancel', 'never mind', 'wrong', 'incorrect', 'not right', 'not ok', 'not okay', 'not fine', 'not sure',
  // "na" / "ना" are left out on purpose: Hindi uses them as a tag ("ठीक है ना?" = "okay, right?").
  'nahi', 'nahin', 'nai', 'mat', 'galat',
  'नहीं', 'नही', 'मत', 'नो', 'असहमत', 'ग़लत', 'गलत',
]

/** "yes" | "no" | null (null also when both appear, e.g. "I don't agree"). */
export function matchYesNo(text: string): 'yes' | 'no' | null {
  const n = normalize(text)
  const yes = hasPhrase(n, YES)
  const no = hasPhrase(n, NO)
  if (yes === no) return null
  return yes ? 'yes' : 'no'
}

export interface SpokenOption {
  id: string
  /** Phrases that pick this option, in any language. */
  says: string[]
}

// Position words, tried in this order: "the second one" is the second option, not the first ("one").
const ORDINALS = [
  ['first', 'pehla', 'पहला', 'पहले', 'पहली'],
  ['second', 'doosra', 'dusra', 'दूसरा', 'दूसरी'],
  ['third', 'teesra', 'tisra', 'तीसरा', 'तीसरी'],
  ['fourth', 'chautha', 'चौथा', 'चौथी'],
]
const CARDINALS = [
  ['one', '1', 'ek', 'एक'],
  ['two', '2', 'do', 'दो'],
  ['three', '3', 'teen', 'तीन'],
  ['four', '4', 'char', 'चार'],
]

const single = (ids: string[]) => {
  const unique = [...new Set(ids)]
  return unique.length === 1 ? unique[0] : null
}

/** Picks the single option whose phrases appear. Short answers may also say a position ("the second one"). */
export function matchOption(text: string, options: SpokenOption[]): string | null {
  const n = normalize(text)
  const hits = options.filter((o) => hasPhrase(n, o.says)).map((o) => o.id)
  if (hits.length || wordCount(n) > 3) return single(hits)
  for (const table of [ORDINALS, CARDINALS]) {
    const byPosition = options.filter((_, i) => i < table.length && hasPhrase(n, table[i])).map((o) => o.id)
    if (byPosition.length) return single(byPosition)
  }
  return null
}

export const ROLE_SAYS: Record<string, string[]> = {
  role_founder: ['founder', 'co founder', 'cofounder', 'ceo', 'owner', 'फाउंडर', 'फ़ाउंडर', 'संस्थापक', 'मालिक'],
  role_operator: ['operator', 'operations', 'ops', 'ऑपरेटर', 'ओपरेटर', 'ऑपरेशंस'],
  role_organiser: ['organiser', 'organizer', 'organise', 'organize', 'group organiser', 'group organizer', 'admin', 'group admin', 'community manager', 'ऑर्गनाइज़र', 'ऑर्गेनाइज़र', 'ऑर्गनाइजर', 'ऑर्गेनाइजर', 'आयोजक', 'एडमिन', 'ग्रुप एडमिन'],
  role_other: ['other', 'something else', 'none of these', 'कुछ और', 'अन्य', 'इनमें से कोई नहीं'],
}

export const CADENCE_SAYS: Record<string, string[]> = {
  cadence_daily: ['daily', 'every day', 'everyday', 'each day', 'once a day', 'roz', 'roj', 'rozana', 'har din', 'रोज़', 'रोज', 'रोज़ाना', 'रोजाना', 'हर दिन', 'प्रतिदिन', 'डेली'],
  cadence_weekly: ['weekly', 'every week', 'once a week', 'each week', 'hafte', 'hafta', 'har hafte', 'saptahik', 'हफ्ते', 'हफ़्ते', 'हफ्ता', 'हफ़्ता', 'हर हफ़्ते', 'हर हफ्ते', 'साप्ताहिक', 'वीकली', 'वीकेली'],
  cadence_never: ['never', 'no digest', 'no digests', 'none', 'dont send', 'do not send', 'kabhi nahi', 'kabhi nahin', 'mat bhejo', 'nahi chahiye', 'कभी नहीं', 'मत भेजो', 'मत भेजना', 'नहीं चाहिए', 'नेवर'],
}

const COMMANDS: Record<'start' | 'stop' | 'help', { says: string[]; maxWords: number }> = {
  start: { says: ['start', 'sign up', 'signup', 'register', 'join', 'get started', 'lets start', 'shuru', 'shuru karo', 'शुरू', 'शुरू करो', 'शुरू करना है', 'स्टार्ट', 'साइन अप', 'रजिस्टर'], maxWords: 6 },
  // Unsubscribing is destructive: only a short, clear request counts ("how do I stop digests?" is a question).
  stop: { says: ['stop', 'unsubscribe', 'opt out', 'stop messages', 'band karo', 'बंद करो', 'बंद', 'रोको', 'स्टॉप', 'अनसब्सक्राइब'], maxWords: 4 },
  help: { says: ['help', 'help me', 'madad', 'मदद', 'हेल्प', 'सहायता'], maxWords: 4 },
}
const QUESTION_WORDS = ['how', 'what', 'why', 'when', 'where', 'can', 'kaise', 'kya', 'kyun', 'कैसे', 'क्या', 'क्यों', 'कब', 'कहाँ']

/** START / STOP / HELP spoken as a short command, else null (longer sentences go to the FAQ bot). */
export function matchCommand(text: string): 'start' | 'stop' | 'help' | null {
  const n = normalize(text)
  if (!n || hasPhrase(n, QUESTION_WORDS)) return null
  for (const [cmd, rule] of Object.entries(COMMANDS) as [keyof typeof COMMANDS, (typeof COMMANDS)[keyof typeof COMMANDS]][]) {
    if (wordCount(n) <= rule.maxWords && hasPhrase(n, rule.says)) return cmd
  }
  return null
}

const titleCase = (s: string) => s.replace(/\b\p{Ll}/gu, (c) => c.toUpperCase())

/** "My name is varun kumar." → "Varun Kumar"; "मेरा नाम वरुण है" → "वरुण". Null if it doesn't look like a name. */
export function extractName(text: string): string | null {
  const t = text.normalize('NFC').trim().replace(/[.!?।,]+$/u, '').trim()
  const patterns = [
    /\b(?:my name(?:['’]?s| is)|name is|i am|i['’]?m|this is|it['’]?s|call me)\s+(.+)$/iu,
    /\bmera naam\s+(.+?)(?:\s+(?:hai|he|h))?$/iu,
    /मेरा नाम\s+(.+?)(?:\s+है)?$/u,
    /^(.+?)\s+(?:naam hai|नाम है)$/u,
  ]
  let name = t
  for (const re of patterns) {
    const m = re.exec(t)
    if (m) {
      name = m[1]
      break
    }
  }
  name = name
    .replace(/^(?:hi|hello|hey|namaste|नमस्ते|हाय|हेलो)[\s,]+/iu, '')
    .replace(/[.,!?।]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const words = name.split(' ')
  if (name.length < 2 || name.length > 80 || words.length > 5 || /\d/.test(name)) return null
  return hasDevanagari(name) ? name : titleCase(name)
}

/** What to say out loud for a text reply: links and emoji removed. `hadLink` means the text must be sent too. */
export function spokenText(body: string): { speech: string; hadLink: boolean } {
  const hadLink = /https?:\/\/\S+/i.test(body)
  const speech = body
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s*:\s*$/u, '.')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([.,!?।])/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return { speech, hadLink }
}
