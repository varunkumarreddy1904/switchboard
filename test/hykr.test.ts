import { describe, expect, it } from 'vitest'
import { driverName } from '../src/hykr/brain'
import { codeWord, COPY, staticLines } from '../src/hykr/copy'
import { cleanPlace, isSkip, looksLikeQuestion, matchClass, nameMatches, parseKm, parseNumbers, parsePhone, parsePin, parseRates, parseRegNo, parseYear } from '../src/hykr/parse'

describe('PoC #12: understanding owners’ answers', () => {
  it('takes the driver’s name from a typed name and number (D80)', () => {
    expect(driverName('Ramesh 98480 12345')).toBe('Ramesh')
    expect(driverName('my driver is ramesh kumar, +91 98480 12345')).toBe('Ramesh Kumar')
    expect(driverName('9848012345')).toBeNull()
    expect(parsePhone('my driver is ramesh, 98480 12345')).toBe('919848012345')
  })

  it('reads amounts typed or spoken', () => {
    expect(parseNumbers('₹900')).toEqual([900])
    expect(parseNumbers('900 rupees per hour and 7,000 per day')).toEqual([900, 7000])
    expect(parseNumbers('nine hundred')).toEqual([900])
    expect(parseNumbers('one thousand two hundred')).toEqual([1200])
    expect(parseNumbers('Nine hundred rupees per hour and seven thousand per day')).toEqual([900, 7000])
    expect(parseNumbers('1.5 lakh')).toEqual([150000])
  })

  it('takes the day rate from the same answer when the owner gives both', () => {
    expect(parseRates('900 per hour and 7000 per day')).toEqual({ first: 900, day: 7000 })
    expect(parseRates('900')).toEqual({ first: 900, day: null })
    expect(parseRates('I want 900, maybe 1000')).toEqual({ first: 900, day: null })
  })

  it('reads distances, years, registration numbers, PINs and phone numbers', () => {
    expect(parseKm('Twenty five kilometres')).toBe(25)
    expect(parseKm('up to 30 km')).toBe(30)
    expect(parseYear('made in 2019')).toBe(2019)
    expect(parseRegNo('ts03ab1234')).toBe('TS 03 AB 1234')
    expect(parseRegNo('TS-00-TE-0001')).toBe('TS 00 TE 0001')
    expect(parsePin('tstbhl19c00000001')).toBe('TSTBHL19C00000001')
    expect(parsePin('TSTBHL19C0000001')).toBeNull() // 16 characters
    expect(parsePhone('90000 00012')).toBe('919000000012')
    expect(parsePhone('+91 90000 00012')).toBe('919000000012')
    expect(parsePhone('12345')).toBeNull()
  })

  it('recognises machine types in everyday words', () => {
    expect(matchClass('It is a JCB backhoe')?.cls).toBe('backhoe_loader')
    expect(matchClass('Poclain')?.cls).toBe('excavator')
    expect(matchClass('JCB with a rock breaker')?.cls).toBe('breaker')
    expect(matchClass('dumper truck')?.cls).toBe('tipper')
    expect(matchClass('my bicycle')).toBeNull()
  })

  it('knows skips, questions and places', () => {
    expect(isSkip('later')).toBe(true)
    expect(isSkip('I don’t have it')).toBe(true)
    expect(isSkip('Kazipet')).toBe(false)
    expect(looksLikeQuestion('what is a PIN plate?')).toBe(true)
    expect(looksLikeQuestion('Ravi Kumar')).toBe(false)
    expect(cleanPlace('I am from kazipet.')).toBe('Kazipet')
    expect(cleanPlace('Hanamkonda')).toBe('Hanamkonda')
    expect(cleanPlace('Hanamkonda, near the bus stand')).toBe('Hanamkonda, near the Bus Stand')
  })

  it('matches the RC name to the owner, ignoring initials and case', () => {
    expect(nameMatches('Ravi Kumar', 'RAVI KUMAR')).toBe(true)
    expect(nameMatches('Ravi Kumar', 'K. RAVI KUMAR')).toBe(true)
    expect(nameMatches('Venkat Reddy', 'K. NARAYANA')).toBe(false)
  })
})

describe('PoC #12: wording', () => {
  it('pre-speaks only lines without personal data', () => {
    const lines = staticLines()
    expect(lines).toContain(COPY.askName)
    expect(lines.some((l) => l.includes('{'))).toBe(false)
    expect(lines).not.toContain(COPY.nameHeard)
  })
  it('uses a code word that changes daily', () => {
    expect(codeWord(new Date('2026-11-11T10:00:00+05:30'))).not.toBe(codeWord(new Date('2026-11-12T10:00:00+05:30')))
    expect(codeWord(new Date('2026-11-11T08:00:00+05:30'))).toBe(codeWord(new Date('2026-11-11T22:00:00+05:30')))
  })
})
