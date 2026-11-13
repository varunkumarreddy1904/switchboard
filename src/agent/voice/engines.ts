import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { STUB_OGG } from './ogg'
import { run, toVoiceOgg, toWav16k } from './tools'

export type Lang = 'en' | 'hi'

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

  async speak(text: string, lang: Lang, out: string) {
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
