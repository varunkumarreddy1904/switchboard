import { digits, mulberry32 } from '../shared/ids'

/**
 * Seed data for the simulated world. Phone numbers use ranges reserved for fiction
 * (US 555-01xx, UK 07700 900xxx, AU 0491 570xxx) so nothing here maps to a real person.
 */

export interface Persona {
  id: string
  name: string
  /** E.164 digits without '+'. */
  pn: string
  /** Business-scoped user id the Cloud API reports for this person (format unverified). */
  bsuid: string
  /** Linked-device Local Identifier (digits of `<lid>@lid`). */
  lid: string
  /** Cloud API omits wa_id/from for this person (username/hidden-number users). */
  hiddenNumber: boolean
  /** Linked lane receives `participantAlt` (their phone) in LID-addressed groups. */
  pnInGroups: boolean
  hue: number
  country: string
  synthetic?: boolean
}

const rand = mulberry32(20261109)

const named: Array<[id: string, name: string, pn: string, country: string, hidden: boolean, pnInGroups: boolean]> = [
  ['asha', 'Asha Rao', '15555550101', 'US', false, true],
  ['ben', 'Ben Carter', '447700900101', 'GB', false, true],
  ['chen', 'Chen Wei', '61491570101', 'AU', false, true],
  ['diego', 'Diego Alvarez', '15555550102', 'US', false, false],
  ['elif', 'Elif Kaya', '447700900102', 'GB', false, false],
  ['fatima', 'Fatima Noor', '447700900103', 'GB', true, false],
  ['grace', 'Grace Kim', '61491570102', 'AU', false, true],
  ['hiro', 'Hiro Tanaka', '15555550103', 'US', false, false],
  ['isabel', 'Isabel Costa', '447700900104', 'GB', false, true],
  ['jonas', 'Jonas Weber', '61491570103', 'AU', false, false],
  ['kofi', 'Kofi Mensah', '15555550104', 'US', false, true],
  ['lena', 'Lena Novak', '447700900105', 'GB', false, false],
]

const mk = (id: string, name: string, pn: string, country: string, hidden: boolean, pnInGroups: boolean, synthetic = false): Persona => ({
  id,
  name,
  pn,
  bsuid: `${country}.${digits(rand, 19)}`,
  lid: digits(rand, 15),
  hiddenNumber: hidden,
  pnInGroups,
  hue: Math.floor(rand() * 360),
  country,
  synthetic,
})

export const NAMED_PERSONAS: Persona[] = named.map(([id, name, pn, c, h, g]) => mk(id, name, pn, c, h, g))

/**
 * EquipXchange (HYKR) test people from the PoC review pack's synthetic test set (section 7.4), for PoC #12.
 * Indian numbers from a range we control in the sandbox only (+91 90000 000xx); never sent to Meta.
 */
const hykr: Array<[id: string, name: string, pn: string]> = [
  ['ravi', 'Ravi Kumar', '919000000001'], // O1: owner-operator, one backhoe, voice notes, Kazipet
  ['srinivas', 'Srinivas Rao', '919000000002'], // O2: fleet owner, four machines, a manager replies for him
  ['mahesh', 'Mahesh Goud', '919000000003'], // O3: second-hand unregistered backhoe, no invoice
  ['anil', 'Anil Reddy', '919000000004'], // says no to sharing papers (S05)
  ['venkat', 'Venkat Reddy', '919000000005'], // O5: RC in his father's name (K. Narayana)
  ['kiran', 'Kiran (manager)', '919000000012'], // O2's manager
  ['lakshmi', 'Lakshmi (Mitra)', '919000000020'], // MI1: field partner, paper forms
  ['raju', 'Raju Yadav', '919000000021'], // owner registered by the Mitra
  ['prakash', 'Prakash (operator)', '919000000031'], // Ravi's driver: gets job cards from the EquipXchange app
  ['suresh', 'Suresh (contractor)', '919000000040'], // books machines in the EquipXchange app; gets prices here
]
export const HYKR_PERSONAS: Persona[] = hykr.map(([id, name, pn]) => mk(id, name, pn, 'IN', false, false))
export const SANDBOX_MITRAS = [{ phone: '919000000020', name: 'Lakshmi (Mitra)' }]

/** The isolated "member number" whose linked device reads the large groups (lane B). */
export const MEMBER_PERSONA: Persona = mk('member', 'Ops member number', '15555550199', 'US', false, true)

export const SYNTHETIC_PERSONAS: Persona[] = Array.from({ length: 290 }, (_, i) => {
  const n = String(i + 1).padStart(3, '0')
  return mk(`m${n}`, `Member ${n}`, `1555555${String(2000 + i)}`, 'US', false, false, true)
})

export const BUSINESS = {
  wabaId: '100000000000001',
  phoneNumberId: '200000000000001',
  displayPhone: '15555550123',
  verifiedName: 'EquipXchange',
  accessToken: 'SANDBOX_ACCESS_TOKEN_equipxchange',
  appSecret: 'sandbox_app_secret_7c2f',
  verifyToken: 'sandbox_verify_token',
}

export type LinkedGroupKind = 'group' | 'community' | 'community_announce' | 'community_sub'

export interface LinkedGroupSeed {
  jid: string
  subject: string
  desc: string
  kind: LinkedGroupKind
  parent?: string
  announce: boolean
  admins: string[]
  members: string[]
  memberJoined: boolean
}

const synth = (from: number, count: number) => SYNTHETIC_PERSONAS.slice(from, from + count).map((p) => p.id)
const allNamed = NAMED_PERSONAS.map((p) => p.id)

export const COMMUNITY_JID = '120363049999000001@g.us'

export const LINKED_GROUPS: LinkedGroupSeed[] = [
  {
    jid: '120363041234567890@g.us',
    subject: 'Founders Circle',
    desc: 'Peer group for early-stage founders. Be kind, no spam.',
    kind: 'group',
    announce: false,
    admins: ['asha'],
    members: [...allNamed, 'member', ...synth(0, 287)], // 12 + 1 + 287 = 300
    memberJoined: true,
  },
  {
    jid: COMMUNITY_JID,
    subject: 'City Runners',
    desc: 'Community for city running clubs.',
    kind: 'community',
    announce: true,
    admins: ['grace'],
    members: [...allNamed, 'member', ...synth(0, 120)],
    memberJoined: true,
  },
  {
    jid: '120363049999000002@g.us',
    subject: 'City Runners · Announcements',
    desc: 'Only admins can post here.',
    kind: 'community_announce',
    parent: COMMUNITY_JID,
    announce: true,
    admins: ['grace'],
    members: [...allNamed, 'member', ...synth(0, 120)],
    memberJoined: true,
  },
  {
    jid: '120363049999000003@g.us',
    subject: 'Weekend Long Runs',
    desc: 'Saturday and Sunday long runs.',
    kind: 'community_sub',
    parent: COMMUNITY_JID,
    announce: false,
    admins: ['grace'],
    members: ['grace', 'chen', 'diego', 'elif', 'fatima', 'hiro', 'jonas', 'member', ...synth(0, 72)],
    memberJoined: true,
  },
  {
    jid: '120363049999000004@g.us',
    subject: 'Gear Talk',
    desc: 'Shoes, watches, gels.',
    kind: 'community_sub',
    parent: COMMUNITY_JID,
    announce: false,
    admins: ['grace'],
    members: ['grace', 'ben', 'isabel', 'kofi', 'lena', 'chen', ...synth(100, 39)],
    memberJoined: false, // member number joins mid-script; sees only messages after that
  },
]

export interface TemplateSeed {
  name: string
  language: string
  category: 'AUTHENTICATION' | 'UTILITY' | 'MARKETING'
  body: string
  buttons?: Array<{ type: 'OTP' | 'QUICK_REPLY' | 'URL' | 'GROUP_INVITE'; text: string }>
  footer?: string
}

export const TEMPLATES: TemplateSeed[] = [
  // PoC #12 (HYKR): messages sent outside the 24-hour window. Submit the same wording to Meta for a live number.
  {
    name: 'continue_registration',
    language: 'en_US',
    category: 'UTILITY',
    body: 'Hi {{1}}, your EquipXchange registration is almost done. Reply to this message to continue where you left off.',
    buttons: [{ type: 'QUICK_REPLY', text: 'Continue' }],
  },
  {
    name: 'machine_update',
    language: 'en_US',
    category: 'UTILITY',
    body: 'Hi {{1}}, there is an update on your {{2}} on EquipXchange. Reply to this message to see it.',
    buttons: [{ type: 'QUICK_REPLY', text: 'See update' }],
  },
  {
    name: 'owner_confirm',
    language: 'en_US',
    category: 'UTILITY',
    body: 'Hi {{1}}, {{2}} registered you and your machine on EquipXchange using a paper form. Is that right?',
    buttons: [{ type: 'QUICK_REPLY', text: 'Yes, that’s right' }, { type: 'QUICK_REPLY', text: 'No, it’s wrong' }],
  },
  {
    name: 'otp_login',
    language: 'en_US',
    category: 'AUTHENTICATION',
    body: '*{{1}}* is your verification code. For your security, do not share this code.',
    footer: 'This code expires in 10 minutes.',
    buttons: [{ type: 'OTP', text: 'Copy code' }],
  },
  {
    // EquipXchange app messages outside the 24-hour window: the full message follows once they reply.
    name: 'eqx_update',
    language: 'en_US',
    category: 'UTILITY',
    body: 'Hi {{1}}, there is an update from EquipXchange: {{2}}. Tap below to see it.',
    buttons: [{ type: 'QUICK_REPLY', text: 'See details' }],
  },
  {
    name: 'welcome_back',
    language: 'en_US',
    category: 'UTILITY',
    body: 'Hi {{1}}, there is an update on your EquipXchange account. Reply to this message to continue the conversation.',
    buttons: [{ type: 'QUICK_REPLY', text: 'Continue' }],
  },
  {
    name: 'group_invite',
    language: 'en_US',
    category: 'UTILITY',
    body: 'You are invited to join an EquipXchange group on WhatsApp: {{1}}',
    buttons: [{ type: 'GROUP_INVITE', text: 'Join group' }],
  },
  {
    name: 'weekly_digest',
    language: 'en_US',
    category: 'MARKETING',
    body: 'Hi {{1}}, your weekly EquipXchange digest is ready: {{2}} new posts in your groups.',
    buttons: [{ type: 'QUICK_REPLY', text: 'Show me' }, { type: 'QUICK_REPLY', text: 'Stop promotions' }],
  },
]
