import { randomBytes } from 'node:crypto'

/** Deterministic PRNG so the seeded sandbox world has stable ids across restarts. */
export function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function digits(rand: () => number, n: number): string {
  let s = String(1 + Math.floor(rand() * 9))
  while (s.length < n) s += Math.floor(rand() * 10)
  return s
}

/** Cloud API message ids look like `wamid.HBgL...` (base64 of an internal key). */
export const wamid = () => 'wamid.HBgM' + randomBytes(24).toString('base64').replace(/[+/=]/g, '')

/** Linked-device message ids are upper-case hex, e.g. 3EB0C767D26A1B2C. */
export const waWebId = () => '3EB0' + randomBytes(8).toString('hex').toUpperCase()

export const uid = (prefix: string) => `${prefix}_${randomBytes(6).toString('hex')}`

export const now = () => Date.now()
export const unix = (ms = Date.now()) => String(Math.floor(ms / 1000))
