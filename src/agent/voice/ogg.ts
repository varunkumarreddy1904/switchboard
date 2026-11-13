/**
 * Minimal Ogg/Opus inspection in plain JS (no ffprobe needed). Enough to check Meta's voice-note rule
 * (".ogg encoded with OPUS, mono") before uploading, and to measure how long a note is.
 */
export interface OggOpusInfo {
  channels: number
  durationSec: number
}

const isOggS = (b: Uint8Array, i: number) => b[i] === 0x4f && b[i + 1] === 0x67 && b[i + 2] === 0x67 && b[i + 3] === 0x53

export function inspectOggOpus(bytes: Uint8Array): OggOpusInfo | null {
  if (bytes.length < 47 || !isOggS(bytes, 0)) return null
  const head = 27 + bytes[26]
  if (new TextDecoder().decode(bytes.subarray(head, head + 8)) !== 'OpusHead') return null
  const channels = bytes[head + 9]
  const preSkip = bytes[head + 10] | (bytes[head + 11] << 8)
  // Walk the pages: the last page's granule position is the total sample count at 48 kHz.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let off = 0
  let granule = 0n
  while (off + 27 <= bytes.length && isOggS(bytes, off)) {
    const segs = bytes[off + 26]
    let len = 27 + segs
    for (let k = 0; k < segs; k++) len += bytes[off + 27 + k]
    const g = view.getBigInt64(off + 6, true)
    if (g > 0n) granule = g
    off += len
  }
  return { channels, durationSec: Math.max(0, (Number(granule) - preSkip) / 48_000) }
}

/** What WhatsApp needs to show a voice note: Ogg container, Opus codec, one channel. */
export const isVoiceNoteFormat = (bytes: Uint8Array) => inspectOggOpus(bytes)?.channels === 1

/** A 0.6 s quiet mono Ogg/Opus clip. Used by tests and by the sandbox when no speech engine is installed. */
export const STUB_OGG = Buffer.from(
  'T2dnUwACAAAAAAAAAAAQH06fAAAAAAynPYsBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAABAfTp8BAAAALO9XmgE8T3B1c1RhZ3MMAAAATGF2ZjYzLjEuMTAyAQAAABwAAABlbmNvZGVyPUxhdmM2My4xLjEwMiBsaWJvcHVzT2dnUwAEuHEAAAAAAAAQH06fAgAAAJmW3rwfKyEfHx8fHBweHxwdHB4fHB8eHB8cHh0eHB8gHBwdEUgB1OTI7iVa9ircS6PUNusEvo5lxi9YgD9lOW/MQ1byEwzP2TPwbfV8cHhIF3K6xAX1GBebYW7eKLbpCEUik578FPvaSUvLVSZ+RWBIEkGCxJqVOVrvnyRLf7b/6RysHscpu8W6KiusK2xOSBJBgsSaktSowT5zoTyB1Gzi/XOQ5jwwfxIq9J7+gEgSQYLEmq92fVY9u/Gq/fMJSSCSdFuDQ1q3Y5FCDFRIEkGCxJqVM+B7GT1vz6e66vKiW8T+xcB+lVAj/leASBJBgsSarfnpM4dsLHT20Up5BfSsahKBD+vpLUgSQYLEmo5Cz3gT0GwxWVGm9wrDJrXhRe8nBMRIEkGCxJp4E7oH24blLfyeqb9JeCTI49gQbike/BBIEkGCxJrJBQFTta+hJA/00eB/OXvLdmYc4GVdEBlySBJBgsSadVHYb2dtovAr+bNcxYxaRNPoxYInoEgSQYLEmq7Z8JdSEApt3+9Tf/eO85zTaXUlCgCUSBJBgsSarY/Y8dR+CuwAncQG6kKABVtufGkV2kgSQYLEmq0+bWQmTDBP13ewsgR2qOq2Z0TFnsqdVkgSQYLEmpYCqtuCs25MnHCGIHfgGp2M8BlrdsO2csBIEkGCxJp6CRNvzr/ryfSxxxZCfYiLfYXOBJr9SBJBgsSayiXEC21KYmoYLsXvnqSa5LmYvVwzkiXUgEgSQYLEmseUMmK8KFWdn0GxE8jwOqWhlAZaBlPISkgSQYLEmnNF/FlfPhY0q00M8thhZxiHZLdERVBIEkGCxJqvt8iGJba6HN8egajguRATCKxxoE8+AoSuSBJBgsSadVb0mwDj5ErSVVZUqD+0UnExz+BtwEgSQYLEmpP/DhJbXXNxjVc56TGAs3CO50BiqICKwEgSQYLEmo4+SQLumaj3bNuIytsxZTjrAaWptT9YSBJBgsSar7AbfsOlvw3igqSXQBacpnRFAXeSXsSNSBJBgsSakCwjKDuuE+nC+7VKTWaopcGZcGaQIEgSQYLEmpTnhvI8hwVo3J/xxQynMDkcDLFMxZcAz/RIEkGCxJrKdj0YeQmgFC8X20rP+AMjqdAbRSVe9QMkQEgSQYLEmo4WJo5MndRMlAIwwhYzkV9BdclvWSBIEkGCxJqqBhfSenovDBHux+OHtkw8bNM7hBeVSBJBgsSar7aqgA5qQPECaCo/8ESY6uFd0GFnv5hIAio6VgdrGaAJm/ZEdC4nKA==',
  'base64',
)
