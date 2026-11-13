import { normalize } from '../agent/voice/match'

/**
 * Understanding owners' answers, typed or spoken (speech-to-text output). Plain rules, instant, offline:
 * the AI is only used for free questions and for reading photos.
 */

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
}
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }
const SCALES: Record<string, number> = { hundred: 100, thousand: 1000, k: 1000, lakh: 100_000, lakhs: 100_000, lac: 100_000 }

/** All numbers in a sentence, in order: "₹900 per hour and 7,000 per day" → [900, 7000]; "nine hundred" → [900]. */
export function parseNumbers(text: string): number[] {
  const out: number[] = []
  const t = text.toLowerCase().replace(/₹|rs\.?|inr/g, ' ')
  // Digits first ("7,000", "1.5 lakh", "5k").
  const digitRe = /(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lac|k|thousand|hundred)?\b/g
  let m: RegExpExecArray | null
  let sawDigits = false
  while ((m = digitRe.exec(t))) {
    sawDigits = true
    let n = Number(m[1].replace(/,/g, ''))
    if (m[2]) n *= SCALES[m[2].replace(/s$/, '')] ?? SCALES[m[2]] ?? 1
    if (Number.isFinite(n)) out.push(Math.round(n))
  }
  if (sawDigits) return out
  // Words ("one thousand two hundred", "nine hundred and fifty").
  let current = 0
  let total = 0
  let any = false
  const flush = () => {
    if (any) out.push(total + current)
    current = 0
    total = 0
    any = false
  }
  for (const w of t.split(/[^a-z]+/)) {
    if (!w || w === 'and') continue
    if (w in SMALL) (current += SMALL[w]), (any = true)
    else if (w in TENS) (current += TENS[w]), (any = true)
    else if (w === 'hundred') (current = (current || 1) * 100), (any = true)
    else if (w in SCALES) (total += (current || 1) * SCALES[w]), (current = 0), (any = true)
    else flush()
  }
  flush()
  return out
}

/** "900 per hour and 7000 per day" → { hour: 900, day: 7000 }. A single number is the one being asked for. */
export function parseRates(text: string): { first: number | null; day: number | null } {
  const nums = parseNumbers(text).filter((n) => n > 0)
  if (!nums.length) return { first: null, day: null }
  const mentionsDay = /\b(day|daily|full day|per day|a day)\b/i.test(text)
  return { first: nums[0], day: nums.length > 1 && mentionsDay ? nums[1] : null }
}

export const parseKm = (text: string) => parseNumbers(text).find((n) => n > 0 && n <= 500) ?? null

export function parseYear(text: string): number | null {
  const y = /\b(19[89]\d|20[0-3]\d)\b/.exec(text)
  return y ? Number(y[1]) : null
}

/** Indian registration number: "ts 03 ab 1234", "TS03AB1234", "TS-00-TE-0001" → "TS 03 AB 1234". */
export function parseRegNo(text: string): string | null {
  const m = /\b([A-Z]{2})[\s-]*(\d{1,2})[\s-]*([A-Z]{0,3})[\s-]*(\d{1,4})\b/i.exec(text.toUpperCase())
  if (!m) return null
  return [m[1], m[2].padStart(2, '0'), m[3], m[4].padStart(4, '0')].filter(Boolean).join(' ')
}

/** 17-character PIN / VIN (ISO 10261 / 3779). Spaces removed. */
export function parsePin(text: string): string | null {
  const m = /\b([A-HJ-NPR-Z0-9][A-HJ-NPR-Z0-9 ]{15,22}[A-HJ-NPR-Z0-9])\b/i.exec(text.toUpperCase())
  const pin = m?.[1].replace(/\s/g, '')
  return pin && pin.length === 17 ? pin : null
}

/** A WhatsApp number in E.164 without "+": 10 Indian digits get 91 in front. */
export function parsePhone(text: string): string | null {
  const d = text.replace(/\D/g, '')
  if (d.length === 10 && /^[6-9]/.test(d)) return `91${d}`
  if (d.length >= 11 && d.length <= 15) return d.replace(/^0+/, '')
  return null
}

export const CLASS_OPTIONS = [
  { id: 'cls_backhoe_loader', cls: 'backhoe_loader', title: 'Backhoe loader (JCB)', label: 'backhoe loader', says: ['backhoe', 'back hoe', 'jcb', '3dx', 'loader', 'backhoe loader'] },
  { id: 'cls_excavator', cls: 'excavator', title: 'Excavator (Poclain)', label: 'excavator', says: ['excavator', 'poclain', 'pokelane', 'poclane', 'hitachi', 'digger', 'crawler'] },
  { id: 'cls_breaker', cls: 'breaker', title: 'Breaker', label: 'breaker', says: ['breaker', 'rock breaker', 'hammer', 'hydraulic breaker'] },
  { id: 'cls_tipper', cls: 'tipper', title: 'Tipper', label: 'tipper', says: ['tipper', 'tipper truck', 'dumper', 'truck', 'dump truck'] },
  { id: 'cls_other', cls: 'other', title: 'Other', label: 'machine', says: ['other', 'something else', 'roller', 'crane', 'grader', 'dozer', 'paver'] },
] as const

export function matchClass(text: string): (typeof CLASS_OPTIONS)[number] | null {
  const n = ` ${normalize(text)} `
  const hits = CLASS_OPTIONS.filter((o) => o.says.some((w) => n.includes(` ${w} `)))
  // "JCB with a breaker" → breaker wins over backhoe: the more specific attachment the owner named.
  if (hits.some((h) => h.cls === 'breaker')) return CLASS_OPTIONS.find((o) => o.cls === 'breaker')!
  return hits.length ? hits[0] : null
}

export const classLabel = (cls: string | null, other?: string | null) => (cls === 'other' ? other || 'machine' : CLASS_OPTIONS.find((o) => o.cls === cls)?.label ?? 'machine')

const SKIP = ['skip', 'later', 'send later', 'not now', 'no', 'nope', 'dont have', 'do not have', 'cant find', 'cannot find', 'not available', 'dont know', 'no rc', 'no invoice', 'none', 'nothing']
export const isSkip = (text: string) => {
  const n = ` ${normalize(text)} `
  return SKIP.some((w) => n.includes(` ${w} `))
}

export const looksLikeQuestion = (text: string) => /\?\s*$/.test(text.trim()) || /^(what|why|how|when|where|who|which|can|could|do|does|is|are|will|should)\b/i.test(text.trim())

/** "Ravi Kumar" vs "RAVI KUMAR" / "K. Ravi Kumar": same person if they share a name word (not initials). */
export function nameMatches(a: string | null | undefined, b: string | null | undefined) {
  if (!a || !b) return true
  const words = (s: string) => new Set(s.toUpperCase().replace(/[^A-Z\s]/g, ' ').split(/\s+/).filter((w) => w.length > 1))
  const wa = words(a)
  return [...words(b)].some((w) => wa.has(w))
}

/** "I am from Kazipet." → "Kazipet"; "near the bus stand, Hanamkonda" kept as said. */
export function cleanPlace(text: string) {
  const t = text
    .trim()
    .replace(/^(i am|i'm|im|we are|it is|it's|its|the machine is|my machine is|machine is)?\s*(from|in|at|based in|near)?\s+/i, '')
    .replace(/[.!]+$/, '')
    .trim()
  // Capitalise place words, not the little ones: "hanamkonda, near the bus stand" → "Hanamkonda, near the Bus Stand".
  const small = new Set(['near', 'the', 'of', 'at', 'in', 'on', 'and', 'to', 'by', 'opposite', 'behind', 'beside'])
  return t.replace(/\p{L}+/gu, (w, i) => (i > 0 && small.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
}

export const rupees = (paise: number | null | undefined) => (paise == null ? '—' : `₹${Math.round(paise / 100).toLocaleString('en-IN')}`)
