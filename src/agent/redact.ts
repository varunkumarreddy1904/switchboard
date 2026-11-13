/**
 * PII redaction applied to group messages before storage and before any LLM call.
 * Deliberately conservative: it over-redacts number-like strings rather than leak one.
 */
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi
const CARD = /\b(?:\d[ -]?){13,19}\b/g
const PHONE = /(?<![\w/])\+?\d[\d\s().-]{6,}\d(?![\w/])/g
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/g

export function redact(text: string): { text: string; count: number } {
  let count = 0
  const sub = (label: string) => () => {
    count++
    return `[${label}]`
  }
  let out = text.replace(EMAIL, sub('email'))
  out = out.replace(IBAN, sub('iban'))
  out = out.replace(CARD, (m) => (m.replace(/\D/g, '').length >= 13 ? sub('card')() : m))
  out = out.replace(PHONE, (m) => (m.replace(/\D/g, '').length >= 8 ? sub('phone')() : m))
  return { text: out, count }
}

/** Phrases that try to steer an LLM; used to flag (not obey) group content. */
const INJECTION = /(ignore (all |your |the )?(previous|prior|above) (instructions|prompt)|system (notice|prompt|message)|you are now|disregard (your|the) (rules|instructions)|reveal (the|your) (system )?prompt)/i

export const looksLikeInjection = (text: string) => INJECTION.test(text)
