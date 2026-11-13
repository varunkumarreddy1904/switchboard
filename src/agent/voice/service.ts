import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { uid } from '../../shared/ids'
import { KeyedQueue } from '../../shared/queue'
import type { Agent } from '../agent'
import { t } from '../i18n'
import type { MessageRow } from '../store'
import { isEnglishModel, listSayVoices, MacSay, ScriptedStt, StubTts, WHISPER_HINT, WhisperCli, WhisperServer, type Lang, type SpeechToText, type TextToSpeech } from './engines'
import { hasDevanagari } from './match'
import { inspectOggOpus } from './ogg'
import { findTools, probeDuration, type VoiceTools } from './tools'

export type VoiceReplies = 'mirror' | 'always' | 'never'

export interface VoiceSettings {
  /** mirror = answer with a voice note when the person's last message was one. */
  replies: VoiceReplies
  voiceEn: string
  voiceHi: string
  maxSeconds: number
  /** Raw audio is deleted after this many hours; transcripts stay. */
  retentionHours: number
  whisperModel: string
  /** Run real Whisper on simulator voice notes too (default: use the words the persona "said"). */
  sandboxWhisper: boolean
}

/**
 * English first (PoC #12): small.en kept loaded in whisper-server, about 0.45 s per note on an M1.
 * For Hindi or Telugu later, switch to the multilingual ggml-large-v3-turbo-q5_0.bin in Settings.
 */
export const DEFAULT_WHISPER_MODEL = 'models/whisper/ggml-small.en-q5_1.bin'
const WHISPER_PORT = Number(process.env.WHISPER_PORT ?? 8178)
/** Meta keeps uploaded media for 30 days; reuse an uploaded voice line for 25. */
const MEDIA_REUSE_MS = 25 * 86_400_000
const META_MAX_BYTES = 16 * 1024 * 1024
const round1 = (n: number) => Math.round(n * 10) / 10

export type ReceiveResult =
  | { ok: true; text: string; lang: Lang; seconds: number | null }
  | { ok: false; reason: 'too_long' | 'unavailable' | 'empty' | 'failed'; detail: string; reply: string }

const FAIL_TITLE = {
  too_long: 'Voice note too long: not transcribed',
  unavailable: 'Voice note received, but speech-to-text is unavailable',
  empty: 'Voice note had no recognisable speech',
  failed: 'Voice note could not be processed',
} as const

/**
 * The voice layer. It sits at the edges of the existing flow:
 *   in:  Meta media id → download → length check → speech-to-text → transcript (stored as the message text)
 *   out: reply text → text-to-speech → mono Ogg/Opus → upload → sent with voice: true
 * Onboarding and the FAQ bot only ever see text.
 */
export class Voice {
  /** Sandbox: what a simulated persona said, by Meta media id (wired by createApp). */
  scripted?: (mediaId: string) => { text: string; lang: string } | undefined
  /** Tests: use a fixed clip instead of the machine's voices. */
  stubSpeech = false
  /** Words speech-to-text should expect; the business profile sets its own (product and place names). */
  vocabulary = WHISPER_HINT
  readonly mediaDir: string
  private tmpDir: string
  private cacheDir: string
  private sttQueue = new KeyedQueue()
  private toolsCache: { at: number; tools: VoiceTools } | null = null
  private timer: NodeJS.Timeout | null = null
  private server: WhisperServer | null = null
  /** Fixed bot lines: spoken once, cached on disk, uploaded to Meta once per number and reused. */
  private staticLines = new Set<string>()

  constructor(
    private agent: Agent,
    dataDir: string,
  ) {
    this.mediaDir = join(dataDir, 'media')
    this.tmpDir = join(this.mediaDir, 'tmp')
    this.cacheDir = join(dataDir, 'tts-cache')
    mkdirSync(this.tmpDir, { recursive: true })
    mkdirSync(this.cacheDir, { recursive: true })
    agent.store.sql.exec('create table if not exists tts_media(key text, channel_id text, media_id text, uploaded_at int, primary key(key, channel_id))')
  }

  start() {
    this.sweep()
    this.timer = setInterval(() => this.sweep(), 10 * 60_000)
    this.timer.unref()
    if (!this.stubSpeech) {
      // Warm up in the background so the first owner doesn't pay for model loading or speech synthesis.
      const stt = this.stt(false)
      if (stt instanceof WhisperServer) stt.start().catch((e) => this.agent.bus.log({ kind: 'agent', lane: '-', title: 'Whisper server failed to start; using the CLI', detail: (e as Error).message }))
      void this.prewarm()
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.server?.stop()
  }

  /** The business registers its fixed lines so they can be pre-spoken and reused (no personal data in them). */
  registerStaticLines(lines: string[]) {
    for (const l of lines) if (l.trim()) this.staticLines.add(l.trim())
  }

  private cacheKey(text: string, lang: Lang) {
    const set = this.settings()
    return createHash('sha1').update(`${lang === 'hi' ? set.voiceHi : set.voiceEn}|${text}`).digest('hex').slice(0, 20)
  }

  /** Speaks every fixed line once, in the background, so replies only need an upload (or not even that). */
  async prewarm() {
    if (typeof this.tts() === 'string') return
    let made = 0
    const t0 = Date.now()
    for (const line of this.staticLines) {
      const lang: Lang = hasDevanagari(line) ? 'hi' : 'en'
      if (existsSync(join(this.cacheDir, `${this.cacheKey(line, lang)}.ogg`))) continue
      try {
        await this.cachedSpeech(line, lang)
        made++
      } catch {
        return
      }
    }
    if (made) this.agent.bus.log({ kind: 'agent', lane: '-', title: `Pre-spoke ${made} fixed bot lines`, detail: `${((Date.now() - t0) / 1000).toFixed(1)} s; replies using them skip text-to-speech` })
  }

  private async cachedSpeech(text: string, lang: Lang): Promise<{ key: string; bytes: Buffer }> {
    const key = this.cacheKey(text, lang)
    const file = join(this.cacheDir, `${key}.ogg`)
    if (existsSync(file)) return { key, bytes: readFileSync(file) }
    const bytes = await this.synthesize(text, lang)
    writeFileSync(file, bytes)
    return { key, bytes }
  }

  // ------------------------------------------------------------------ settings + engines

  settings(): VoiceSettings {
    const s = (k: string) => this.agent.store.setting(k)
    const num = (k: string, d: number) => {
      const n = Number(s(k))
      return Number.isFinite(n) && n > 0 ? n : d
    }
    const replies = s('voiceReplies')
    // The default changed to the fast English model: a saved path to a model that is gone falls back to it.
    const savedModel = s('whisperModel')
    return {
      replies: replies === 'always' || replies === 'never' ? replies : 'mirror',
      voiceEn: s('voiceEn') || 'Tara',
      voiceHi: s('voiceHi') || 'Lekha',
      maxSeconds: num('voiceMaxSeconds', 120),
      retentionHours: num('voiceRetentionHours', 24),
      whisperModel: (savedModel && existsSync(resolve(savedModel)) ? savedModel : '') || process.env.WHISPER_MODEL || DEFAULT_WHISPER_MODEL,
      sandboxWhisper: s('voiceSandboxWhisper') === '1',
    }
  }

  tools(fresh = false): VoiceTools {
    if (fresh || !this.toolsCache || Date.now() - this.toolsCache.at > 60_000) this.toolsCache = { at: Date.now(), tools: findTools() }
    return this.toolsCache.tools
  }

  /** The speech-to-text engine for a channel, or why there is none. */
  private stt(sandbox: boolean): SpeechToText | string {
    const set = this.settings()
    if (sandbox && this.scripted && !set.sandboxWhisper) return new ScriptedStt(this.scripted)
    const tools = this.tools()
    if (!tools.ffmpeg) return 'ffmpeg is not installed (brew install ffmpeg)'
    if (!tools.whisper) return 'whisper-cli is not installed (brew install whisper-cpp)'
    const model = resolve(set.whisperModel)
    if (!existsSync(model)) return `Whisper model not found at ${set.whisperModel}`
    const hint = () => this.vocabulary
    // Keep the model loaded in whisper-server when we can (English-only models load fast and answer in ~0.45 s).
    if (tools.whisperServer) {
      if (!this.server || this.server.model !== model) {
        this.server?.stop()
        this.server = new WhisperServer(tools.whisperServer, model, tools.ffmpeg, this.tmpDir, WHISPER_PORT, hint)
      }
      return this.server
    }
    return new WhisperCli(tools.whisper, model, tools.ffmpeg, this.tmpDir, hint)
  }

  /** Fallback when the server is unavailable: the same model through the CLI. */
  private cli(): SpeechToText | null {
    const tools = this.tools()
    const model = resolve(this.settings().whisperModel)
    return tools.whisper && tools.ffmpeg && existsSync(model) ? new WhisperCli(tools.whisper, model, tools.ffmpeg, this.tmpDir, () => this.vocabulary) : null
  }

  private tts(): TextToSpeech | string {
    if (this.stubSpeech) return new StubTts()
    const tools = this.tools()
    if (!tools.say) return 'no text-to-speech engine on this machine (macOS say)'
    if (!tools.ffmpeg) return 'ffmpeg is not installed (brew install ffmpeg)'
    const set = this.settings()
    return new MacSay(tools.say, tools.ffmpeg, { en: set.voiceEn, hi: set.voiceHi }, this.tmpDir)
  }

  async status() {
    const tools = this.tools(true)
    const set = this.settings()
    const modelPath = resolve(set.whisperModel)
    const stt = this.stt(false)
    const tts = this.tts()
    const voices = tools.say ? (await listSayVoices(tools.say)).filter((v) => /^(en|hi)_/.test(v.locale)) : []
    const stored = this.agent.store.sql.get<{ n: number; bytes: number }>('select count(*) n, coalesce(sum(bytes), 0) bytes from media where deleted_at is null')
    return {
      settings: set,
      tools,
      model: { path: set.whisperModel, found: existsSync(modelPath), bytes: existsSync(modelPath) ? statSync(modelPath).size : 0 },
      stt: typeof stt === 'string' ? { ok: false, detail: stt } : { ok: true, detail: stt.name },
      tts: typeof tts === 'string' ? { ok: false, detail: tts } : { ok: true, detail: tts.name },
      voices,
      stored: { files: stored?.n ?? 0, bytes: stored?.bytes ?? 0 },
    }
  }

  // ------------------------------------------------------------------ media files (local copies)

  private saveMedia(bytes: Buffer, mime: string, ext: string, ref: { conversationId: string | null; messageId: string | null; dir: 'in' | 'out' | 'preview' }, durationMs: number | null) {
    const id = uid('aud')
    const path = join(this.mediaDir, `${id}.${ext}`)
    this.agent.store.sql.run(
      'insert into media(id, conversation_id, message_id, dir, path, mime, bytes, duration_ms, created_at, deleted_at) values(?,?,?,?,?,?,?,?,?,null)',
      id,
      ref.conversationId,
      ref.messageId,
      ref.dir,
      path,
      mime,
      bytes.length,
      durationMs,
      Date.now(),
    )
    writeFileSync(path, bytes)
    return { id, path }
  }

  /** A stored recording, if it hasn't been deleted by the retention sweep. */
  mediaFile(id: string): { path: string; mime: string } | undefined {
    const m = this.agent.store.sql.get<{ path: string; mime: string; deleted_at: number | null }>('select path, mime, deleted_at from media where id=?', id)
    return m && !m.deleted_at && existsSync(m.path) ? { path: m.path, mime: m.mime } : undefined
  }

  mediaState(id: string): 'available' | 'deleted' | 'missing' {
    const m = this.agent.store.sql.get<{ deleted_at: number | null }>('select deleted_at from media where id=?', id)
    return !m ? 'missing' : m.deleted_at ? 'deleted' : 'available'
  }

  /** Deletes raw audio older than the retention window (transcripts stay), plus files nothing points to. */
  sweep() {
    const set = this.settings()
    const sql = this.agent.store.sql
    const old = sql.all<{ id: string; path: string }>('select id, path from media where deleted_at is null and created_at < ?', Date.now() - set.retentionHours * 3_600_000)
    for (const m of old) {
      rmSync(m.path, { force: true })
      sql.run('update media set deleted_at=? where id=?', Date.now(), m.id)
    }
    const known = new Set(sql.all<{ path: string }>('select path from media where deleted_at is null').map((r) => r.path))
    let orphans = 0
    for (const dir of [this.mediaDir, this.tmpDir]) {
      if (!existsSync(dir)) continue
      for (const f of readdirSync(dir)) {
        const p = join(dir, f)
        if (known.has(p)) continue
        const st = statSync(p)
        if (st.isFile() && Date.now() - st.mtimeMs > (dir === this.tmpDir ? 10 * 60_000 : 60_000)) {
          rmSync(p, { force: true })
          orphans++
        }
      }
    }
    if (old.length || orphans) {
      this.agent.bus.log({
        kind: 'agent',
        lane: '-',
        title: `Deleted ${old.length + orphans} voice recording(s)`,
        detail: `${old.length} older than ${set.retentionHours} h${orphans ? `, ${orphans} no longer referenced` : ''}; transcripts kept`,
      })
      this.agent.bus.change('conversations')
    }
  }

  // ------------------------------------------------------------------ inbound

  /**
   * Turns an inbound voice note into text. Updates the stored message as it goes (transcribing → transcript),
   * so the inbox shows progress. On failure returns the reply the bot should send.
   */
  async receive(channelId: string, conversationId: string, messageId: string, audio: { id?: string; mime_type?: string; voice?: boolean }): Promise<ReceiveResult> {
    const { store, bus } = this.agent
    const live = this.agent.channels.get(channelId)?.mode === 'live'
    const lang = this.agent.convLang(conversationId)
    const set = this.settings()
    const payload: Record<string, unknown> = { voice: audio.voice !== false, state: 'transcribing' }
    const update = (text: string) => {
      store.setMessageContent(messageId, text, payload)
      bus.change('conversations', { id: conversationId })
    }
    const fail = (reason: keyof typeof FAIL_TITLE, detail: string, reply: string): ReceiveResult => {
      Object.assign(payload, { state: reason, error: detail })
      update('')
      bus.log({ kind: 'agent', lane: 'A', live, title: FAIL_TITLE[reason], detail })
      return { ok: false, reason, detail, reply }
    }

    if (!audio.id) return fail('failed', 'the webhook carried no media id', t(lang, 'couldntHear'))
    const client = this.agent.client(channelId)
    const info = await client.mediaInfo(audio.id)
    if (!info.ok || !info.json?.url) return fail('failed', `media lookup failed: ${info.error?.message ?? 'no URL returned'}`, t(lang, 'couldntHear'))
    if (Number(info.json.file_size) > META_MAX_BYTES) return fail('too_long', `${info.json.file_size} bytes is over Meta's 16 MB limit`, t(lang, 'tooLong', { seconds: set.maxSeconds }))
    // Meta's download URL expires after 5 minutes, so fetch it straight away.
    const dl = await client.downloadMedia(String(info.json.url))
    if (!dl.ok) return fail('failed', dl.error, t(lang, 'couldntHear'))

    const mime = String(info.json.mime_type ?? audio.mime_type ?? dl.mime)
    const ext = /ogg|opus/.test(mime) ? 'ogg' : /mp4|m4a/.test(mime) ? 'm4a' : /mpeg|mp3/.test(mime) ? 'mp3' : /amr/.test(mime) ? 'amr' : /aac/.test(mime) ? 'aac' : 'bin'
    let seconds = inspectOggOpus(dl.bytes)?.durationSec ?? null
    const media = this.saveMedia(dl.bytes, mime, ext, { conversationId, messageId, dir: 'in' }, null)
    const tools = this.tools()
    if (seconds === null && tools.ffprobe) seconds = await probeDuration(tools.ffprobe, media.path)
    if (seconds !== null) store.sql.run('update media set duration_ms=? where id=?', Math.round(seconds * 1000), media.id)
    Object.assign(payload, { media: media.id, seconds: seconds === null ? null : round1(seconds) })
    if (seconds !== null && seconds > set.maxSeconds) return fail('too_long', `${round1(seconds)} s is over the ${set.maxSeconds} s limit`, t(lang, 'tooLong', { seconds: set.maxSeconds }))
    update('')

    const engine = this.stt(!live)
    if (typeof engine === 'string') return fail('unavailable', engine, t(lang, 'cantListen'))
    let tr
    try {
      // One transcription at a time: they share one GPU, and the server answers one request at a time anyway.
      tr = await this.sttQueue.run('stt', async () => {
        try {
          return await engine.transcribe({ file: media.path, mediaId: audio.id! })
        } catch (e) {
          const cli = engine instanceof WhisperServer ? this.cli() : null
          if (!cli) throw e
          bus.log({ kind: 'agent', lane: 'A', live, title: 'Whisper server unavailable: used the CLI', detail: (e as Error).message })
          return cli.transcribe({ file: media.path, mediaId: audio.id! })
        }
      })
    } catch (e) {
      return fail('failed', `${engine.name}: ${(e as Error).message}`, t(lang, 'couldntHear'))
    }
    if (!tr.text) return fail('empty', `${tr.engine}: no speech found`, t(lang, 'couldntHear'))

    const spoken: Lang = tr.language === 'hi' || hasDevanagari(tr.text) ? 'hi' : 'en'
    Object.assign(payload, { state: 'ok', lang: spoken, language: tr.language, engine: tr.engine, sttMs: tr.ms })
    update(tr.text)
    bus.log({
      kind: 'agent',
      lane: 'A',
      live,
      title: `Voice note transcribed (${spoken === 'hi' ? 'Hindi' : tr.language === 'en' || !tr.language ? 'English' : tr.language})`,
      detail: `${seconds === null ? '?' : round1(seconds)} s of audio · ${tr.engine}${tr.ms ? ` in ${(tr.ms / 1000).toFixed(1)} s` : ''}`,
    })
    return { ok: true, text: tr.text, lang: spoken, seconds }
  }

  // ------------------------------------------------------------------ outbound

  /** Should the bot answer this person out loud? */
  wantsVoice(channelId: string, personId: string): boolean {
    const set = this.settings()
    if (set.replies === 'never' || typeof this.tts() === 'string') return false
    if (set.replies === 'always') return true
    const conv = this.agent.store.sql.get<{ id: string }>("select id from conversations where channel_id=? and kind='dm' and person_id=? limit 1", channelId, personId)
    if (!conv) return false
    // Button taps don't switch voice mode off; typing a message does.
    const last = this.agent.store.sql.get<{ type: string }>(
      "select type from messages where conversation_id=? and dir='in' and type not in ('interactive', 'button') order by at desc, rowid desc limit 1",
      conv.id,
    )
    return last?.type === 'audio'
  }

  /** Text → mono Ogg/Opus bytes with the configured voice for the language. */
  async synthesize(text: string, lang: Lang): Promise<Buffer> {
    const engine = this.tts()
    if (typeof engine === 'string') throw new Error(engine)
    const out = join(this.tmpDir, `speech-${uid('t')}.ogg`)
    try {
      await engine.speak(text.slice(0, 1500), lang, out)
      return await readFile(out)
    } finally {
      await rm(out, { force: true })
    }
  }

  /** For the Settings page: speak a sample and keep it like any other recording. */
  async preview(text: string, lang: Lang) {
    const bytes = await this.synthesize(text, lang)
    const info = inspectOggOpus(bytes)
    return this.saveMedia(bytes, 'audio/ogg', 'ogg', { conversationId: null, messageId: null, dir: 'preview' }, info ? Math.round(info.durationSec * 1000) : null).id
  }

  /** Speaks `text` and sends it as a WhatsApp voice note. Returns ok: false (and sends nothing) on any failure. */
  async speak(channelId: string, personId: string, text: string, lang?: Lang): Promise<{ ok: boolean; message?: MessageRow; error?: string }> {
    const { bus } = this.agent
    const live = this.agent.channels.get(channelId)?.mode === 'live'
    const l: Lang = lang ?? (hasDevanagari(text) ? 'hi' : 'en')
    const failed = (error: string) => {
      bus.log({ kind: 'agent', lane: 'A', live, title: 'Voice reply failed: sending text instead', detail: error })
      return { ok: false, error }
    }
    const sql = this.agent.store.sql
    const fixed = this.staticLines.has(text.trim())
    let bytes: Buffer
    let key: string | null = null
    try {
      // Fixed lines come from the cache (spoken at startup); anything personal is spoken fresh and not kept.
      if (fixed) ({ key, bytes } = await this.cachedSpeech(text.trim(), l))
      else bytes = await this.synthesize(text, l)
    } catch (e) {
      return failed(`text-to-speech: ${(e as Error).message}`)
    }
    // Meta: voice notes must be Ogg/Opus, mono. Check before uploading rather than find out on the phone.
    const info = inspectOggOpus(bytes)
    if (!info || info.channels !== 1) return failed('speech engine did not produce mono Ogg/Opus')
    const upload = async () => {
      const up = await this.agent.client(channelId).uploadMedia(bytes, 'audio/ogg', 'voice.ogg')
      if (!up.ok || !up.json?.id) return { error: `upload: ${up.error?.message ?? 'no media id returned'}` }
      if (key) sql.run('insert or replace into tts_media(key, channel_id, media_id, uploaded_at) values(?,?,?,?)', key, channelId, String(up.json.id), Date.now())
      return { id: String(up.json.id) }
    }
    // A fixed line already uploaded to this number is sent by its media id: no upload at all.
    const reused = key ? sql.get<{ media_id: string; uploaded_at: number }>('select media_id, uploaded_at from tts_media where key=? and channel_id=?', key, channelId) : undefined
    let mediaId = reused && Date.now() - reused.uploaded_at < MEDIA_REUSE_MS ? reused.media_id : null
    if (!mediaId) {
      const up = await upload()
      if ('error' in up) return failed(up.error ?? 'upload failed')
      mediaId = up.id
    }
    const conv = this.agent.dmConversation(channelId, personId)
    const media = this.saveMedia(bytes, 'audio/ogg', 'ogg', { conversationId: conv.id, messageId: null, dir: 'out' }, Math.round(info.durationSec * 1000))
    const record = { type: 'audio', text, payload: { voice: true, spoken: true, media: media.id, seconds: round1(info.durationSec), lang: l, cached: !!reused } }
    let res = await this.agent.sendDm(channelId, personId, (c, to) => c.sendAudio(to, mediaId!, true), record)
    if (!res.ok && reused) {
      // The reused media id expired or was deleted on Meta's side: upload again once and resend.
      sql.run('delete from tts_media where key=? and channel_id=?', key, channelId)
      if (res.message) sql.run('delete from messages where id=?', res.message.id)
      const up = await upload()
      if ('error' in up) return failed(up.error ?? 'upload failed')
      res = await this.agent.sendDm(channelId, personId, (c, to) => c.sendAudio(to, up.id, true), { ...record, payload: { ...record.payload, cached: false } })
    }
    if (res.message) this.agent.store.sql.run('update media set message_id=? where id=?', res.message.id, media.id)
    if (res.ok) bus.log({ kind: 'agent', lane: 'A', live, title: `Voice reply sent (${l === 'hi' ? 'Hindi' : 'English'}, ${round1(info.durationSec)} s)`, detail: text.slice(0, 120) })
    return res
  }
}
