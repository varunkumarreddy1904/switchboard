# Switchboard: WhatsApp sandbox POC

A local "fake WhatsApp" plus a WATI-style console that proves the two-number architecture from the research doc:

- **Lane A (official):** onboarding and small groups on the WhatsApp Cloud API.
- **Lane B (unofficial):** a separate member number reads existing large groups and Communities through a linked device (Baileys).
- **One agent** consumes both lanes.
- **PoC #12, EquipXchange by HYKR:** machine owners register their machines on the official number by text, taps, photos and voice notes, and a small owner app on port 5175 shows their progress. Switchboard is the WhatsApp layer; HYKR plugs in as its "brain". See [PoC #12](#poc-12-equipxchange-onboarding-on-whatsapp).

The agent code is the production code. To go live you change two things:

- the Graph base URL (a live Cloud API channel);
- the socket (a live Baileys channel).

You can do both from the **Live lab** page.

```
Browser: Switchboard console (inbox · contacts · templates · broadcasts · groups · AI · simulator · live lab)
                 │
┌──────────── sandbox ─────────────┐            ┌──────────────── agent ─────────────────┐
│ World: personas, groups,         │            │ CloudApiAdapter  /webhook/:channel      │
│ Community (in memory)            │            │   verify GET · HMAC on raw bytes ·      │
│ Graph facade  /graph/v24.0/* ────┼─ webhooks ►│   durable inbox · (field,id,status)     │
│   ◄── POST /messages, /groups ───┼── HTTP ────│   dedupe                                │
│ Fake WASocket (Baileys v7 types)─┼─ in-proc ─►│ LinkedRunner: same code for fake or     │
│ HYKR app  :5175 (also /app)      │            │   real Baileys socket · consent gate    │
└──────────────────────────────────┘            │ identity_links · onboarding · groups ·  │
                                                │ digests (Claude or offline) · SQLite    │
 Live: GRAPH → https://graph.facebook.com       └─────────────────────────────────────────┘
       SOCKET → baileys@7.0.0-rc14 (real number, read-only, ban risk)
```

## Quick start

```bash
npm install
npm run build      # builds the console into dist/web
npm start          # http://localhost:4000
```

Open http://localhost:4000. Then:

1. **Simulator → Run all.** Twenty-one scripted scenes drive the personas and assert what the agent did (12–21 are PoC #12).
2. **Simulator → Tools → Play chatter.** Before you play it, record admin consent on **Groups**; without consent every message is dropped. The chatter is 40 events across a 300-member group and a Community.
3. **Team inbox:** the conversations. **AI agent:** digests and "ask the group". **Event log:** every webhook, Graph call and socket event, with raw JSON and signatures.
4. **HYKR app** at http://localhost:5175 (also http://localhost:4000/app): the owner's side of PoC #12. Sign in with "Continue on WhatsApp" or a code, then watch the registration fill in.
5. **HYKR · PoC #12** in the console menu: **Owners**, **Verification** (the desk) and **Funnel & speed**.

For development with hot reload, run `npm run dev`: Vite on :5173 proxies to the server on :4000.

Optional `.env` settings (see `.env.example`):

- `ANTHROPIC_API_KEY`: switches digests, Q&A and support replies to Claude (default model `claude-opus-5-5`). You can also set it on the Settings page.
  - **OpenRouter instead:** an OpenRouter key (`sk-or-…`) in the same field works too. Calls go to OpenRouter's Claude endpoint (`https://openrouter.ai/api`) with the same SDK, and model ids are translated (`claude-haiku-5-5` → `anthropic/claude-haiku-5.5`). OpenRouter rejects Anthropic's server-side refusal fallbacks (`fallbacks`), so they are left out there.
- `PUBLIC_BASE_URL`: your tunnel URL, for live webhooks and magic links.
- `APP_PORT`: port of the HYKR app (default 5175).

## PoC #12: EquipXchange onboarding on WhatsApp

This is built from the HYKR Pilot Product Design Session Kit and the team review PoC pack. It is **English first**. Payments, Aadhaar/eSign and WhatsApp group reading are out of scope for now.

The code is split in two:
- `src/hykr/` is the brain;
- Switchboard (`src/agent/`) carries the WhatsApp traffic and hands each incoming message to `agent.brain`.

### What the owner does

Everything happens in one WhatsApp chat, one question at a time. Every answer can be a tap, typed text or a voice note. Photos are sent with the camera.

1. **Consent C1 (basic profile).** Then the owner gives:
   - their name (the bot reads it back);
   - their village;
   - whether they drive the machine themselves.
2. **Consent C2 (machine papers).** If they say no, the profile is kept and the listing stays a draft. Sending **PAPERS** later continues the same draft.
3. **Machine.** First the type: Backhoe loader, Excavator, Breaker, Tipper or Other. Then photos of:
   - the machine;
   - the RC;
   - the invoice;
   - the insurance;
   - the PIN plate;
   - the hour meter.

   Any paper can be skipped by saying "I don't have it".
4. **Location.** A WhatsApp location pin or a typed place. Then an optional walkaround video in which the owner says the day's code word.
5. **Read-back.** The bot reads back what the photos say: make, model, year, registration, PIN, insurance end date and hour meter. The owner can fix each one. Flags are raised for:
   - a wrong or blurry photo;
   - expired insurance;
   - an RC in someone else's name (the bot then asks the relationship and for proof).
6. **Rates and terms:**
   - lowest rate per hour (read back when spoken);
   - rate per day;
   - who pays for diesel;
   - how far the machine travels.
7. **Summary, then Submit.** After that the owner can:
   - add another machine;
   - add a manager, who registers machines for the owner from their own number;
   - finish.

**Commands at any point:**
- **HELP**;
- **STATUS**;
- **PAPERS**;
- **talk to a person**: hands the chat to the Ops desk in the Team inbox;
- **STOP**: withdraws consent and pauses the owner's machines;
- **START**: asks for consent again, then resumes.

**Questions and breaks:**
- A question asked mid-flow ("what is the fee?") is answered from the business profile in `src/hykr/profile.ts`. The bot then asks the current step again.
- If the owner goes quiet, the bot nudges once after 30 minutes. Once the 24-hour window has closed, it uses the `continue_registration` template instead.
- An owner who comes back more than 2 hours later gets "welcome back" and the step where they stopped.

**Photos are read in the background**, so the next question is not delayed:
- **Live:** Claude vision reads them.
- **Sandbox:** each fixture carries its expected reading. **Settings → EquipXchange onboarding → Read simulator photos with Claude too** switches to real reading.
- **Storage:** evidence is saved in `data/evidence/` with a SHA-256.

**The desk.** The Verification page shows each submitted machine with its photos and flags. The desk can:
- **Approve**: the machine goes Live and the owner is told;
- **Ask for one more thing**;
- **Reject**.

Inside the 24-hour window the owner gets a text. Outside it they get the `machine_update` template.

**Mitras** are field partners, added on the Owners page. They get a menu to register an owner from a paper form. The owner then confirms on their own WhatsApp with the `owner_confirm` template.

**Data** follows the shared kit (§7):
- **IDs:** `P-`, `M-`, `E-` and `C-` (people, machines, evidence, consents);
- **phones:** E.164;
- **money:** stored in paise;
- **consents:** C1 and C2 with a wording version;
- **events:** every step is logged in `hx_events` in the kit's envelope, tagged with `RULES_VERSION`.

All tables start with `hx_` in `data/agent.db`.

### Signing in to the app (and whether OTP is needed)

The HYKR app has no password. There are two ways to sign in, and Switchboard handles both:

- **Continue on WhatsApp (recommended).** The app shows a QR code or `wa.me` link that opens WhatsApp with the message `START <signed one-time token>`.
  - When that message arrives, the app signs in by itself.
  - The message proves the person holds the number, so **no OTP is needed**.
  - The same message also starts registration.
- **Sign in with a code (OTP).** The owner types their number.
  - Switchboard sends a 6-digit code with a WhatsApp **authentication template** (copy-code button) and checks it.
  - The code is valid for 10 minutes and allows 5 tries.
  - A code that cannot be delivered shows Meta's error instead of waiting forever.
  - On a live number this needs an approved authentication template named `otp_login` (the name can be changed on the channel).

Once signed in, the app shows:
- the next step;
- the profile;
- each machine with its photos, read details, status and flags;
- what the owner agreed to.

It refreshes every 3 seconds. Only the owner and their managers can see the owner's photos.

### Trying it in the sandbox

- **Simulator.** Pick an owner persona: Ravi, Srinivas, Mahesh, Anil, Venkat, Kiran, or Lakshmi (the Mitra). The composer has these buttons:
  - camera: a picker of synthetic machines and papers, all stamped TEST;
  - location pin;
  - contact card;
  - mic.
- **Scenes 12–21** replay the kit's stories S01–S07, plus the desk, reply speed and STOP/START.
- **Regenerating the synthetic papers:** run `node scripts/make-fixtures.mjs`. It needs Google Chrome and writes to `fixtures/synthetic/`.

### Speed (English, this Mac)

Each time is measured from Meta's webhook reaching Switchboard to Meta accepting the first reply. The **Funnel & speed** page shows these numbers live.

| Owner sends | Median | 95th % | Target |
|---|---|---|---|
| Tap | 0.01 s | 0.03 s | under 1 s |
| Text | 0.01 s | 0.01 s | under 2 s |
| Photo | 0.01 s | 0.03 s | under 2 s |
| Voice note | 2.2 s | 3.7 s | under 3 s |

- **Voice note** time includes downloading, Whisper small.en on a warm local server (about 0.5–0.9 s), and speaking and uploading the voice reply.
- **On a live number**, add Meta's own send and delivery time.

### Connected to the EquipXchange app

The EquipXchange app (`~/Desktop/equipxchange`) is the system of record for owners, machines and bookings. When `EQX_API_URL` and `EQX_BRIDGE_SECRET` are set, Switchboard carries its WhatsApp traffic (code in `src/bridge/eqx.ts`).

**From the app to WhatsApp:**
- **Job offers** to owners, with *Yes* and *No* buttons.
- **Prices** to contractors, with one button per option and *No thanks*.
- **Pay links** that open without signing in.
- **Confirmations, job cards and the desk's decisions.**
- **Sign-in codes**, sent with the `otp_login` template.

**From WhatsApp to the app:**
- **Button taps** whose id starts with `eqx:` go to the app. Its answer comes back as a text.
- **Finished registrations:** when an owner submits a machine, the owner and the machine go to the app as *Pending*. The app pulls the photos and papers and checks each file's SHA-256. Anything onboarding noticed goes along as a note for the desk, for example an RC in a relative's name.
- **Machine status:** the app's desk decides, and Switchboard records the same status, so **STATUS** on WhatsApp agrees with the app.
- **Decisions only in the app:** for a machine sent to the app, the console's Verification page shows "Checked in EquipXchange as M-…" in place of Approve, Ask and Reject, and the console API refuses them (409). The page links to the app's desk (`EQX_WEB_URL`, default `http://localhost:8081`).
- **Ask for more, answered on WhatsApp:** when the app's desk asks for a paper, it sends the message itself and tells Switchboard what it asked for. The owner's next photo is kept as that paper (for "who drives it", their next contact or number), and the machine goes to the app again; the app keeps only what is new.
- **Who drives it:** an owner who does not drive is asked for the driver during registration (skippable; "add driver" any time). The driver travels with the machine to the app, which makes them its usual operator. Drivers are kept apart from managers.

**Rules:**
- **Signing:** every call is signed both ways. The signature is an HMAC-SHA256 of `<timestamp>.<body>` with the shared secret. Calls older than five minutes are refused, and so is a repeated message id.
- **The 24-hour window:** outside it, the `eqx_update` template goes out, and the full message waits until the person replies or taps *See details*. Only one template goes out per batch.
- **Which messages go out:** only messages someone must act on, and milestones. The rest stays in the app.
- **Where messages go:** they use the sandbox number unless `EQX_CHANNEL_ID` names a live channel. The `/bridge` paths are local only; the tunnel does not expose them.

**People who use only WhatsApp:** contractors and owners can do everything in this chat (EquipXchange's `docs/whatsapp.md` has the conversations).
- **Who handles a message:** someone mid-registration stays with the registration chat; other messages go to the app first, and what it doesn't take comes back here.
- **New numbers on the live line:** they are asked *Hire a machine* or *List my machine*.
- **Which number replies go out on:** app messages reach people on the number they wrote to (live for real phones, sandbox for personas).
- **Photos:** photos for the app are kept in `data/eqx-media`, with the hour meter read from them.
- **Pay page:** the test pay page is served publicly at `/pay/…` (the only addition to the tunnel's allow-list).

**Trying it:** start the app's API (port 3000) and Switchboard with matching secrets. Ravi (+91 90000 00001) is an owner in both. Suresh (…040) is a contractor and Prakash (…031) is Ravi's driver; both are sandbox personas. Book in the app as Suresh, then answer as Ravi in the simulator.

### Going live with a real number

1. Connect the number in **Live lab** as described below.
2. Submit these templates in WhatsApp Manager, all in English (`en_US`):

| Template | Category | Used for |
|---|---|---|
| `continue_registration` | Utility | Nudges an owner after the 24-hour window. Body has 1 parameter: name. One "Continue" button |
| `machine_update` | Utility | The desk's decision, after the window. Body has 2 parameters: name, machine. One "See update" button |
| `owner_confirm` | Utility | An owner confirms a Mitra's paper-form registration. Body has 2 parameters: name, Mitra. Two buttons: "Yes, that's right" / "No, it's wrong" |
| `otp_login` | Authentication | Sign in with a code, with a copy-code button |
| `eqx_update` | Utility | EquipXchange app messages after the window. Body has 2 parameters: name, what the update is about. One "See details" button |

The tunnel exposes only these paths:
- `/webhook/*`;
- `/app` and `/api/app` (the HYKR app);
- `/assets`.

The console and the desk stay on localhost.

## Using real numbers (Live lab)

### Official Cloud API number (safe)

1. Create a Meta developer app with the WhatsApp product, or use the test number Meta gives you.
2. Expose the server: `brew install cloudflared`, start the server (`npm start`), then run **`npm run tunnel`** in a second terminal. It starts a Cloudflare quick tunnel, saves its address as **Settings → Public URL**, and points Meta's webhook at it (for live channels that have their App secret). Through the tunnel only `/webhook/*` and the `/app` sign-up pages are reachable; the console stays localhost-only because it has no login.
   - **Why a script:** a quick tunnel is temporary. When the Mac sleeps or the network drops, Cloudflare deletes it ("Tunnel not found") and replies stop reaching the inbox. The script checks the tunnel every 30 s and replaces it, re-wiring the Public URL and Meta's webhook; Meta then delivers the messages it was holding.
   - **Sleep:** nothing works while the Mac sleeps. `npm run tunnel -- --awake` stops idle sleep while it runs; closing the lid on battery still sleeps the Mac.
3. Go to **Live lab → Connect Cloud API number**. Enter the phone number ID, the WABA ID, a System User token and the App secret. The verify token is generated if you leave it empty. You can save without the App secret to test sending, but incoming webhooks are refused (401) until you add it on the card; Meta retries them.
4. Press **Point Meta's webhook here** on the card (it needs the App secret). This replaces the App Dashboard step:
   - `GET /app` finds the token's app;
   - `POST /{WABA_ID}/subscribed_apps` subscribes it to the WhatsApp account;
   - `POST /{APP_ID}/subscriptions`, called with the app access token `app_id|app_secret`, sets the callback URL, the verify token and the fields `messages` and `message_template_status_update`. Meta then verifies the URL with a GET.

   Meta's reference says WhatsApp webhooks are set in the dashboard, but this call worked on a real app on 2026-11-09. If it stops working, set the URL in the dashboard under Webhooks → WhatsApp Business Account.
5. **After a tunnel restart** the URL changes. `npm run tunnel` handles this by itself; with a hand-started `cloudflared`, update **Settings → Public URL** and press the button again.
6. Click **Test connection**, then **Send hello_world** to your phone. Reply from your phone and the chat appears in the Team inbox, tagged LIVE. With the App secret set, Test connection also asks Meta (`debug_token`) when the token expires and shows it on the card.
   - **Token expiry:** the temporary token from WhatsApp → API Setup lasts about an hour. When it runs out, every send fails with `#190 Authentication Error` and the card turns to **Error**. Paste a new token in the card's box (or **Replace token**) and press **Save and test**. For demos, use a System User token set to never expire.
7. Onboarding:
   - **Path A:** the HYKR app's "Continue on WhatsApp" uses the live channel when you pick it under "Number".
   - **Path B (OTP):** needs your own approved copy-code authentication template; set its name on the channel.

The Groups API needs an Official Business Account, which test numbers are not. Lane A groups can only run in the sandbox until you have a verified OBA number.

### Linked member number (unofficial, ban risk)

**Live lab → Link a number** creates a real Baileys socket. You must tick an acknowledgement first.

- **Linking:** scan the QR from WhatsApp → Linked devices, or request a pairing code.
- **Groups:** they appear on **Groups**, each blocked until you record an admin's consent.
- **Read-only:** the agent never sends on this lane.
- **Auth state:** stored in `data/live-auth/<channel>`.
- **Which number:** use a throwaway number, never your onboarding number or your personal one.

## Voice notes

People can onboard and ask questions by WhatsApp voice note. The voice layer sits at the edges; onboarding and the bot still only see text.

```
voice note → download (Meta's URL expires in 5 min) → length check → Whisper on this Mac → transcript
           → spoken answers mapped to the same button ids a tap sends → existing onboarding / FAQ bot
reply text → macOS voice → mono Ogg/Opus → upload → sent with voice: true (links and buttons also go as text)
```

**Setup (once):**
1. Run `brew install whisper-cpp ffmpeg`.
2. Put a Whisper model in `models/whisper/`, from the whisper.cpp Hugging Face repo:
   - **`ggml-small.en-q5_1.bin`** (about 190 MB, English only) is the default, for speed.
   - `ggml-large-v3-turbo-q5_0.bin` (about 550 MB) is for Hindi and other languages later.

The server keeps `whisper-server` running warm on `127.0.0.1:8178` and falls back to the `whisper-cli` command if it is not there. **Settings → Voice notes** shows what is installed and lets you hear the voices.

**How it behaves:**
- **Replies:** the bot answers with a voice note when the person's last message was one; typing switches it back to text. A link (the sign-in link) is left out of the speech and sent as text; button questions are spoken with "You can say: …" and the buttons follow.
- **Understanding answers:** offline rules come first. They cover yes/no, options and numbers in digits or words ("nine hundred per hour", "seven thousand a day"), plus registration and PIN numbers. If the rules find nothing clear, the bot asks again. Claude answers only free questions. Mixed answers ("I don't agree") never count as consent.
- **Read-backs:** names and spoken rates are read back before saving ("I heard “Ravi Kumar”. Is that right?"), because speech-to-text gets them wrong most. A word list of machine terms (backhoe, Poclain, RC, PIN…) helps Whisper hear them.
- **Commands:** a short spoken "stop", "help" or "start" counts as the keyword. "How do I stop the digests?" is a question, not an unsubscribe.
- **Languages:** PoC #12 is English only for now. The voice layer still has the Hindi word rules and a Hindi voice (Lekha) for later; Hindi needs the multilingual model.
- **Limits:** notes over 120 s are politely refused (setting).
- **Speed:** on the warm server, small.en takes about 0.5–0.9 s per note. The large turbo model takes about 4–5 s.
- **Static lines:** fixed replies are synthesised once and cached. Their Meta media ids are reused for 25 days, so most voice replies skip the upload.
- **Sandbox:** the simulator's mic button speaks your words with the Mac's voice; the agent uses your words as the transcript, so scenes are exact. Tick "Run Whisper on simulator voice notes too" to exercise real Whisper.

**Privacy:** audio never leaves the Mac except to and from Meta. Only the transcript goes to Claude, with phone numbers and emails masked. **Raw recordings are deleted after 24 hours** (setting); transcripts stay in the inbox. The consent message says voice notes are turned into text, and a spoken consent's transcript is kept as the record. Recordings are served only to the local console.

## Demo scenes (also the end-to-end tests)

| # | Scene | What it proves |
|---|---|---|
| 1 | Continue on WhatsApp | The `wa.me` link carries a signed single-use nonce, and the app signs in when the message arrives. No OTP: the inbound message already proves the number |
| 2 | App-first onboarding | OTP belongs here: copy-code auth template, code typed into the app; undeliverable OTP surfaces as 131026 |
| 3 | Hidden-number user | Cloud knows a BSUID, the linked lane knows a LID; no API joins them, so they stay two records |
| 4 | 24-hour window | Free-form send returns 200, then a failed status 131047 arrives; the agent falls back to a template |
| 5 | Groups API | Async create (request_id → lifecycle webhook), invite template with `group_id`, the 8-participant cap |
| 6 | Official limits | No addressing app-created groups, no Communities API, no groups without OBA |
| 7 | Linked lane reach | Edits, deletes, reactions, view-once, CIPHERTEXT, admin-only announcements, late join, redaction |
| 8 | Consent gate | Messages are dropped (not stored) until an admin consent is recorded |
| 9 | Prompt injection | Group text is untrusted; the digest flags it and leaks no contact details |
| 10 | Webhook robustness | Every POST duplicated, statuses out of order, first two deliveries 500 → exactly-once processing |
| 11 | Ban | Member number gets 401 loggedOut and stops reconnecting; onboarding on the official number keeps working |
| 12 | PoC #12 S01 · voice only (O1) | Ravi registers a backhoe entirely by voice notes and photos; replies are voice notes |
| 13 | S02 · fleet owner + manager (O2) | Srinivas adds manager Kiran, who registers three more machines from his own number |
| 14 | S03 · no RC, no invoice (O3) | Owner told an in-person inspection is needed; make, model and year asked one by one; machine flagged `no_papers` for the desk |
| 15 | S04 · RC in father's name (O5) | The bot asks who "K. NARAYANA" is, records the family relationship and flags it; the machine is submitted, not rejected |
| 16 | S05 · says no to papers | The listing stays a draft and no C2 consent is stored; PAPERS later continues the same draft |
| 17 | S06 · back after two days | Reminder, then the `continue_registration` template outside the window; "welcome back" and resume |
| 18 | S07 · Mitra and paper form | Lakshmi registers Raju from a paper form; Raju confirms on his own WhatsApp (`owner_confirm`) |
| 19 | The desk | Ask for the insurance photo → owner sends it → back in the queue; approve → Live and KYC T1; reject → reason told; every decision is an event |
| 20 | Reply speed | Taps, text and photos answered within their targets |
| 21 | Talk to a person, STOP, START | Hand-over to the Ops desk; STOP withdraws consent and pauses machines; START asks again and resumes |

`npm test` runs them headless over real HTTP. It also runs unit tests for:
- signatures, tokens, redaction and dedupe;
- the voice layer (word rules, Ogg/Opus checks, ordering);
- the PoC #12 parsers (numbers, rates, registration and PIN numbers, places). `npm run typecheck` also proves the fake socket and a real Baileys `WASocket` satisfy the same contract (`src/shared/linkedSocket.ts`).

## Where the sandbox differs from production

| Area | Sandbox | Production |
|---|---|---|
| Wire protocol | Contract only: Graph JSON and the Baileys event surface | Real Cloud API; Signal-encrypted WhatsApp Web protocol |
| Error codes | 131047, 131026, 132000/132001, #100 subcode 33 match Meta's docs. 131215 (groups without OBA) and the 8-cap refusal are **sandbox codes** | Confirm against recorded webhooks (`fixtures/recorded/`) |
| Group create response | `{ request_id }`, then a lifecycle webhook | Sync body not documented by Meta; the agent also matches by subject |
| BSUID format and sending by BSUID | `US.<19 digits>`, accepted in `to` | Format and send field unverified |
| Template approval | APPROVED after 2.5 s | Minutes to days |
| Pricing | Labels on statuses (`pricing.category`, billable) | Real per-message pricing |
| Ban detection | A button | Unknown heuristics; anecdotally weeks |
| History sync | Backlog since last connect, as one history batch | Chunked, progress events, phone-dependent |
| Webhook retries | 6 attempts, up to 16 s backoff | Meta retries for up to 7 days |
| Media | Audio, images and documents: upload, `GET /{media-id}`, token-protected download. Also location pins and contact cards | All media types; download URLs expire after 5 minutes |
| Reading papers | Each test photo carries its expected reading, unless "Read simulator photos with Claude too" is on | Claude vision reads the photo |
| Flows, calls | Not simulated | Supported by the Cloud API (Flows need an encrypted data endpoint) |

## Project layout

```
src/
  shared/      bus (event log), sqlite wrapper, crypto (HMAC, signed tokens), ids, LinkedSocket contract
  sandbox/     seed (fictional personas/groups), world (rules), graph (Graph facade), webhooks (dispatcher),
               fakeSocket (Baileys-typed), chatter (40-step script), scenes (demo + tests), api (simulator controls)
  agent/       agent (hub), channels, cloudClient, cloud (webhook + processing), onboarding, identity, groups,
               linked (runner + real Baileys factory), llm (Claude + offline), redact, store, api (console),
               i18n (English + Hindi lines), voice/ (Whisper + macOS voices, word rules, Ogg checks, service),
               inbound (the Brain interface), timing (reply-speed stopwatch)
  hykr/        PoC #12 brain: brain (the conversation), copy (every bot line), profile (facts for questions),
               parse (answers), vision (reading papers), store (hx_* tables, kit IDs, events), api (desk + app)
  app.ts       composes everything in one process (console :4000, HYKR app :5175); server.ts starts it
web/src/       React console (pages/*, pages/Hykr.tsx for the desk) and hykr/ (the owner app, web/app.html)
scripts/       tunnel.mjs (npm run tunnel), make-fixtures.mjs (synthetic papers)
test/          unit + scene tests
```

## GitHub repos

- [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) (MIT), pinned at `7.0.0-rc14`. Runs the live linked lane, and its types define the fake socket.
- [devlikeapro/waha](https://github.com/devlikeapro/waha) (Apache-2.0): a REST + webhook bridge over several engines, and a drop-in alternative for lane B. It documents no Community endpoints.
- [tulir/whatsmeow](https://github.com/tulir/whatsmeow) (Go, MPL-2.0): a low-memory alternative engine.
- [evolution-foundation/evolution-api](https://github.com/evolution-foundation/evolution-api): an all-in-one server supporting both Baileys and the Cloud API.
- [mjarkk/whatsapp-dev](https://github.com/mjarkk/whatsapp-dev): prior art for a Cloud API mock (text only). It inspired the Graph facade.

## Safety and data

- **Raw webhook bodies:** stored only until processed, then nulled. The event log keeps raw payloads in memory only and strips them for live channels.
- **Before storage and before any LLM call:** group text has phones, emails and card numbers redacted. Sender labels that are really phone numbers are never sent to the model.
- **Where the AI can answer:** the 1:1 assistant only answers EquipXchange questions from the business profile (Meta's 2026 policy bars general-purpose assistants). The linked lane has no send path.
- **Refusals:** Claude calls use structured outputs and server-side refusal fallbacks (`fallbacks: "default"`; left out on OpenRouter).
- **Evidence photos:** stored in `data/evidence/` with a SHA-256. The app serves them only to the owner and their managers.
- **Secrets:** stored in plain text in `data/agent.db`. This is a local POC; use a secrets manager before deploying.
- **Fictional data:** personas use number ranges reserved for fiction. The PoC #12 owners follow the kit's synthetic test set, and every fixture paper is invented and stamped TEST. The UI deliberately does not copy WhatsApp's or WATI's look.

## Deviations from PLAN.md

- **One npm package instead of workspaces.** The sandbox/agent boundary is kept by folders. The agent only sees the sandbox through HTTP and the `LinkedSocket` contract.
- **No recorded Claude responses.** None could be recorded without a key, so the offline mode is a labelled heuristic engine. Add a key for real digests.
- **WhatsApp Flows are not implemented.** They were the stretch goal; onboarding uses buttons and lists.
- **Recorded live fixtures are not included.** `fixtures/recorded/` is the place for scrubbed webhooks once you run a live number.
