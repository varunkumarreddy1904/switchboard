import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { inspectOggOpus, STUB_OGG } from './ogg'
import { run, splitWav, toVoiceOgg, toWav16k } from './tools'

export type Lang = 'en' | 'hi' | 'te'
export const LANG_NAME: Record<Lang, string> = { en: 'English', hi: 'Hindi', te: 'Telugu' }

// ------------------------------------------------------------------ speech-to-text

export interface Transcript {
  text: string
  /** Whisper's language code (e.g. "hi", "en"), or the sandbox script's. */
  language: string | null
  engine: string
  ms: number
}

export interface SpeechToText {
  readonly name: string
  transcribe(input: { file: string; mediaId: string }): Promise<Transcript>
}

/**
 * Words Whisper should expect. The business profile replaces this with its own vocabulary (product and
 * place names); kept short so it can't dominate silence.
 */
export const WHISPER_HINT = 'WhatsApp, START, STOP, HELP.'

/** Strips Whisper's non-speech markers and catches the classic "prompt echoed on silence" hallucination. */
export function cleanTranscript(text: string, hint = WHISPER_HINT): string {
  const t = text
    .replace(/\[[^\]]*\]|\([^)]*(music|noise|silence|applause|laughs?|blank)[^)]*\)|\*[^*]*\*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const letters = (s: string) => s.toLowerCase().replace(/[^\p{L}]/gu, '')
  if (letters(t) && letters(hint).includes(letters(t))) return ''
  return t
}

const modelName = (model: string) => basename(model).replace(/^ggml-|\.bin$/g, '')

/** English-only Whisper models (".en") skip language detection: faster and more accurate for English. */
export const isEnglishModel = (model: string) => /\.en[.-]/.test(basename(model))

/**
 * whisper.cpp's CLI on this machine (Metal on Apple Silicon). One process per note: the model loads each
 * time. Measured on an M1: large-v3-turbo about 4.5 s per note, small.en about 0.75 s.
 */
export class WhisperCli implements SpeechToText {
  readonly name: string
  constructor(
    private bin: string,
    private model: string,
    private ffmpeg: string,
    private tmpDir: string,
    private hint: () => string = () => WHISPER_HINT,
  ) {
    this.name = `whisper · ${modelName(model)}`
  }

  async transcribe({ file }: { file: string }): Promise<Transcript> {
    const t0 = Date.now()
    const base = join(this.tmpDir, `stt-${randomBytes(5).toString('hex')}`)
    try {
      await toWav16k(this.ffmpeg, file, `${base}.wav`)
      if (isEnglishModel(this.model)) return { ...(await this.once(base, 'en')), engine: this.name, ms: Date.now() - t0 }
      let r = await this.once(base, 'auto')
      // Whisper sometimes writes Hindi speech in Urdu script; Hindi in Devanagari is what the bot and the team can read.
      if (r.language === 'ur' || /[؀-ۿ]/.test(r.text)) r = await this.once(base, 'hi')
      return { ...r, engine: this.name, ms: Date.now() - t0 }
    } finally {
      await Promise.all(['.wav', '.json'].map((ext) => rm(base + ext, { force: true })))
    }
  }

  private async once(base: string, lang: string) {
    const hint = this.hint()
    const res = await run(this.bin, ['-m', this.model, '-f', `${base}.wav`, '-l', lang, '-oj', '-of', base, '-np', '-nt', '--prompt', hint], 180_000)
    if (res.code !== 0) throw new Error(`whisper-cli exited ${res.code}: ${res.stderr.trim().slice(-300)}`)
    const j = JSON.parse(await readFile(`${base}.json`, 'utf8'))
    const raw = ((j.transcription ?? []) as { text: string }[]).map((s) => s.text).join('')
    return { text: cleanTranscript(raw, hint), language: (j.result?.language as string | undefined) ?? (lang === 'auto' ? null : lang) }
  }
}

/**
 * whisper.cpp's server, started once and kept loaded, so a note costs only the inference: about 0.45 s
 * for small.en on an M1 (vs 0.75 s with the CLI). Started lazily; if it dies it restarts on the next note.
 */
export class WhisperServer implements SpeechToText {
  readonly name: string
  private proc: ChildProcess | null = null
  private ready: Promise<void> | null = null

  constructor(
    private bin: string,
    readonly model: string,
    private ffmpeg: string,
    private tmpDir: string,
    private port: number,
    private hint: () => string = () => WHISPER_HINT,
  ) {
    this.name = `whisper server · ${modelName(model)}`
  }

  start(): Promise<void> {
    if (!this.ready) {
      this.ready = this.boot().catch((e) => {
        this.ready = null
        throw e
      })
    }
    return this.ready
  }

  private async boot() {
    const english = isEnglishModel(this.model)
    const proc = spawn(this.bin, ['-m', this.model, '--host', '127.0.0.1', '--port', String(this.port), '-l', english ? 'en' : 'auto', '-t', '4'], { stdio: 'ignore' })
    this.proc = proc
    proc.on('exit', () => {
      if (this.proc === proc) {
        this.proc = null
        this.ready = null
      }
    })
    for (let i = 0; i < 120; i++) {
      if (proc.exitCode !== null) throw new Error(`whisper-server exited (${proc.exitCode})`)
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/`, { signal: AbortSignal.timeout(500) })
        if (r.status < 500) return
      } catch {
        /* still loading */
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    proc.kill()
    throw new Error('whisper-server did not start within 30 s')
  }

  async transcribe({ file }: { file: string }): Promise<Transcript> {
    const t0 = Date.now()
    await this.start()
    const wav = join(this.tmpDir, `stt-${randomBytes(5).toString('hex')}.wav`)
    try {
      await toWav16k(this.ffmpeg, file, wav)
      const english = isEnglishModel(this.model)
      const hint = this.hint()
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(await readFile(wav))], { type: 'audio/wav' }), 'note.wav')
      form.append('response_format', 'verbose_json')
      form.append('temperature', '0')
      form.append('language', english ? 'en' : 'auto')
      form.append('prompt', hint)
      const res = await fetch(`http://127.0.0.1:${this.port}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) })
      if (!res.ok) throw new Error(`whisper-server HTTP ${res.status}`)
      const j: any = await res.json()
      const language = english ? 'en' : typeof j.language === 'string' ? ({ english: 'en', hindi: 'hi', telugu: 'te', urdu: 'ur' }[j.language as string] ?? j.language) : null
      return { text: cleanTranscript(String(j.text ?? ''), hint), language, engine: this.name, ms: Date.now() - t0 }
    } finally {
      await rm(wav, { force: true })
    }
  }

  stop() {
    this.proc?.kill()
    this.proc = null
    this.ready = null
  }
}

/** Sandbox: the simulated phone already knows what the persona "said", so tests are exact and instant. */
export class ScriptedStt implements SpeechToText {
  readonly name = 'sandbox script'
  constructor(private lookup: (mediaId: string) => { text: string; lang: string } | undefined) {}
  async transcribe({ mediaId }: { mediaId: string }): Promise<Transcript> {
    const s = this.lookup(mediaId)
    if (!s) throw new Error('No script for this sandbox voice note')
    return { text: s.text, language: s.lang, engine: this.name, ms: 0 }
  }
}

// ------------------------------------------------------------------ Sarvam (hosted, Indian languages)

export const SARVAM_BASE = 'https://api.sarvam.ai'
/** The settings the EquipExchange app found best for how people here speak (dialect words kept as said). */
export const SARVAM_STT_MODEL = 'saaras:v4'
export const SARVAM_STT_MODE = 'codemix'
export const SARVAM_TTS_MODEL = 'bulbul:v4-flash'
export const SARVAM_SPEAKERS: Record<Lang, string> = { en: 'deven_en_conversation', hi: 'tarun_hi_conversational', te: 'pooja_te_conversation' }
export const SARVAM_PACE: Record<Lang, number> = { en: 1, hi: 0.9, te: 1 }
/** Sarvam's one-request endpoint is for short clips (about 30 s); longer notes are sent in pieces. */
const SARVAM_CLIP_SECONDS = 25
const SARVAM_CODE: Record<Lang, string> = { en: 'en-IN', hi: 'hi-IN', te: 'te-IN' }
const MIME_BY_EXT: Record<string, string> = { '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.amr': 'audio/amr', '.aac': 'audio/aac', '.wav': 'audio/wav' }

type Fetch = typeof fetch

async function sarvamError(what: string, res: Response): Promise<Error> {
  const body = (await res.text().catch(() => '')).slice(0, 200)
  const why = res.status === 403 ? 'the API key was refused' : res.status === 429 ? 'rate limit or credits used up' : body || res.statusText
  return new Error(`Sarvam ${what} ${res.status}: ${why}`)
}

/**
 * Sarvam speech-to-text: the language is detected (Telugu, Hindi, English and mixes of them), and words
 * come back in the language's own script. The recording goes to Sarvam's servers; nothing is kept there
 * by this code. WhatsApp's Ogg/Opus is sent as it is, so short notes need no ffmpeg.
 */
export class SarvamStt implements SpeechToText {
  readonly name: string
  constructor(
    private key: string,
    private opts: { model?: string; mode?: string; ffmpeg: string | null; tmpDir: string; fetch?: Fetch },
  ) {
    this.name = `Sarvam · ${opts.model ?? SARVAM_STT_MODEL}`
  }

  async transcribe({ file }: { file: string }): Promise<Transcript> {
    const t0 = Date.now()
    const bytes = await readFile(file)
    const seconds = inspectOggOpus(bytes)?.durationSec ?? null
    const mime = MIME_BY_EXT[extname(file).toLowerCase()] ?? 'application/octet-stream'
    if (seconds === null || seconds <= SARVAM_CLIP_SECONDS + 3 || !this.opts.ffmpeg) {
      return { ...(await this.clip(bytes, mime)), engine: this.name, ms: Date.now() - t0 }
    }
    // A long note: cut it into short pieces, hear each in turn, and join the words.
    const base = join(this.opts.tmpDir, `stt-${randomBytes(5).toString('hex')}`)
    try {
      await splitWav(this.opts.ffmpeg, file, base, SARVAM_CLIP_SECONDS)
      const pieces = (await readdir(dirname(base))).filter((f) => f.startsWith(`${basename(base)}-`)).sort()
      const parts: { text: string; language: string | null }[] = []
      for (const p of pieces) parts.push(await this.clip(await readFile(join(dirname(base), p)), 'audio/wav'))
      const text = parts.map((p) => p.text).filter(Boolean).join(' ')
      return { text, language: parts.find((p) => p.language)?.language ?? null, engine: this.name, ms: Date.now() - t0 }
    } finally {
      const dir = dirname(base)
      await Promise.all((await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith(`${basename(base)}-`)).map((f) => rm(join(dir, f), { force: true })))
    }
  }

  private async clip(bytes: Buffer, mime: string): Promise<{ text: string; language: string | null }> {
    const model = this.opts.model ?? SARVAM_STT_MODEL
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), 'recording')
    form.append('model', model)
    form.append('language_code', 'unknown')
    if (model === 'saaras:v4' || model === 'saaras:v3') form.append('mode', this.opts.mode ?? SARVAM_STT_MODE)
    const res = await (this.opts.fetch ?? fetch)(`${SARVAM_BASE}/speech-to-text`, { method: 'POST', headers: { 'api-subscription-key': this.key }, body: form, signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw await sarvamError('speech-to-text', res)
    const j = (await res.json()) as { transcript?: string; language_code?: string | null }
    // "te-IN" → "te"
    return { text: (j.transcript ?? '').replace(/\s+/g, ' ').trim(), language: j.language_code ? j.language_code.toLowerCase().split(/[-_]/)[0] : null }
  }
}

/**
 * Sarvam text-to-speech (Bulbul): one voice per language. The words to speak go to Sarvam's servers.
 * It answers with WAV; ffmpeg turns that into the mono Ogg/Opus WhatsApp wants for a voice note.
 */
export class SarvamTts implements TextToSpeech {
  readonly name: string
  constructor(
    private key: string,
    private ffmpeg: string,
    private tmpDir: string,
    private opts: { model?: string; speakers?: Partial<Record<Lang, string>>; fetch?: Fetch } = {},
  ) {
    this.name = `Sarvam · ${opts.model ?? SARVAM_TTS_MODEL}`
  }

  /** What identifies the voice for a language (cached recordings are kept per voice). */
  voiceId(lang: Lang) {
    return `sarvam|${this.opts.model ?? SARVAM_TTS_MODEL}|${this.opts.speakers?.[lang] || SARVAM_SPEAKERS[lang]}`
  }

  async speak(text: string, lang: Lang, out: string) {
    const settings = {
      text,
      speaker: this.opts.speakers?.[lang] || SARVAM_SPEAKERS[lang],
      model: this.opts.model ?? SARVAM_TTS_MODEL,
      pace: SARVAM_PACE[lang],
      speech_sample_rate: '24000',
      output_audio_codec: 'wav',
    }
    const post = (body: Record<string, unknown>) =>
      (this.opts.fetch ?? fetch)(`${SARVAM_BASE}/text-to-speech`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'api-subscription-key': this.key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(45_000),
      })
    // Sarvam's own client names the language field `target_language_code`; its reference page says `language_code`.
    let res = await post({ ...settings, target_language_code: SARVAM_CODE[lang] })
    if (res.status === 400 || res.status === 422) {
      const first = await sarvamError('text-to-speech', res)
      res = await post({ ...settings, language_code: SARVAM_CODE[lang] })
      if (!res.ok) throw first
    }
    if (!res.ok) throw await sarvamError('text-to-speech', res)
    const audio = ((await res.json()) as { audios?: string[] }).audios?.[0]
    if (!audio) throw new Error('Sarvam text-to-speech returned no audio')
    const wav = join(this.tmpDir, `tts-${randomBytes(5).toString('hex')}.wav`)
    try {
      await writeFile(wav, Buffer.from(audio, 'base64'))
      await toVoiceOgg(this.ffmpeg, wav, out)
    } finally {
      await rm(wav, { force: true })
    }
  }
}

// ------------------------------------------------------------------ text-to-speech

export interface TextToSpeech {
  readonly name: string
  /** Writes a mono Ogg/Opus voice note to `out`. */
  speak(text: string, lang: Lang, out: string): Promise<void>
}

/** macOS voices (offline, free): e.g. Lekha for Hindi, Tara or Rishi for Indian English. */
export class MacSay implements TextToSpeech {
  readonly name = 'macOS voices'
  constructor(
    private say: string,
    private ffmpeg: string,
    private voices: Record<Lang, string>,
    private tmpDir: string,
  ) {}

  voiceId(lang: Lang) {
    return this.voices[lang]
  }

  async speak(text: string, lang: Lang, out: string) {
    if (!this.voices[lang]) throw new Error(`no macOS voice is set for ${LANG_NAME[lang]}`)
    const base = join(this.tmpDir, `tts-${randomBytes(5).toString('hex')}`)
    try {
      // Text goes in a file, not argv: no quoting issues and no length limit.
      await writeFile(`${base}.txt`, text)
      const r = await run(this.say, ['-v', this.voices[lang], '-o', `${base}.aiff`, '-f', `${base}.txt`], 60_000)
      if (r.code !== 0) throw new Error(`say failed: ${r.stderr.trim().slice(-200) || `exit ${r.code}`}`)
      await toVoiceOgg(this.ffmpeg, `${base}.aiff`, out)
    } finally {
      await Promise.all(['.txt', '.aiff'].map((ext) => rm(base + ext, { force: true })))
    }
  }
}

/** Tests: a fixed short clip, so scenes don't depend on the machine's voices. */
export class StubTts implements TextToSpeech {
  readonly name = 'stub clip'
  async speak(_text: string, _lang: Lang, out: string) {
    await writeFile(out, STUB_OGG)
  }
}

export interface SayVoice {
  name: string
  locale: string
}

/** Parses `say -v ?` ("Lekha               hi_IN    # …", "Tara (English (India)) en_IN    # …"). */
export async function listSayVoices(say: string): Promise<SayVoice[]> {
  const r = await run(say, ['-v', '?'], 15_000)
  if (r.code !== 0) return []
  const seen = new Set<string>()
  return r.stdout
    .split('\n')
    .map((l) => /^(.+?)\s+([a-z]{2,3}_[A-Z0-9]{2,3})\s+#/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ name: m[1].trim(), locale: m[2] }))
    .filter((v) => (seen.has(v.name) ? false : (seen.add(v.name), true)))
}
