# Messaging Sandbox — WhatsApp Simulator POC: Implementation Plan

Status: approved with defaults on 2026-11-09 and implemented. See README.md → "Deviations from PLAN.md".
Source goal: research doc "WhatsApp API for Group-Reading Agents & User Onboarding"
(https://claude.ai/artifact/HF5yd2okNhjCATgkam7hTP).

## 1. Goal

Prove the doc's recommended architecture end to end on a laptop, with no real numbers and no ban risk:

- **Lane A (official):** onboard users to an app over the WhatsApp Cloud API, plus small Groups API groups (8 max, OBA only).
- **Lane B (unofficial):** a separate "member number" reads existing large groups and Communities through a linked-device library (Baileys).
- **One agent** consumes both lanes.

The agent code must be the code that runs in production. Only two settings change to go live:

- `GRAPH_BASE_URL` → `https://graph.facebook.com`
- `LINKED_SOURCE` → `baileys`

The sandbox is a **contract simulator**: it copies the Cloud API's HTTP and webhook formats and the Baileys event and type surface. It does not emulate WhatsApp's encrypted wire protocol.

## 2. Architecture

```
Browser: Messaging Sandbox UI — persona phones · event log · app stub · agent panel
                 │
┌────────────── sandbox ───────────────┐          ┌──────────────── agent ─────────────────┐
│ World model (per-observer views)     │          │ CloudApiAdapter: verify GET, HMAC on   │
│ Cloud API facade ── signed webhook ──┼── HTTP ─►│   raw bytes, durable inbox, dedupe     │
│   ◄─ POST /messages, /groups ────────┼◄─ HTTP ──│ BaileysAdapter: ONE implementation for │
│ Fake WASocket (typed vs baileys) ────┼ in-proc ►│   the fake socket or a real socket     │
│ App stub: sign-up page, magic link   │          │ identity_links · onboarding · groups   │
└──────────────────────────────────────┘          │ digest/Q&A (Claude) · SQLite store     │
                                                  └────────────────────────────────────────┘
Live swaps: GRAPH_BASE_URL=https://graph.facebook.com (Meta test number via tunnel)
            LINKED_SOURCE=baileys + I_ACCEPT_BAN_RISK=1 (throwaway number, read-only)
```

How it runs:

- `npm run demo` starts the sandbox and the agent in one Node process.
- The Cloud lane still goes over real localhost HTTP, so signatures, raw bodies and retries all behave as they will live.
- The linked lane hands the agent a fake socket that satisfies `Pick<WASocket, …>` from the `baileys` type definitions. A Baileys upgrade that changes the surface breaks compilation, so drift shows up early.

## 3. GitHub repos

| Repo | Role |
|---|---|
| [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys) (MIT, `baileys@7.0.0-rc14`, pinned exactly) | Live linked-device client; its `BaileysEventMap` / `WASocket` / `GroupMetadata` types define the fake socket |
| [devlikeapro/waha](https://github.com/devlikeapro/waha) (Apache-2.0, 2026.10.1) | Documented alternative bridge (REST + webhooks, Docker; Plus is now free). No Community endpoints, so not the default |
| [mjarkk/whatsapp-dev](https://github.com/mjarkk/whatsapp-dev) (MIT) | Prior art for the "Maildev for WhatsApp" pattern; not reused (text only, no groups or statuses) |
| [tulir/whatsmeow](https://github.com/tulir/whatsmeow), [evolution-foundation/evolution-api](https://github.com/evolution-foundation/evolution-api) | Alternatives, one line each in the README |

## 4. Stack

- Node 26, TypeScript, ESM, npm workspaces.
- Fastify 5 with a buffer body parser for HMAC.
- zod: loose (passthrough) for Meta input, strict for sandbox output.
- `node:sqlite` behind a small repository interface, so it can be swapped for better-sqlite3. It runs on Node 26 locally without flags.
- vitest for tests.
- React + Vite for the UI.
- `@anthropic-ai/sdk` for Claude, with the model configurable. Without a key it runs in replay mode: recorded responses keyed by prompt hash, labelled "replay" in the UI.

## 5. Repo layout

```
whatapp/
  packages/
    contracts/   zod schemas: Cloud webhook envelope, send bodies, InboundEvent
    sandbox/     world model, Cloud facade, fake WASocket, scenarios runner, app stub, UI
    agent/       adapters/{cloud,baileys}, inbox, identity, onboarding, groups, llm, store
  fixtures/
    recorded/    scrubbed real webhooks (verified; take priority)
    docs/        hand-copied from Meta docs (labelled unverified)
  scenarios/     scripted demo scenes (JSON)
  README.md      incl. "Where the sandbox lies" table
```

## 6. Sandbox

### 6.1 World model with per-observer views

Each facade exposes only what that observer would really see:

- **Cloud facade:** a business-scoped `user_id` (BSUID) per person. `wa_id`/`from` are omitted for hidden-number personas.
- **Fake socket:** `@lid` participants. `participantAlt` and `lidPnMappings` are filled only when the scenario allows it.
- **Never:** a field that joins BSUID to LID. No such field exists in reality.

Communities:

- The announcement group is admin-post only.
- Chatter happens in linked sub-groups.
- The member number sees a sub-group's messages only from when it joined.

### 6.2 Cloud API facade (`/:ver/...`)

Messages:

- `POST /:phone_number_id/messages` handles text, template and interactive (buttons and lists), plus `recipient_type: "group"`.
  - Template sends check that the template is APPROVED.
  - Authentication templates are copy-code, with the code in both the body parameter and the URL button parameter.
- Interactive limits are enforced. Exact values are to be confirmed from Meta docs in P0.

Groups:

- `POST /:phone_number_id/groups` is **async**: it returns an acknowledgement, and the result arrives as a `group_lifecycle_update` webhook (`group_create`).
- `GET /:group_id/invite_link`; invite template with a `{type:"group_id"}` parameter.
- `GET /:group_id?fields=participants`, `DELETE /:group_id/participants`.

Rules:

- OBA is required for groups.
- 8 participants maximum, including the business.
- Only API-created groups can be addressed.
- No Communities.
- Free-form text outside the 24h window returns **200 + wamid**, then a `statuses[].status:"failed"` webhook with the error. Delivery errors are never synchronous. Codes come from Meta's error table and are confirmed in P0.

Webhooks:

- Meta envelope: `object → entry[] → changes[{field, value}]`.
- `value` carries `metadata`, `contacts[]` (`profile.name`, `wa_id?`, `user_id`), `messages[]` (`from?`, `from_user_id`, `group_id?`, …) and `statuses[]`. Group statuses carry `recipient_type: group`.
- Group fields: `group_lifecycle_update`, `group_participants_update`.
- Each POST is signed `X-Hub-Signature-256: sha256=<HMAC(app_secret, raw body)>`.
- Delivery is realistic: several entries and messages per POST, statuses out of order, duplicates, and retries when the agent returns 5xx.
- On boot the sandbox performs the GET verify handshake against the agent.

### 6.3 Fake WASocket (linked lane)

Implements the agent's `Pick<WASocket, 'ev' | 'groupMetadata' | 'groupFetchAllParticipating' | 'communityFetchAllParticipating' | 'communityFetchLinkedGroups' | 'signalRepository'>`.

Events emitted:

- `connection.update`: QR, then 515 `restartRequired` after pairing, then open, and close with `loggedOut` on a ban.
- `messages.upsert` with both `notify` and `append`.
- `messaging-history.set`, `messaging-history.status`, `lid-mapping.update`.
- `groups.update`, `group-participants.update`.

Message zoo:

- text and extendedText
- ephemeral and view-once wrappers
- edit and revoke (`protocolMessage`)
- reaction
- join/leave stubs
- CIPHERTEXT stub

Group metadata carries `isCommunity`, `isCommunityAnnounce`, `linkedParent` and `addressingMode`.

### 6.4 App stub

A plain page standing in for "your app":

- Path A: a "Continue on WhatsApp" button + QR code → `wa.me/<num>?text=START%20<signed nonce>`.
- Path B: a "verify phone" form for the OTP.
- A magic-link landing page.

### 6.5 UI

Generic look and name ("Messaging Sandbox"): no WhatsApp green, no tick icons, no logo.

- Left: personas. Click one to act as that phone.
- Centre: the selected chat.
- Right: event log of raw HTTP, webhook JSON and signature, agent response code, and socket events, with policy notes (e.g. "auth template = billed"). The raw payload stays in memory only and is disabled in live mode.
- Agent panel: digests and Q&A.

## 7. Agent

### 7.1 Ingestion

- **CloudApiAdapter:**
  - verify GET;
  - HMAC with `timingSafeEqual` over the exact raw bytes;
  - write to a durable SQLite inbox, **then** return 200, then process asynchronously;
  - dedupe key = `(field, id, status)`, so statuses that share a wamid survive.
- **BaileysAdapter:**
  - `normalizeMessageContent` + `getContentType`;
  - `cachedGroupMetadata`;
  - `markOnlineOnConnect:false`;
  - reconnect unless `loggedOut`;
  - **read-only**: never sends. Note that it still emits delivery receipts.
- Both adapters produce one `InboundEvent`: `{id, lane, chat{kind: dm|group|community_sub|community_announce, id, communityId?}, sender{bsuid?, waId?, lid?, pn?, name?}, ts, type, text?, reply?}`. There is no raw field in storage.

### 7.2 Identity

`identity_links(person_id, kind: pn|bsuid|lid|wa_id, value, source: wa_inbound|otp|participantAlt|lidPnMapping|lid-mapping.update)`.

- The phone number is the only bridge between the lanes, and it is often missing.
- An unlinked LID stays a separate pseudonymous person.
- Opt-out (`STOP` / admin removal) applies per lane and per group. The README documents the gap that a STOP on the official number can't reach an unlinked LID.

### 7.3 Onboarding (deterministic state machine, no LLM)

- **Path A, WhatsApp-first:**
  1. The user's START message carries a signed nonce (10-minute TTL, single use) that ties the sender to an app session. **No OTP**: the inbound message already proves who holds the account.
  2. Consent buttons.
  3. Details via interactive list and buttons.
  4. Account created.
  5. Magic link → app stub landing.
- **Path B, app-first:**
  1. The user types a phone number into the app stub.
  2. The agent sends a copy-code authentication template (6 digits, 10-minute expiry, 5 attempts).
  3. The user types the code **into the app page**.
  4. The phone is linked (`source: otp`).
- WhatsApp Flows: stretch goal only. If added, static Flow JSON + `flow_token` → `nfm_reply.response_json`, with no data endpoint.

### 7.4 Group reader

- **Lane A:** the agent creates the group (async, matched to its lifecycle webhook) and invites by template or link. Messages arrive with `group_id`. It replies only on @mention, and only on app topics (Meta's 2026 policy against general-purpose assistants).
- **Lane B:** ingestion of a group **refuses to run** without a consent record (group admin, timestamp, scope) captured out of band in the agent panel.
- **Pipeline:** PII redaction (phones, emails, card-like numbers) before storage and before any LLM call. Then per-group rolling digest, "ask the group" Q&A and an unanswered-questions list.
- **LLM safety:** group text is wrapped as untrusted data, and the LLM has **no send tools**.

## 8. Demo scenes (`npm run demo`, each also a headless test)

| # | Scene | Shows |
|---|---|---|
| 1 | Path A onboarding via wa.me + nonce → magic link | WhatsApp-first sign-up, no OTP needed |
| 2 | Path B onboarding: phone typed in app → copy-code template → code typed in app | Where OTP actually belongs |
| 3 | Hidden-number persona onboards; their LID in a Community stays unlinked | BSUID ≠ LID; the phone number is the only bridge |
| 4 | Free-form send after 24h → 200, then failed status → agent falls back to template | Async failure semantics |
| 5 | Lane A group: create (async) → invite → 7 join → 9th join rejected | 8-cap including the business |
| 6 | Cloud API tries to address an app-created group / a Community; group create on non-OBA number | Official-route limits |
| 7 | Lane B: member number in a 300-member group + Community sub-groups; 40 scripted messages incl. edits, deletes, reactions, view-once | Unofficial reach |
| 8 | Ingestion blocked until admin consent recorded | Consent gate |
| 9 | Prompt-injection message in a group → digest ignores it | Untrusted input |
| 10 | Duplicates, out-of-order statuses, agent 5xx → retries; no double processing | Webhook robustness |
| 11 | Member number banned (`loggedOut`) → Lane B down, onboarding unaffected | Why there are two numbers |

## 9. Phases

| Phase | Size | Deliverable | Exit check |
|---|---|---|---|
| P0 Spike | S | Workspaces; pinned `baileys@7.0.0-rc14` types; fake socket compiles against `Pick<WASocket,…>`; `node:sqlite` under vitest; HMAC raw-byte test with emoji and non-ASCII names; confirm error codes and interactive limits from Meta docs | `tsc` + 3 tests green |
| P1 Cloud lane | M | Sandbox world model, messages, statuses, templates, 24h window, async failures; CloudApiAdapter with inbox and dedupe; UI persona pane + event log | Scenes 4, 10 |
| P2 Onboarding | M | App stub, paths A/B, identity_links, magic link. Optional: same code against the Meta test number via a tunnel (cloudflared), scrubbed recordings → `fixtures/recorded` | Scenes 1, 2, 3 |
| P3 Groups | L | Groups API facade (async create, invites, participants, cap, OBA); fake socket with groups, Communities and the message zoo; BaileysAdapter; consent; redaction; digest and Q&A | Scenes 5–9, 11 |
| P4 Live switches | S | Real Baileys socket behind `LINKED_SOURCE=baileys` + `I_ACCEPT_BAN_RISK=1` (throwaway number, read-only); Graph base-URL switch | Same adapter code compiles and runs; live run only if you supply a number |
| P5 Demo + docs | S | Scripted walkthrough; README with "Where the sandbox lies" | Full demo green |

Not live-testable: the Groups API, because Meta test numbers are not OBA. The sandbox is the only place lane-A groups run until you have a verified OBA number.

## 10. Where the sandbox lies (goes in the README)

- **Not simulated:**
  - Encryption and the wire protocol.
  - Ban detection: a switch here; the real heuristics are unknown.
  - Pricing: labels only.
- **Simplified:**
  - Template approval is instant.
  - History sync is simplified.
  - Group history sharing is not modelled.
- **Fixture trust:** error codes and limits come from Meta docs until recordings replace them. Doc-derived fixtures are marked unverified.

## 11. Decisions needed (defaults in bold)

1. Meta developer account + test number for the optional live Cloud check in P2? **Default: sandbox only.**
2. Run real Baileys with a throwaway number in P4? **Default: code + type-check only, never run.**
3. Anthropic API key for live digests? **Default: replay mode.**
4. TypeScript/Node monorepo in this folder? **Default: yes.**

## Appendix: adversarial review — what changed

| Severity | Finding | Change |
|---|---|---|
| Blocker | OTP inside the same WhatsApp chat proves nothing | Two paths: signed wa.me nonce (no OTP) and app-first OTP typed into the app; app stub added |
| Blocker | Invented WS RPC meant real Baileys code never ran | One BaileysAdapter over a fake socket typed against `baileys` |
| Blocker | Sim knew BSUID↔LID↔phone links no backend gives | Per-observer views + `identity_links` + scene 3 |
| Major | Delivery errors modelled as synchronous | 200 + failed status webhook |
| Major | Dedupe by message id drops statuses; not durable | `(field,id,status)` key; durable inbox before 200 |
| Major | Fidelity checked last | Baileys types in P0; optional Meta test number in P2 |
| Major | Happy paths only | Constraint scenes 3–6, 8–11 |
| Major | Message types too narrow | Message zoo + 515 restart + `append` + lid-mapping events |
| Major | Raw payload stored; consent contradicted read-only | No raw in storage; out-of-band admin consent gate; injection scene; no send tools |
| Major | "Flow-lite" undefined | Flows cut to stretch; lists/buttons instead |
| Minor | Fixtures drift | Recorded > doc fixtures; loose in / strict out; raw-byte HMAC |
| Minor | Async group create implicit | Explicit lifecycle-webhook matching |
| Minor | Deps | Exact pin; `node:sqlite` behind an interface (verified working on Node 26) |
| Minor | Offline fallback demos badly | Labelled replay mode |
| Cut | 300-member chatter generator, dashboard, reset/delete endpoints, rate-limit storms | 40 scripted messages; one-page UI |
