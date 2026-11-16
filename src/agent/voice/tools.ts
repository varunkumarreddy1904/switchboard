import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs a local program with arguments (never through a shell), with a timeout. */
export function run(cmd: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/** Finds a program on PATH, plus Homebrew's usual folders (the server may start without a login shell). */
export function which(name: string): string | null {
  const dirs = [...(process.env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin']
  for (const d of dirs) {
    if (!d) continue
    const p = join(d, name)
    if (existsSync(p)) return p
  }
  return null
}

export interface VoiceTools {
  ffmpeg: string | null
  ffprobe: string | null
  whisper: string | null
  whisperServer: string | null
  say: string | null
}

export const findTools = (): VoiceTools => ({
  ffmpeg: which('ffmpeg'),
  ffprobe: which('ffprobe'),
  whisper: which('whisper-cli'),
  whisperServer: which('whisper-server'),
  say: which('say'),
})

async function ffmpegOrThrow(ffmpeg: string, args: string[]) {
  const r = await run(ffmpeg, ['-loglevel', 'error', '-y', ...args], 60_000)
  if (r.code !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim().slice(-300) || `exit ${r.code}`}`)
}

/** Whisper wants 16 kHz mono 16-bit WAV. */
export const toWav16k = (ffmpeg: string, input: string, output: string) => ffmpegOrThrow(ffmpeg, ['-i', input, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output])

/**
 * WhatsApp voice notes: Ogg container, Opus codec, mono. 24 kbit/s keeps a minute of speech near 180 KB,
 * well under the 512 KB Meta mentions for the play icon.
 */
export const toVoiceOgg = (ffmpeg: string, input: string, output: string) =>
  ffmpegOrThrow(ffmpeg, ['-i', input, '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', output])

/** Cuts a recording into 16 kHz mono WAV pieces of `seconds` each: `<base>-000.wav`, `<base>-001.wav`, … */
export const splitWav = (ffmpeg: string, input: string, base: string, seconds: number) =>
  ffmpegOrThrow(ffmpeg, ['-i', input, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'segment', '-segment_time', String(seconds), `${base}-%03d.wav`])

/** Duration of any audio file ffprobe understands (used for non-Opus uploads such as forwarded .m4a files). */
export async function probeDuration(ffprobe: string, file: string): Promise<number | null> {
  const r = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 20_000)
  const n = Number(r.stdout.trim())
  return r.code === 0 && Number.isFinite(n) ? n : null
}
