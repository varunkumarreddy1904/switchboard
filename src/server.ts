import { existsSync } from 'node:fs'
import { createApp } from './app'

// Optional .env (PORT, HOST, PUBLIC_BASE_URL, ANTHROPIC_API_KEY, ANTHROPIC_MODEL).
if (existsSync('.env')) process.loadEnvFile('.env')

const demo = process.argv.includes('--demo')

const started = await createApp()
const url = started.base.replace('127.0.0.1', 'localhost')

console.log(`
  Switchboard · WhatsApp sandbox POC · PoC #12 EquipXchange onboarding
  ──────────────────────────────────────────────────────────────────────
  Console        ${started.serveWeb ? url : 'run `npm run build` (or `npm run dev` for Vite on :5173)'}
  HYKR app       ${started.appUrl ? started.appUrl.replace('127.0.0.1', 'localhost') : `${url}/app`}   (also at ${url}/app)
  Graph facade   ${url}/graph/v24.0/...   (stands in for https://graph.facebook.com)
  Webhook        ${url}/webhook/sbx-cloud
  Claude         ${started.agent.llm.engine === 'claude' ? `enabled (${started.agent.llm.provider === 'openrouter' ? 'via OpenRouter' : 'Anthropic'})` : 'offline engine (set ANTHROPIC_API_KEY or add a key in Settings)'}
${demo ? '\n  Demo: open the console → Simulator → "Run all scenes", or play the scripted chatter.\n' : ''}`)

const shutdown = async () => {
  await started.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
