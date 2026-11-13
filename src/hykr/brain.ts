import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Agent } from '../agent/agent'
import { SANDBOX_CLOUD } from '../agent/channels'
import type { Brain, InboundDm } from '../agent/inbound'
import { redact } from '../agent/redact'
import { extractName, matchCommand, matchYesNo } from '../agent/voice/match'
import { CONSENT_VERSION, COPY, codeWord, say, staticLines } from './copy'
import { BRAND, PROFILE, VOCABULARY } from './profile'
import { CLASS_OPTIONS, classLabel, cleanPlace, isSkip, looksLikeQuestion, matchClass, nameMatches, parseKm, parsePhone, parsePin, parseRates, parseRegNo, parseYear, rupees } from './parse'
import { HxStore, type HxFlow, type HxMachine, type HxPerson } from './store'
import { DocumentReader, type DocRead } from './vision'

/** Where a person chatting with the bot is in the conversation. */
type Step =
  | 'new' | 'c1' | 'declined' | 'name' | 'name_confirm' | 'village' | 'village_confirm' | 'role' | 'c2' | 'c2_declined'
  | 'class' | 'class_other' | 'photo_machine' | 'rc' | 'invoice' | 'insurance' | 'pin_plate' | 'hour_meter' | 'location' | 'video'
  | 'details' | 'fix_field' | 'fix_make' | 'fix_year' | 'fix_reg' | 'fix_pin' | 'relationship' | 'rel_proof'
  | 'rate_hour' | 'rate_hour_confirm' | 'rate_day' | 'diesel' | 'radius' | 'summary' | 'edit' | 'more' | 'manager'
  | 'registered' | 'needs_info' | 'paused' | 'm_menu' | 'm_name' | 'm_phone' | 'm_village' | 'm_form' | 'confirm_mitra' | 'driver'

/** Photo steps and the evidence kind each one collects. */
const MEDIA_KIND: Partial<Record<Step, string>> = {
  photo_machine: 'machine', rc: 'rc', invoice: 'invoice', insurance: 'insurance', pin_plate: 'pin_plate', hour_meter: 'hour_meter',
  video: 'video', rel_proof: 'relationship_proof', m_form: 'paper_form',
}
const KIND_LABEL: Record<string, string> = {
  machine: 'a photo of the machine', rc: 'RC', invoice: 'invoice', insurance: 'insurance paper', pin_plate: 'PIN plate', hour_meter: 'hour meter',
  paper_form: 'consent form', relationship_proof: 'relationship document', other: 'something else',
}
/** Steps where the conversation is at rest: no reminders, no "welcome back". */
const AT_REST = new Set<Step>(['registered', 'declined', 'paused', 'c2_declined', 'more', 'm_menu', 'needs_info', 'confirm_mitra', 'new'])
/** The owner's journey, in order, for the drop-off funnel. */
export const FUNNEL: Step[] = ['c1', 'name', 'village', 'role', 'c2', 'class', 'photo_machine', 'rc', 'insurance', 'pin_plate', 'hour_meter', 'location', 'video', 'details', 'rate_hour', 'rate_day', 'diesel', 'radius', 'summary']
const EDIT_GROUPS: Record<string, Step[]> = {
  edit_type: ['class', 'class_other'],
  edit_photos: ['photo_machine', 'rc', 'invoice', 'insurance', 'pin_plate', 'hour_meter', 'location', 'video', 'details', 'fix_field', 'fix_make', 'fix_year', 'fix_reg', 'fix_pin', 'relationship', 'rel_proof'],
  edit_details: ['fix_field', 'fix_make', 'fix_year', 'fix_reg', 'fix_pin', 'details'],
  edit_rates: ['rate_hour', 'rate_hour_confirm', 'rate_day'],
  edit_diesel: ['diesel'],
  edit_travel: ['radius'],
  edit_location: ['location'],
}
const EDIT_START: Record<string, Step> = { edit_type: 'class', edit_photos: 'photo_machine', edit_details: 'fix_field', edit_rates: 'rate_hour', edit_diesel: 'diesel', edit_travel: 'radius', edit_location: 'location' }
const STATUS_LABEL: Record<string, string> = { draft: 'Draft (not submitted)', pending: 'Under review', needs_info: 'Needs one more thing', active: 'Live ✅', rejected: 'Not approved', paused: 'Paused' }
const RESUME_AFTER_MS = 2 * 3_600_000
const REMIND_AFTER_MS = 30 * 60_000
const WINDOW_MS = 24 * 3_600_000

interface Ctx {
  m: InboundDm
  ch: string
  actor: string
  flow: HxFlow
  text: string
  voice: boolean
  sandbox: boolean
}

/**
 * PoC #12: owner onboarding and registration on WhatsApp, for EquipXchange (HYKR). English first.
 * Switchboard does the WhatsApp work (webhooks, voice, templates, inbox); this is the brain it calls.
 * One question at a time; spoken answers are read back; photos are read in the background; every consent
 * is its own record; the desk verifies each machine before it goes live.
 */
export class Hykr implements Brain {
  readonly store: HxStore
  readonly reader: DocumentReader
  private evidenceDir: string
  private reads = new Map<string, Promise<unknown>>()
  private timer: NodeJS.Timeout | null = null
  /** Sandbox Mitra numbers (field partners), so the Mitra path works in the simulator out of the box. */
  sandboxMitras: { phone: string; name: string }[] = []
  /** Run before the onboarding flow; one returning true has handled the message (the EquipXchange bridge). */
  readonly interceptors: ((m: InboundDm) => Promise<boolean>)[] = []
  /** Called when a machine is submitted for verification (the bridge sends it to the app). */
  readonly onSubmitted: ((machineId: string) => void)[] = []
  /** Called when a submitted machine gets a paper or a driver later (after the desk asked); the bridge sends it again. */
  readonly onPaperAdded: ((machineId: string) => void)[] = []
  /**
   * Set by the bridge: the app decides machines it was sent (D76). Returns the app's code for such a
   * machine, and the desk buttons here are refused for it.
   */
  externalDesk: ((machineId: string) => { code: string | null } | null) | null = null

  constructor(
    private agent: Agent,
    dataDir: string,
  ) {
    this.store = new HxStore(agent.store.sql)
    this.reader = new DocumentReader(agent)
    this.evidenceDir = join(dataDir, 'evidence')
    mkdirSync(this.evidenceDir, { recursive: true })
    agent.brain = this
    agent.llm.profile = PROFILE
    agent.voice.vocabulary = VOCABULARY
    agent.voice.registerStaticLines(staticLines())
    agent.dashboardFunnel = () => this.funnel()
    agent.onSandboxCleared.push(() => this.purgeMissing())
  }

  /** Removes HYKR records of people Switchboard no longer has (the simulated world is reset on each start). */
  purgeMissing() {
    const sql = this.store.sql
    const gone = sql.all<{ id: string }>('select id from hx_people where person_id not in (select id from persons)').map((r) => r.id)
    for (const id of gone) {
      for (const e of sql.all<{ path: string }>('select path from hx_evidence where owner_id=?', id)) rmSync(e.path, { force: true })
      for (const t of ['hx_evidence', 'hx_machines']) sql.run(`delete from ${t} where owner_id=?`, id)
      sql.run('delete from hx_consents where person_id=?', id)
      sql.run('delete from hx_events where person_id=?', id)
      sql.run('delete from hx_funnel where owner_id=?', id)
      sql.run('delete from hx_delegates where owner_id=?', id)
      sql.run('delete from hx_drivers where owner_id=?', id)
      sql.run('delete from hx_people where id=?', id)
    }
    sql.run('delete from hx_flow where actor_id not in (select id from persons)')
    // Consent counters of the sandbox channel go with its people (and the old channel-less keys).
    this.agent.store.sql.run("delete from counters where key in ('hx:funnel:c1', 'hx:funnel:declined') or key like ?", `hx:funnel:%:${SANDBOX_CLOUD}`)
    this.bus.change('hykr')
  }

  /** Sum of a consent counter over all channels. */
  private counted(kind: 'c1' | 'declined') {
    return this.agent.store.sql.get<{ n: number }>('select coalesce(sum(value), 0) n from counters where key like ?', `hx:funnel:${kind}:%`)?.n ?? 0
  }

  start() {
    for (const m of this.sandboxMitras) this.store.sql.run('insert or ignore into hx_mitras(phone, name, added_at) values(?,?,?)', m.phone, m.name, Date.now())
    this.timer = setInterval(() => void this.tick().catch(() => undefined), 60_000)
    this.timer.unref()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
  }

  private get bus() {
    return this.agent.bus
  }

  // ================================================================== entry point

  /** True while someone is in the middle of registering (not at rest); the app bridge leaves them alone. */
  busy(personId: string): boolean {
    const f = this.store.flow(personId)
    return !!f && !AT_REST.has(f.step as Step)
  }

  /** True when the desk asked this owner for a paper: their next photo is that paper, not a message for the app. */
  awaitingPaper(personId: string): boolean {
    return this.store.flow(personId)?.step === 'needs_info'
  }

  async handle(m: InboundDm): Promise<void> {
    for (const intercept of this.interceptors) if (await intercept(m)) return
    const sandbox = this.agent.channels.get(m.channelId)?.mode === 'sandbox'
    const voice = m.type === 'voice'
    let text = m.text.trim()
    if (voice) {
      const cmd = matchCommand(text)
      if (cmd) text = cmd.toUpperCase()
    }
    let flow = this.store.flow(m.personId) ?? this.newFlow(m)
    flow.channel_id = m.channelId
    flow = this.refreshRole(flow)
    const c: Ctx = { m, ch: m.channelId, actor: m.personId, flow, text, voice, sandbox }

    // START, with or without the app's sign-in token.
    const start = /^START\b\s*(\S+)?/i.exec(text)
    if (start && (m.type === 'text' || voice)) {
      if (start[1]) this.agent.onboarding.linkStartToken(start[1], m.personId)
      await this.begin(c, true)
      return
    }
    if (await this.command(c)) return
    if (flow.step === 'new') {
      await this.begin(c, false)
      return
    }
    // Back after a break (measured from their previous message, not from our reminders): say so, then carry on.
    if (!AT_REST.has(flow.step as Step) && Date.now() - this.previousInbound(m) > RESUME_AFTER_MS) {
      await this.text(c, say('welcomeBack', { name: this.firstName(c) }))
      if (!this.answersStep(c)) {
        await this.ask(c, flow.step as Step, true)
        return
      }
    }
    await this.on(c)
  }

  /** When this person last wrote to us before the current message. */
  private previousInbound(m: InboundDm) {
    const conv = this.agent.dmConversation(m.channelId, m.personId)
    const prev = this.store.sql.get<{ at: number }>("select at from messages where conversation_id=? and dir='in' order by at desc, rowid desc limit 1 offset 1", conv.id)
    return prev?.at ?? Date.now()
  }

  private newFlow(m: InboundDm): HxFlow {
    const now = Date.now()
    return { actor_id: m.personId, channel_id: m.channelId, owner_id: null, role: 'owner', step: 'new', machine_id: null, data: {}, last_prompt_at: null, reminders: 0, started_at: now, updated_at: now }
  }

  private phoneOf(personId: string) {
    return this.agent.store.links(personId).find((l) => l.kind === 'pn')?.value ?? null
  }

  /** Mitras and managers are recognised by their number. */
  private refreshRole(flow: HxFlow): HxFlow {
    if (flow.role !== 'owner' || !['new', 'c1', 'declined'].includes(flow.step)) return flow
    const phone = this.phoneOf(flow.actor_id)
    if (!phone) return flow
    if (this.store.sql.get('select 1 from hx_mitras where phone=?', phone)) return { ...flow, role: 'mitra', step: flow.step === 'new' ? 'new' : 'm_menu' }
    const d = this.store.sql.get<{ owner_id: string }>('select owner_id from hx_delegates where phone=?', phone)
    if (d) return { ...flow, role: 'delegate', owner_id: d.owner_id }
    return flow
  }

  /** First contact or START. */
  private async begin(c: Ctx, viaStart: boolean): Promise<unknown> {
    const f = c.flow
    if (f.role === 'mitra') return this.ask(c, 'm_menu')
    if (f.role === 'delegate') {
      const owner = f.owner_id ? this.store.person(f.owner_id) : undefined
      await this.text(c, say('managerHello', { owner: owner?.name ?? 'the owner' }))
      return this.newMachine(c)
    }
    if (f.step === 'paused' || f.step === 'declined' || f.step === 'new') {
      if (f.step !== 'paused') await this.text(c, COPY.welcome)
      return this.ask(c, 'c1')
    }
    if (viaStart && (f.step === 'registered' || f.step === 'more')) return this.status(c, true)
    await this.text(c, say('welcomeBack', { name: this.firstName(c) }))
    return this.ask(c, f.step as Step, true)
  }

  /** Commands that work at any step. Returns true if handled. */
  private async command(c: Ctx): Promise<boolean> {
    if (!(c.m.type === 'text' || c.voice)) return false
    const t = c.text
    const upper = t.toUpperCase()
    if (upper === 'STOP' || upper === 'UNSUBSCRIBE') {
      await this.stopAll(c)
      return true
    }
    if (upper === 'HELP') {
      await this.text(c, COPY.help)
      if (!AT_REST.has(c.flow.step as Step)) await this.ask(c, c.flow.step as Step, true)
      return true
    }
    if (/\b(talk to (a |some)?(person|human|someone|agent)|human please|call me|customer care)\b/i.test(t)) {
      await this.handoff(c)
      return true
    }
    if (upper === 'STATUS') {
      await this.status(c, false)
      return true
    }
    const profileDone = this.profileDone(c)
    if (/\b(add|new|another|register (a |another )?)\s*(a |another )?machine\b/i.test(t) && profileDone) {
      if (!this.store.consent(c.flow.owner_id!, 'C2') && c.flow.role === 'owner') {
        await this.ask(c, 'c2')
        return true
      }
      await this.newMachine(c)
      return true
    }
    if (/\badd (a |my )?manager\b/i.test(t) && profileDone && c.flow.role === 'owner') {
      await this.ask(c, 'manager')
      return true
    }
    if (/\b(add|change|new) (a |my |the )?(driver|operator)\b/i.test(t) && profileDone && c.flow.role === 'owner') {
      const back = AT_REST.has(c.flow.step as Step) ? c.flow.step : 'registered'
      this.save(c, { data: { ...c.flow.data, driverThen: 'rest', driverBack: back } })
      await this.ask(c, 'driver')
      return true
    }
    if (upper === 'PAPERS' && c.flow.role === 'owner' && profileDone) {
      await this.ask(c, 'c2')
      return true
    }
    return false
  }

  /** Does this message answer the current question (so "welcome back" shouldn't re-ask it)? */
  private answersStep(c: Ctx) {
    const step = c.flow.step as Step
    if (MEDIA_KIND[step]) return !!c.m.media
    if (step === 'location') return !!c.m.location
    if (c.m.contacts?.length) return true
    // A tap on a template's "Continue" button is a way back in, not an answer.
    if (c.m.type === 'button') return false
    return !!c.m.replyId || (c.m.type === 'text' && !/^(hi|hello|hey|hii+|ok)\W*$/i.test(c.text)) || c.voice
  }

  // ================================================================== sending

  private text(c: Ctx, body: string) {
    return this.agent.text(c.ch, c.actor, body)
  }
  private buttons(c: Ctx, body: string, btns: [string, string][]) {
    return this.agent.buttons(c.ch, c.actor, body, btns.map(([id, title]) => ({ id, title })))
  }
  private list(c: Ctx, body: string, button: string, rows: [string, string][]) {
    return this.agent.list(c.ch, c.actor, body, button, rows.map(([id, title]) => ({ id, title })))
  }

  private save(c: Ctx, patch: Partial<HxFlow> = {}) {
    Object.assign(c.flow, patch)
    this.store.saveFlow(c.flow)
    c.flow.updated_at = Date.now()
  }

  private owner(c: Ctx): HxPerson | undefined {
    return c.flow.owner_id ? this.store.person(c.flow.owner_id) : undefined
  }
  private machine(c: Ctx): HxMachine | undefined {
    return c.flow.machine_id ? this.store.machine(c.flow.machine_id) : undefined
  }
  private firstName(c: Ctx) {
    const n = c.flow.role === 'owner' ? this.owner(c)?.name : this.agent.store.person(c.actor)?.display_name
    return (n ?? '').split(' ')[0] || 'there'
  }
  private profileDone(c: Ctx) {
    if (c.flow.role !== 'owner') return !!c.flow.owner_id
    const p = this.owner(c)
    return !!p && p.status !== 'onboarding' && !!p.name
  }
  private machineLabel(m: HxMachine | undefined) {
    if (!m) return 'machine'
    const what = classLabel(m.class, m.class_other)
    const id = m.reg_no ?? [m.make, m.model].filter(Boolean).join(' ')
    return id ? `${what} (${id})` : what
  }

  // ================================================================== asking

  /** Moves to `step` and asks its question. `again` = re-asking (keeps the reminder count). */
  private async ask(c: Ctx, step: Step, again = false): Promise<unknown> {
    this.save(c, { step, last_prompt_at: Date.now(), reminders: again ? c.flow.reminders : 0 })
    if (c.flow.role === 'owner' && c.flow.owner_id && FUNNEL.includes(step)) this.store.reached(c.flow.owner_id, step)
    const m = this.machine(c)
    switch (step) {
      case 'c1':
        // Nothing is stored about people who say no, so the first funnel step is a plain counter (per channel, so a sandbox reset clears its own).
        if (!c.flow.data.c1Counted) {
          this.agent.store.bump(`hx:funnel:c1:${c.ch}`)
          this.save(c, { data: { ...c.flow.data, c1Counted: true } })
        }
        return this.buttons(c, COPY.c1, [['c1_yes', COPY.c1Yes], ['c1_no', COPY.c1No]])
      case 'declined':
        this.agent.store.bump(`hx:funnel:declined:${c.ch}`)
        return this.text(c, COPY.declined)
      case 'name':
        return this.text(c, COPY.askName)
      case 'name_confirm':
        return this.buttons(c, say('nameHeard', { name: c.flow.data.pendingName }), [['yes_ok', COPY.yesRight], ['no_change', COPY.noChange]])
      case 'village':
        return this.text(c, COPY.askVillage)
      case 'village_confirm':
        return this.buttons(c, say('villageHeard', { village: c.flow.data.pendingVillage }), [['yes_ok', COPY.yesRight], ['no_change', COPY.noChange]])
      case 'role':
        return this.buttons(c, COPY.askRole, [['role_self', COPY.roleSelf], ['role_operator', COPY.roleOperator]])
      case 'driver':
        return this.buttons(c, COPY.askDriver, [['driver_skip', COPY.driverSkip]])
      case 'c2':
        return this.buttons(c, COPY.c2, [['c2_yes', COPY.c2Yes], ['c2_no', COPY.c2No]])
      case 'c2_declined':
        return this.text(c, COPY.c2Declined)
      case 'class':
        return this.list(c, COPY.askClass, COPY.classButton, CLASS_OPTIONS.map((o) => [o.id, o.title]))
      case 'class_other':
        return this.text(c, COPY.askClassOther)
      case 'photo_machine':
        return this.text(c, COPY.askMachinePhoto)
      case 'rc':
        return this.buttons(c, COPY.askRc, [['skip_rc', COPY.noRc]])
      case 'invoice':
        return this.buttons(c, COPY.askInvoice, [['skip_invoice', COPY.noInvoice]])
      case 'insurance':
        return this.buttons(c, COPY.askInsurance, [['skip', COPY.later]])
      case 'pin_plate':
        return this.buttons(c, COPY.askPin, [['skip', COPY.cantFind]])
      case 'hour_meter':
        return this.buttons(c, COPY.askHours, [['skip', COPY.skip]])
      case 'location':
        return this.buttons(c, COPY.askLocation, [['skip', COPY.laterShort]])
      case 'video':
        return this.buttons(c, say('askVideo', { code: codeWord() }), [['skip', COPY.skip]])
      case 'details':
        return this.details(c)
      case 'fix_field':
        return this.list(c, COPY.askFixField, COPY.fixButton, [['fix_make', 'Make and model'], ['fix_year', 'Year'], ['fix_reg', 'Registration no.'], ['fix_pin', 'PIN number']])
      case 'fix_make':
        return this.text(c, COPY.askMakeModel)
      case 'fix_year':
        return this.text(c, COPY.askYear)
      case 'fix_reg':
        return this.text(c, COPY.askRegNo)
      case 'fix_pin':
        return this.text(c, COPY.askPinNo)
      case 'relationship':
        return this.buttons(c, say('rcName', { rcName: m?.rc_owner_name ?? '' }), [['rel_me', COPY.relMe], ['rel_family', COPY.relFamily], ['rel_other', COPY.relOther]])
      case 'rel_proof':
        return this.buttons(c, COPY.askRelProof, [['skip', COPY.later]])
      case 'rate_hour':
        return this.text(c, COPY.askRateHour)
      case 'rate_hour_confirm':
        return this.buttons(c, say('rateHeard', { amount: Number(c.flow.data.pendingRate).toLocaleString('en-IN') }), [['yes_ok', COPY.yesRight], ['no_change', COPY.noChange]])
      case 'rate_day':
        return this.buttons(c, COPY.askRateDay, [['skip_day', COPY.hourlyOnly]])
      case 'diesel':
        return this.buttons(c, COPY.askDiesel, [['diesel_owner', COPY.dieselOwner], ['diesel_customer', COPY.dieselCustomer]])
      case 'radius':
        return this.buttons(c, COPY.askRadius, [['radius_10', COPY.radius10], ['radius_25', COPY.radius25], ['radius_50', COPY.radius50]])
      case 'summary':
        return this.buttons(c, `${this.summary(m)}\n\n${COPY.summaryAsk}`, [['submit', COPY.submit], ['edit', COPY.change]])
      case 'edit':
        return this.list(c, COPY.editWhat, COPY.fixButton, [
          ['edit_type', 'Machine type'],
          ['edit_photos', 'Photos and papers'],
          ['edit_details', 'Make, model, year'],
          ['edit_rates', 'Rates'],
          ['edit_diesel', 'Diesel'],
          ['edit_travel', 'Travel distance'],
          ['edit_location', 'Location'],
        ])
      case 'more': {
        const body = c.flow.data.justSubmitted ? COPY.submitted : COPY.anythingElse
        this.save(c, { data: { ...c.flow.data, justSubmitted: false } })
        return c.flow.role === 'owner'
          ? this.buttons(c, body, [['more_machine', COPY.moreMachine], ['more_manager', COPY.moreManager], ['more_done', COPY.moreDone]])
          : this.buttons(c, body, [['more_machine', COPY.moreMachine], ['more_done', COPY.moreDone]])
      }
      case 'manager':
        return this.text(c, COPY.askManager)
      case 'needs_info': {
        const n = c.flow.data.needs ?? {}
        return this.text(c, say('needsInfo', { machine: this.machineLabel(n.machineId ? this.store.machine(n.machineId) : undefined), what: n.what ?? 'one more photo' }))
      }
      case 'm_menu':
        return this.buttons(c, say('mitraHello', { name: this.firstName(c) }), [['mitra_new', COPY.mitraNew]])
      case 'm_name':
        return this.text(c, COPY.mitraAskName)
      case 'm_phone':
        return this.text(c, COPY.mitraAskPhone)
      case 'm_village':
        return this.text(c, COPY.mitraAskVillage)
      case 'm_form':
        return this.text(c, COPY.mitraAskForm)
      case 'registered':
      case 'paused':
      case 'new':
      case 'confirm_mitra':
        return
    }
  }

  /** The step after `from` in the machine journey, honouring an edit in progress (back to the summary). */
  private next(c: Ctx, from: Step): Step {
    const d = c.flow.data
    const m = this.machine(c)
    let to: Step
    switch (from) {
      case 'class':
      case 'class_other':
        to = 'photo_machine'
        break
      case 'photo_machine':
        to = 'rc'
        break
      case 'rc':
        to = d.noRc ? 'invoice' : 'insurance'
        break
      case 'invoice':
        to = 'insurance'
        break
      case 'insurance':
        to = 'pin_plate'
        break
      case 'pin_plate':
        to = 'hour_meter'
        break
      case 'hour_meter':
        to = 'location'
        break
      case 'location':
        to = 'video'
        break
      case 'video':
        to = 'details'
        break
      case 'details':
      case 'fix_make':
      case 'fix_year':
      case 'fix_reg':
      case 'fix_pin':
        to = m?.rc_owner_name && !m.relationship && !nameMatches(this.store.person(m.owner_id)?.name, m.rc_owner_name) ? 'relationship' : 'rate_hour'
        break
      case 'relationship':
      case 'rel_proof':
        to = 'rate_hour'
        break
      case 'rate_hour':
      case 'rate_hour_confirm':
        to = m?.rate_day != null || d.dayAsked ? 'diesel' : 'rate_day'
        break
      case 'rate_day':
        to = 'diesel'
        break
      case 'diesel':
        to = 'radius'
        break
      default:
        to = 'summary'
    }
    if (d.editGroup && !EDIT_GROUPS[d.editGroup]?.includes(to)) {
      this.save(c, { data: { ...d, editGroup: null } })
      return 'summary'
    }
    return to
  }

  private advance(c: Ctx, from: Step) {
    return this.ask(c, this.next(c, from))
  }

  /** Not an answer to the question: answer a question if it is one, otherwise nudge, then ask again. */
  private async unclear(c: Ctx, hint?: string): Promise<unknown> {
    if (c.text && (looksLikeQuestion(c.text) || (c.voice && c.text.split(' ').length > 6))) {
      const a = await this.agent.llm.appAnswer(c.voice ? redact(c.text).text : c.text, { spoken: this.agent.voice.wantsVoice(c.ch, c.actor) })
      await this.text(c, a.answer)
      this.bus.log({ kind: 'agent', lane: 'A', title: `Question answered mid-flow (${a.inScope ? 'in scope' : 'out of scope'})`, detail: a.engine })
    } else if (hint) {
      await this.text(c, hint)
    } else {
      await this.text(c, COPY.didntCatch)
    }
    if (!AT_REST.has(c.flow.step as Step)) await this.ask(c, c.flow.step as Step, true)
    return undefined
  }

  // ================================================================== answers

  private yes(c: Ctx, ...ids: string[]) {
    return (c.m.replyId && ids.includes(c.m.replyId)) || ((c.m.type === 'text' || c.voice || c.m.type === 'button') && matchYesNo(c.text) === 'yes')
  }
  private no(c: Ctx, ...ids: string[]) {
    return (c.m.replyId && ids.includes(c.m.replyId)) || ((c.m.type === 'text' || c.voice || c.m.type === 'button') && matchYesNo(c.text) === 'no')
  }
  private typed(c: Ctx) {
    return (c.m.type === 'text' || c.voice) && !!c.text
  }

  private async on(c: Ctx): Promise<unknown> {
    const step = c.flow.step as Step
    const d = c.flow.data

    // A location shared at any machine step is kept (owners often send it early).
    if (c.m.location && c.flow.machine_id && step !== 'location') await this.saveLocation(c)

    if (MEDIA_KIND[step] || step === 'needs_info') return this.onMedia(c, step)

    switch (step) {
      case 'c1':
        if (this.yes(c, 'c1_yes')) return this.consentC1(c)
        if (this.no(c, 'c1_no')) return this.ask(c, 'declined')
        return this.unclear(c)
      case 'declined':
        if (this.yes(c) || /\bjoin\b/i.test(c.text)) return this.ask(c, 'c1')
        return this.text(c, COPY.declined)
      case 'name': {
        if (!this.typed(c) || looksLikeQuestion(c.text)) return this.unclear(c)
        if (c.voice) {
          const name = extractName(c.text)
          if (!name) return this.unclear(c, COPY.nameInvalid)
          this.save(c, { data: { ...d, pendingName: name } })
          return this.ask(c, 'name_confirm')
        }
        const name = c.text.replace(/^(my name is|i am|i'm|this is)\s+/i, '').trim()
        if (name.length < 2 || name.length > 80 || /\d/.test(name) || name.split(/\s+/).length > 6) return this.unclear(c, COPY.nameInvalid)
        return this.setName(c, name.replace(/\b\p{Ll}/gu, (x) => x.toUpperCase()))
      }
      case 'name_confirm':
        if (this.yes(c, 'yes_ok')) return this.setName(c, d.pendingName)
        if (this.no(c, 'no_change')) return void (await this.text(c, COPY.nameRetry), this.save(c, { step: 'name' }))
        if (c.voice && extractName(c.text)) {
          this.save(c, { data: { ...d, pendingName: extractName(c.text) } })
          return this.ask(c, 'name_confirm')
        }
        return this.unclear(c)
      case 'village': {
        if (c.m.location) {
          const label = c.m.location.name || c.m.location.address || 'Shared location'
          this.store.updatePerson(c.flow.owner_id!, { village: label })
          return this.ask(c, 'role')
        }
        if (!this.typed(c) || looksLikeQuestion(c.text)) return this.unclear(c)
        const place = cleanPlace(c.text)
        if (place.length < 2) return this.unclear(c)
        if (c.voice) {
          this.save(c, { data: { ...d, pendingVillage: place } })
          return this.ask(c, 'village_confirm')
        }
        this.store.updatePerson(c.flow.owner_id!, { village: place })
        return this.ask(c, 'role')
      }
      case 'village_confirm':
        if (this.yes(c, 'yes_ok')) {
          this.store.updatePerson(c.flow.owner_id!, { village: d.pendingVillage })
          return this.ask(c, 'role')
        }
        if (this.no(c, 'no_change')) return void (await this.text(c, COPY.villageRetry), this.save(c, { step: 'village' }))
        return this.unclear(c)
      case 'role': {
        let self: boolean | null = c.m.replyId === 'role_self' ? true : c.m.replyId === 'role_operator' ? false : null
        if (self === null && this.typed(c)) {
          if (/\b(operator|driver|someone else|staff|employee|helper)\b/i.test(c.text)) self = false
          else if (/\b(myself|i drive|i operate|self|me|i do)\b/i.test(c.text) || matchYesNo(c.text) === 'yes') self = true
        }
        if (self === null) return this.unclear(c)
        return this.finishProfile(c, self)
      }
      case 'c2':
        if (this.yes(c, 'c2_yes')) {
          const id = this.store.giveConsent(c.flow.owner_id!, 'C2', 'whatsapp', CONSENT_VERSION.C2, c.text || 'yes')
          this.store.emit('consent.given', { actor: 'owner', personId: c.flow.owner_id, payload: { consent_id: id, purpose: 'C2', wording_version: CONSENT_VERSION.C2, channel: 'whatsapp' } })
          if (d.resumeAfterC2) {
            const resume = d.resumeAfterC2 as Step
            this.save(c, { data: { ...d, resumeAfterC2: null } })
            return this.resumeAfterStop(c, resume)
          }
          return this.newMachine(c)
        }
        if (this.no(c, 'c2_no')) {
          // S05: the listing exists, but stays a draft until papers are allowed.
          if (!this.store.machines(c.flow.owner_id!).length) {
            const mc = this.store.createMachine(c.flow.owner_id!, c.flow.role)
            this.store.addFlag(mc.id, 'no_papers_consent')
            this.save(c, { machine_id: mc.id })
          }
          return this.ask(c, 'c2_declined')
        }
        return this.unclear(c)
      case 'c2_declined':
        if (/\bpapers?\b/i.test(c.text) || this.yes(c)) return this.ask(c, 'c2')
        return this.unclear(c, COPY.c2Declined)
      case 'class': {
        const opt = c.m.replyId ? CLASS_OPTIONS.find((o) => o.id === c.m.replyId) : this.typed(c) ? matchClass(c.text) : null
        if (!opt) return this.unclear(c)
        const m = this.machine(c) ?? this.startMachine(c)
        this.store.updateMachine(m.id, { class: opt.cls })
        if (opt.cls === 'other' && !c.m.replyId && /\b(roller|crane|grader|dozer|paver)\b/i.test(c.text)) {
          this.store.updateMachine(m.id, { class_other: /\b(roller|crane|grader|dozer|paver)\b/i.exec(c.text)![1].toLowerCase() })
          return this.advance(c, 'class_other')
        }
        return opt.cls === 'other' ? this.ask(c, 'class_other') : this.advance(c, 'class')
      }
      case 'class_other':
        if (!this.typed(c)) return this.unclear(c)
        this.store.updateMachine(c.flow.machine_id!, { class_other: c.text.slice(0, 60) })
        return this.advance(c, 'class_other')
      case 'location':
        if (c.m.location) {
          await this.saveLocation(c)
          return this.advance(c, 'location')
        }
        if (c.m.replyId === 'skip' || (this.typed(c) && isSkip(c.text))) return this.advance(c, 'location')
        if (this.typed(c) && !looksLikeQuestion(c.text) && c.text.length >= 2) {
          this.store.updateMachine(c.flow.machine_id!, { base_label: cleanPlace(c.text) })
          return this.advance(c, 'location')
        }
        return this.unclear(c, COPY.locationHint)
      case 'details':
        if (this.yes(c, 'details_ok')) return this.advance(c, 'details')
        if (this.no(c, 'details_fix')) return this.ask(c, 'fix_field')
        return this.unclear(c)
      case 'fix_field': {
        const id = c.m.replyId ?? (/make|model/i.test(c.text) ? 'fix_make' : /year/i.test(c.text) ? 'fix_year' : /reg/i.test(c.text) ? 'fix_reg' : /pin|chassis/i.test(c.text) ? 'fix_pin' : null)
        if (!id || !['fix_make', 'fix_year', 'fix_reg', 'fix_pin'].includes(id)) return this.unclear(c)
        this.save(c, { data: { ...d, fixOne: true } })
        return this.ask(c, id as Step)
      }
      case 'fix_make': {
        if (!this.typed(c)) return this.unclear(c)
        const words = cleanPlace(c.text).split(/\s+/)
        this.store.updateMachine(c.flow.machine_id!, { make: words[0].toUpperCase(), model: words.slice(1).join(' ').toUpperCase() || null })
        return this.afterFix(c, 'fix_make')
      }
      case 'fix_year': {
        const y = parseYear(c.text)
        if (!y) return this.unclear(c)
        this.store.updateMachine(c.flow.machine_id!, { year: y })
        return this.afterFix(c, 'fix_year')
      }
      case 'fix_reg': {
        const r = parseRegNo(c.text)
        if (!r) return this.unclear(c, COPY.askRegNo)
        this.store.updateMachine(c.flow.machine_id!, { reg_no: r, reg_status: 'registered' })
        return this.afterFix(c, 'fix_reg')
      }
      case 'fix_pin': {
        const p = parsePin(c.text)
        if (!p) return this.unclear(c, COPY.askPinNo)
        this.store.updateMachine(c.flow.machine_id!, { pin: p })
        return this.afterFix(c, 'fix_pin')
      }
      case 'relationship': {
        const id = c.m.replyId ?? (/\b(me|myself|mine|my name)\b/i.test(c.text) ? 'rel_me' : /\b(father|mother|brother|wife|husband|son|family|uncle|dad)\b/i.test(c.text) ? 'rel_family' : /\b(someone|other|friend|owner)\b/i.test(c.text) ? 'rel_other' : null)
        if (id === 'rel_me') {
          this.store.updateMachine(c.flow.machine_id!, { relationship: 'self' })
          return this.advance(c, 'relationship')
        }
        if (id === 'rel_family') {
          this.store.updateMachine(c.flow.machine_id!, { relationship: 'family' })
          this.store.addFlag(c.flow.machine_id!, 'rc_in_family_name')
          return this.ask(c, 'rel_proof')
        }
        if (id === 'rel_other') {
          this.store.updateMachine(c.flow.machine_id!, { relationship: 'other' })
          this.store.addFlag(c.flow.machine_id!, 'rc_other_person')
          await this.text(c, COPY.relOtherNote)
          return this.advance(c, 'relationship')
        }
        return this.unclear(c)
      }
      case 'rate_hour': {
        if (!this.typed(c)) return this.unclear(c)
        const r = parseRates(c.text)
        if (!r.first || r.first < 100 || r.first > 50_000) return this.unclear(c, looksLikeQuestion(c.text) ? undefined : COPY.rateInvalid)
        if (r.day) this.store.updateMachine(c.flow.machine_id!, { rate_day: r.day * 100 })
        if (c.voice) {
          // Read back every spoken number before saving (the speech model can mishear numbers).
          this.save(c, { data: { ...d, pendingRate: r.first, dayAsked: d.dayAsked || !!r.day } })
          return this.ask(c, 'rate_hour_confirm')
        }
        this.store.updateMachine(c.flow.machine_id!, { rate_hour: r.first * 100 })
        this.save(c, { data: { ...d, dayAsked: d.dayAsked || !!r.day } })
        return this.advance(c, 'rate_hour')
      }
      case 'rate_hour_confirm':
        if (this.yes(c, 'yes_ok')) {
          this.store.updateMachine(c.flow.machine_id!, { rate_hour: Number(d.pendingRate) * 100 })
          return this.advance(c, 'rate_hour_confirm')
        }
        if (this.no(c, 'no_change')) return this.ask(c, 'rate_hour')
        return this.unclear(c)
      case 'rate_day': {
        if (c.m.replyId === 'skip_day' || (this.typed(c) && isSkip(c.text) && !parseRates(c.text).first)) {
          this.store.updateMachine(c.flow.machine_id!, { rate_day: null })
          return this.advance(c, 'rate_day')
        }
        const r = parseRates(c.text)
        if (!r.first || r.first < 500 || r.first > 500_000) return this.unclear(c, looksLikeQuestion(c.text) ? undefined : COPY.rateInvalid)
        this.store.updateMachine(c.flow.machine_id!, { rate_day: r.first * 100 })
        return this.advance(c, 'rate_day')
      }
      case 'diesel': {
        const id = c.m.replyId ?? (/\b(customer|they|contractor|client|buyer|renter)\b/i.test(c.text) ? 'diesel_customer' : /\b(i |me|myself|owner|included|my side|i provide|i give|i pay)\b/i.test(` ${c.text} `) ? 'diesel_owner' : null)
        if (id !== 'diesel_owner' && id !== 'diesel_customer') return this.unclear(c)
        this.store.updateMachine(c.flow.machine_id!, { diesel: id === 'diesel_owner' ? 'owner' : 'customer' })
        return this.advance(c, 'diesel')
      }
      case 'radius': {
        const km = c.m.replyId?.startsWith('radius_') ? Number(c.m.replyId.slice(7)) : this.typed(c) ? parseKm(c.text) : null
        if (!km) return this.unclear(c)
        this.store.updateMachine(c.flow.machine_id!, { radius_km: km })
        return this.advance(c, 'radius')
      }
      case 'summary':
        if (c.m.replyId === 'submit' || (this.typed(c) && /\bsubmit\b/i.test(c.text)) || this.yes(c)) return this.submit(c)
        if (c.m.replyId === 'edit' || this.no(c) || /\b(change|edit|wrong)\b/i.test(c.text)) return this.ask(c, 'edit')
        return this.unclear(c)
      case 'edit': {
        const id = c.m.replyId && EDIT_START[c.m.replyId] ? c.m.replyId : null
        if (!id) return this.unclear(c)
        this.save(c, { data: { ...d, editGroup: id } })
        return this.ask(c, EDIT_START[id])
      }
      case 'more': {
        // Button ids first: a button's title ("Add a manager") must not be read as free text ("add …").
        const id = c.m.replyId ?? (/\bmanager\b/i.test(c.text) ? 'more_manager' : /\b(another|add|more)\b/i.test(c.text) ? 'more_machine' : /\b(done|finish|that's all|thats all)\b/i.test(c.text) || this.no(c) ? 'more_done' : null)
        if (id === 'more_machine') return this.newMachine(c)
        if (id === 'more_manager' && c.flow.role === 'owner') return this.ask(c, 'manager')
        if (id === 'more_done') return this.allDone(c)
        return this.unclear(c)
      }
      case 'manager': {
        const phone = c.m.contacts?.[0]?.phone ? parsePhone(c.m.contacts[0].phone) : this.typed(c) ? parsePhone(c.text) : null
        if (!phone) return this.unclear(c, COPY.managerInvalid)
        const name = c.m.contacts?.[0]?.name || null
        this.store.sql.run('insert or replace into hx_delegates(phone, owner_id, role, name, added_at) values(?,?,?,?,?)', phone, c.flow.owner_id, 'manager', name, Date.now())
        this.store.emit('delegate.added', { actor: 'owner', personId: c.flow.owner_id, payload: { phone: `+${phone}`, role: 'manager', name } })
        await this.text(c, say('managerAdded', { who: name ? `${name} (+${phone})` : `+${phone}` }))
        return this.ask(c, 'more')
      }
      case 'driver': {
        // The person who drives the machine (D80): a shared contact, or a typed number with or without a name.
        const skip = c.m.replyId === 'driver_skip' || (this.typed(c) && isSkip(c.text))
        if (skip) return this.afterDriver(c, false)
        const contact = c.m.contacts?.[0]
        const phone = contact?.phone ? parsePhone(contact.phone) : this.typed(c) ? parsePhone(c.text) : null
        if (!phone) return this.unclear(c, COPY.driverInvalid)
        const name = contact?.name?.trim() || (this.typed(c) ? driverName(c.text) : null)
        this.store.setDriver(c.flow.owner_id!, phone, name)
        this.store.emit('driver.added', { actor: 'owner', personId: c.flow.owner_id, payload: { phone: `+${phone}`, name } })
        await this.text(c, say('driverAdded', { who: name ? `${name} (+${phone})` : `+${phone}` }))
        return this.afterDriver(c, true)
      }
      case 'registered':
        if (c.m.media) return this.text(c, 'Want to add another machine? Say “add machine”.')
        if (this.typed(c) && (looksLikeQuestion(c.text) || c.text.split(' ').length > 4)) return this.unclear(c)
        return this.text(c, COPY.registeredHint)
      case 'paused':
        return this.text(c, COPY.pausedHint)
      case 'm_menu':
        if (c.m.replyId === 'mitra_new' || /\b(register|new owner|yes|add owner)\b/i.test(c.text)) {
          this.save(c, { data: { mitraOwner: {} } })
          return this.ask(c, 'm_name')
        }
        return this.unclear(c)
      case 'm_name': {
        const name = (c.voice ? extractName(c.text) : null) ?? c.text.trim()
        if (!this.typed(c) || name.length < 2 || /\d/.test(name)) return this.unclear(c, COPY.nameInvalid)
        this.save(c, { data: { ...d, mitraOwner: { ...d.mitraOwner, name: name.replace(/\b\p{Ll}/gu, (x) => x.toUpperCase()) } } })
        return this.ask(c, 'm_phone')
      }
      case 'm_phone': {
        const phone = c.m.contacts?.[0]?.phone ? parsePhone(c.m.contacts[0].phone) : this.typed(c) ? parsePhone(c.text) : null
        if (!phone) return this.unclear(c, COPY.managerInvalid)
        this.save(c, { data: { ...d, mitraOwner: { ...d.mitraOwner, phone } } })
        return this.ask(c, 'm_village')
      }
      case 'm_village':
        if (!this.typed(c)) return this.unclear(c)
        this.save(c, { data: { ...d, mitraOwner: { ...d.mitraOwner, village: cleanPlace(c.text) } } })
        return this.ask(c, 'm_form')
      case 'confirm_mitra':
        return this.onConfirmMitra(c)
    }
    return this.unclear(c)
  }

  // ================================================================== profile

  private async consentC1(c: Ctx) {
    const sbPerson = this.agent.store.person(c.actor)
    const p = this.store.ensurePerson(c.actor, this.phoneOf(c.actor) ? `+${this.phoneOf(c.actor)}` : null)
    const wasPaused = p.status === 'paused'
    this.save(c, { owner_id: p.id, role: 'owner' })
    const id = this.store.giveConsent(p.id, 'C1', 'whatsapp', CONSENT_VERSION.C1, c.text || 'yes')
    this.store.emit('consent.given', { actor: 'owner', personId: p.id, payload: { consent_id: id, purpose: 'C1', wording_version: CONSENT_VERSION.C1, channel: 'whatsapp' } })
    this.agent.store.sql.run('update persons set opted_out=0 where id=?', c.actor)
    if (wasPaused && p.name) {
      // Back after STOP. STOP withdrew every consent, so papers (C2) are asked again before machines return.
      this.store.updatePerson(p.id, { status: 'active' })
      const resume = (c.flow.data.resumeStep as Step) ?? 'registered'
      if (this.store.machines(p.id).length && !this.store.consent(p.id, 'C2')) {
        this.save(c, { data: { ...c.flow.data, resumeAfterC2: resume } })
        return this.ask(c, 'c2')
      }
      return this.resumeAfterStop(c, resume)
    }
    if (sbPerson && sbPerson.account_status === 'none') this.agent.store.sql.run("update persons set account_status='onboarding' where id=?", c.actor)
    return this.ask(c, 'name')
  }

  private async resumeAfterStop(c: Ctx, resume: Step) {
    this.store.sql.run("update hx_machines set status='pending' where owner_id=? and status='paused'", c.flow.owner_id)
    this.bus.change('hykr')
    if (resume === 'registered' || AT_REST.has(resume)) {
      this.save(c, { step: 'registered' })
      return this.status(c, true)
    }
    return this.ask(c, resume)
  }

  private async setName(c: Ctx, name: string) {
    this.store.updatePerson(c.flow.owner_id!, { name })
    this.agent.store.sql.run('update persons set display_name=? where id=?', name, c.actor)
    this.agent.bus.change('contacts')
    return this.ask(c, 'village')
  }

  private async finishProfile(c: Ctx, operatesSelf: boolean) {
    const id = c.flow.owner_id!
    this.store.updatePerson(id, { owner_operator: operatesSelf ? 1 : 0, roles: JSON.stringify(operatesSelf ? ['owner', 'operator'] : ['owner']), status: 'active', kyc_level: 'T0' })
    this.agent.store.sql.run("update persons set account_status='active' where id=?", c.actor)
    const p = this.store.person(id)!
    this.store.emit('person.registered', { actor: 'owner', personId: id, payload: { roles: JSON.parse(p.roles), language: 'en', kyc_level: 'T0' }, key: `person.registered:${id}` })
    this.agent.bus.log({ kind: 'agent', lane: 'A', title: `HYKR owner registered (${id})`, detail: p.name ?? '' })
    this.agent.bus.change('contacts')
    // Someone else drives it: ask who, so the app can send them the job card (D80).
    if (!operatesSelf) {
      this.save(c, { data: { ...c.flow.data, driverThen: 'profile' } })
      return this.ask(c, 'driver')
    }
    return this.afterProfile(c)
  }

  private async afterProfile(c: Ctx) {
    const id = c.flow.owner_id!
    await this.text(c, say('profileDone', { name: (this.store.person(id)?.name ?? '').split(' ')[0] }))
    if (this.store.consent(id, 'C2')) return this.newMachine(c)
    return this.ask(c, 'c2')
  }

  /**
   * After the driver question: during registration, on to the machine; asked by the desk (or "add driver"),
   * back to where the owner was, and the submitted machines go to the app again with the driver.
   */
  private async afterDriver(c: Ctx, added: boolean) {
    const d = c.flow.data
    const askedFor = d.needs?.kind === 'driver' ? (d.needs.machineId as string | undefined) : undefined
    const back = ((d.driverBack ?? d.needs?.returnStep) as Step | undefined) ?? 'registered'
    this.save(c, { data: { ...d, driverThen: null, driverBack: null, ...(askedFor ? { needs: null } : {}) } })
    if ((d.driverThen ?? 'profile') === 'profile' && !askedFor) {
      if (!added) await this.text(c, COPY.driverLater)
      return this.afterProfile(c)
    }
    if (added) {
      if (askedFor) this.store.updateMachine(askedFor, { status: 'pending' })
      const ids = askedFor ? [askedFor] : this.store.machines(c.flow.owner_id!).filter((m) => m.submitted_at).map((m) => m.id)
      for (const id of ids) for (const f of this.onPaperAdded) f(id)
    } else {
      await this.text(c, COPY.driverLater)
    }
    this.bus.change('hykr')
    if (AT_REST.has(back)) return this.save(c, { step: back })
    return this.ask(c, back, true)
  }

  // ================================================================== machines

  private startMachine(c: Ctx): HxMachine {
    const m = this.store.createMachine(c.flow.owner_id!, c.flow.role === 'owner' ? 'owner' : `${c.flow.role}:${c.actor}`)
    this.save(c, { machine_id: m.id, data: { ...(c.flow.role === 'mitra' ? { mitraOwner: c.flow.data.mitraOwner } : {}) } })
    return m
  }

  private async newMachine(c: Ctx) {
    // Reuse an empty draft (e.g. created when papers were declined), otherwise start a new machine.
    const draft = this.store.machines(c.flow.owner_id!).find((m) => m.status === 'draft' && !m.class)
    if (draft) this.save(c, { machine_id: draft.id, data: c.flow.role === 'mitra' ? { mitraOwner: c.flow.data.mitraOwner } : {} })
    else this.startMachine(c)
    if (draft) this.store.updateMachine(draft.id, { flags: JSON.stringify(this.store.flags(draft).filter((f) => f !== 'no_papers_consent')) })
    return this.ask(c, 'class')
  }

  private async saveLocation(c: Ctx) {
    const l = c.m.location!
    const r3 = (n: number) => Math.round(n * 1000) / 1000 // kit: base location rounded to 3 decimals
    this.store.updateMachine(c.flow.machine_id!, { base_lat: r3(l.lat), base_lng: r3(l.lng), base_label: l.name || l.address || this.owner(c)?.village || 'Shared location' })
  }

  /** Photo steps: store the evidence, read it in the background, move on at once. */
  private async onMedia(c: Ctx, step: Step): Promise<unknown> {
    const d = c.flow.data
    const kind = step === 'needs_info' ? (d.needs?.kind ?? 'other') : MEDIA_KIND[step]!
    const media = c.m.media
    if (media && (media.kind !== 'video' || step === 'video' || step === 'needs_info')) {
      const ev = await this.saveEvidence(c, kind, step === 'needs_info' ? d.needs?.machineId : step === 'm_form' ? null : c.flow.machine_id)
      if (!ev) return this.text(c, 'Sorry, that photo didn’t come through. Please send it again.')
      if (step === 'm_form') return this.mitraCreateOwner(c, ev)
      if (step === 'needs_info') return this.needsInfoReceived(c, ev)
      if (step === 'rc') this.save(c, { data: { ...d, noRc: false } })
      return this.advance(c, step)
    }
    if (media && media.kind === 'video') {
      // A video when we asked for a photo: keep it as the walkaround and ask again for the photo.
      await this.saveEvidence(c, 'video', c.flow.machine_id)
      return this.ask(c, step, true)
    }
    const skip = c.m.replyId?.startsWith('skip') || (this.typed(c) && isSkip(c.text))
    if (skip && step !== 'photo_machine' && step !== 'm_form' && step !== 'needs_info') {
      const mid = c.flow.machine_id!
      if (step === 'rc') {
        this.store.updateMachine(mid, { reg_status: 'not_given' })
        this.save(c, { data: { ...d, noRc: true } })
      } else if (step === 'invoice') {
        // S03: no RC and no invoice → lowest assurance; the desk arranges an inspection (Path B).
        this.store.updateMachine(mid, { reg_status: 'unregistered' })
        this.store.addFlag(mid, 'no_papers')
        await this.text(c, COPY.noPapersNote)
      } else if (step === 'insurance') this.store.addFlag(mid, 'insurance_later')
      else if (step === 'pin_plate') this.store.addFlag(mid, 'pin_plate_missing')
      else if (step === 'rel_proof') this.store.addFlag(mid, 'relationship_proof_later')
      return this.advance(c, step)
    }
    return this.unclear(c, COPY.mediaHint)
  }

  private async saveEvidence(c: Ctx, kind: string, machineId: string | null | undefined) {
    const media = c.m.media!
    const client = this.agent.client(c.ch)
    const info = await client.mediaInfo(media.id)
    if (!info.ok || !info.json?.url) return null
    const dl = await client.downloadMedia(String(info.json.url))
    if (!dl.ok) return null
    const mime = String(info.json.mime_type ?? media.mime ?? dl.mime).split(';')[0]
    const ext = /jpe?g/.test(mime) ? 'jpg' : /png/.test(mime) ? 'png' : /webp/.test(mime) ? 'webp' : /pdf/.test(mime) ? 'pdf' : /mp4/.test(mime) ? 'mp4' : 'bin'
    const id = this.store.nextId('E')
    const path = join(this.evidenceDir, `${id}.${ext}`)
    writeFileSync(path, dl.bytes)
    const ownerId = c.flow.owner_id
    const consent = ownerId ? (this.store.consent(ownerId, 'C2')?.id ?? null) : null
    this.store.sql.run(
      'insert into hx_evidence(id, owner_id, machine_id, kind, mime, path, bytes, sha256, captured_at, captured_where, consent_id, message_id, created_at) values(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      ownerId,
      machineId ?? null,
      kind,
      mime,
      path,
      dl.bytes.length,
      createHash('sha256').update(dl.bytes).digest('hex'),
      Date.now(),
      null,
      consent,
      c.m.messageId ?? null,
      Date.now(),
    )
    // Show it in the inbox (the message bubble links to the evidence).
    if (c.m.messageId) {
      const row = this.agent.store.sql.get<{ text: string; payload: string | null }>('select text, payload from messages where id=?', c.m.messageId)
      if (row) this.agent.store.setMessageContent(c.m.messageId, row.text, { ...(row.payload ? JSON.parse(row.payload) : {}), evidence: id, evidenceKind: kind })
    }
    this.store.emit('machine.evidence_added', { actor: c.flow.role, personId: ownerId, machineId, payload: { evidence_id: id, kind } })
    this.bus.change('hykr')
    // Read the photo in the background; the details step waits for it only if it is still running.
    if (kind !== 'video' && /^image\//.test(mime)) {
      const job = this.reader
        .read({ path, mime }, media.id, c.sandbox)
        .then((r) => r && this.applyRead(id, r))
        .catch(() => undefined)
        .finally(() => this.reads.delete(id))
      this.reads.set(id, job)
    }
    return this.store.evidence(id)
  }

  /** Stores what a photo says, re-labels it if it is a different document, and pre-fills the machine. */
  private applyRead(evidenceId: string, r: DocRead) {
    const ev = this.store.evidence(evidenceId)
    if (!ev) return
    this.store.sql.run('update hx_evidence set read=?, read_engine=? where id=?', JSON.stringify({ kind: r.kind, readable: r.readable, fields: r.fields }), r.engine, evidenceId)
    this.bus.log({ kind: 'agent', lane: 'A', title: `Photo read: ${KIND_LABEL[r.kind] ?? r.kind}${r.readable ? '' : ' (unreadable)'}`, detail: `${ev.id} · ${r.engine}${r.ms ? ` in ${(r.ms / 1000).toFixed(1)} s` : ''}` })
    if (!ev.machine_id) return
    const SLOTS = ['machine', 'rc', 'invoice', 'insurance', 'pin_plate', 'hour_meter']
    if (r.readable && r.kind !== ev.kind && SLOTS.includes(r.kind) && SLOTS.includes(ev.kind) && !this.store.evidenceOfKind(ev.machine_id, r.kind)) {
      this.store.sql.run('update hx_evidence set kind=? where id=?', r.kind, ev.id)
      this.store.sql.run('update hx_evidence set read=? where id=?', JSON.stringify({ kind: r.kind, readable: true, fields: r.fields, relabelled_from: ev.kind }), ev.id)
    }
    const m = this.store.machine(ev.machine_id)
    if (!m || !r.readable) return
    const f = r.fields
    const fill: Partial<HxMachine> = {}
    const set = <K extends keyof HxMachine>(k: K, v: HxMachine[K] | null | undefined) => {
      if (v != null && v !== '' && (m[k] == null || m[k] === '')) (fill as any)[k] = v
    }
    if (r.kind === 'rc' || r.kind === 'invoice' || r.kind === 'pin_plate') {
      set('make', f.make?.toUpperCase())
      set('model', f.model?.toUpperCase())
      set('year', f.year ? Number(/\d{4}/.exec(f.year)?.[0]) || null : null)
      set('pin', f.chassis_or_pin?.replace(/\s/g, '').toUpperCase())
      set('engine_no', f.engine_no)
    }
    if (r.kind === 'rc') {
      set('reg_no', f.reg_no ? (parseRegNo(f.reg_no) ?? f.reg_no) : null)
      set('rc_owner_name', f.owner_name)
      if (f.reg_no && !m.reg_status) fill.reg_status = 'registered'
    }
    if (r.kind === 'invoice') {
      set('rc_owner_name', f.owner_name)
      if (!m.reg_status || m.reg_status === 'not_given') fill.reg_status = 'unregistered'
    }
    if (r.kind === 'insurance') set('insurance_expiry', f.valid_till)
    if (r.kind === 'hour_meter') set('hour_reading', f.hour_reading)
    this.store.updateMachine(m.id, fill)
    this.bus.change('hykr')
  }

  /** Waits (briefly) for this machine's photo reads still running. */
  private async readsDone(machineId: string, maxMs = 12_000) {
    const ids = this.store.evidenceFor(machineId).map((e) => e.id)
    const jobs = ids.map((id) => this.reads.get(id)).filter(Boolean) as Promise<unknown>[]
    if (jobs.length) await Promise.race([Promise.all(jobs), new Promise((r) => setTimeout(r, maxMs))])
  }

  /** Read-back of what the papers say; asks only for what is missing or unreadable. */
  private async details(c: Ctx): Promise<unknown> {
    const mid = c.flow.machine_id!
    await this.readsDone(mid)
    const m = this.store.machine(mid)!
    const evs = this.store.evidenceFor(mid)
    const has = (k: string) => evs.some((e) => e.kind === k)
    const read = (k: string) => evs.filter((e) => e.kind === k).map((e) => (e.read ? JSON.parse(e.read) : null)).find(Boolean)

    // Wrong or unreadable photo in a required slot: ask for it again, then come back here.
    if (!has('machine')) {
      const seen = evs.find((e) => e.read && JSON.parse(e.read).relabelled_from === 'machine')
      await this.text(c, say('wrongPhoto', { seen: seen ? `the ${KIND_LABEL[seen.kind]}` : 'something else', expected: 'whole machine' }))
      return this.save(c, { step: 'photo_machine', last_prompt_at: Date.now() })
    }
    const rcRead = read('rc')
    if (has('rc') && rcRead && rcRead.readable === false) {
      this.store.sql.run("update hx_evidence set kind='rc_unreadable' where machine_id=? and kind='rc'", mid)
      await this.text(c, say('blurry', { expected: 'RC' }))
      return this.save(c, { step: 'rc', last_prompt_at: Date.now() })
    }
    if (m.insurance_expiry && isPast(m.insurance_expiry) && !this.store.flags(m).includes('insurance_expired')) {
      this.store.addFlag(mid, 'insurance_expired')
      await this.text(c, say('insuranceExpired', { date: m.insurance_expiry }))
    }
    const parts = [[m.make, m.model].filter(Boolean).join(' '), m.year ? String(m.year) : '', m.reg_no ? `registration ${m.reg_no}` : '', m.pin ? `PIN ${m.pin}` : ''].filter(Boolean)
    if (parts.length) {
      this.store.updateMachine(mid, {}) // touch
      return this.buttons(c, say('detailsRead', { details: parts.join(', ') }), [['details_ok', COPY.detailsOk], ['details_fix', COPY.detailsFix]])
    }
    // Nothing could be read (no AI key, or unreadable photos): ask, one question at a time.
    this.save(c, { data: { ...c.flow.data, manualDetails: true } })
    return this.ask(c, 'fix_make')
  }

  /** After a manual detail: next missing detail, or back to the read-back. */
  private async afterFix(c: Ctx, from: Step) {
    const d = c.flow.data
    const m = this.machine(c)!
    if (d.manualDetails && !d.fixOne) {
      if (!m.year && from === 'fix_make') return this.ask(c, 'fix_year')
      if (!m.reg_no && m.reg_status !== 'unregistered' && m.reg_status !== 'not_given' && (from === 'fix_make' || from === 'fix_year')) return this.ask(c, 'fix_reg')
      this.save(c, { data: { ...d, manualDetails: false } })
      return this.advance(c, from)
    }
    this.save(c, { data: { ...d, fixOne: false, manualDetails: false } })
    return this.ask(c, 'details')
  }

  private summary(m: HxMachine | undefined) {
    if (!m) return ''
    const evs = this.store.evidenceFor(m.id)
    const tick = (k: string, label: string) => `${label} ${evs.some((e) => e.kind === k) ? '✓' : '—'}`
    const lines = [
      'Here’s your machine:',
      `🚜 ${cap(classLabel(m.class, m.class_other))}${m.make || m.model ? ` · ${[m.make, m.model].filter(Boolean).join(' ')}` : ''}${m.year ? ` · ${m.year}` : ''}`,
      m.reg_no || m.pin ? `🪪 ${[m.reg_no ? `Reg. ${m.reg_no}` : '', m.pin ? `PIN ${m.pin}` : ''].filter(Boolean).join(' · ')}` : '🪪 Not registered',
      `📍 ${m.base_label ?? this.store.person(m.owner_id)?.village ?? 'Location not shared'}${m.base_lat != null ? ' (pin shared)' : ''}`,
      `💰 ${rupees(m.rate_hour)}/hour${m.rate_day ? ` · ${rupees(m.rate_day)}/day` : ''}`,
      `⛽ Diesel: ${m.diesel === 'owner' ? 'you provide' : m.diesel === 'customer' ? 'customer provides' : '—'} · 🛣️ up to ${m.radius_km ?? '—'} km`,
      `📷 ${[tick('machine', 'Machine'), tick('rc', 'RC'), ...(evs.some((e) => e.kind === 'invoice') ? [tick('invoice', 'Invoice')] : []), tick('insurance', 'Insurance'), tick('pin_plate', 'PIN plate'), tick('hour_meter', 'Hour meter'), tick('video', 'Video')].join(' · ')}`,
    ]
    return lines.join('\n')
  }

  private async submit(c: Ctx) {
    const m = this.machine(c)!
    this.store.updateMachine(m.id, { status: 'pending', submitted_at: Date.now() })
    this.store.emit('machine.submitted', {
      actor: c.flow.role,
      personId: m.owner_id,
      machineId: m.id,
      payload: { machine_id: m.id, class: m.class, reg_status: m.reg_status ?? (m.reg_no ? 'registered' : 'unknown'), evidence: this.store.evidenceFor(m.id).map((e) => e.kind) },
      key: `machine.submitted:${m.id}:${Date.now()}`,
    })
    if (c.flow.role === 'owner') this.store.reached(m.owner_id, 'submitted')
    this.bus.log({ kind: 'agent', lane: 'A', title: `Machine submitted for verification (${m.id})`, detail: this.machineLabel(m) })
    for (const f of this.onSubmitted) f(m.id)
    this.bus.change('hykr')
    if (c.flow.role === 'mitra') return this.mitraFinished(c)
    this.save(c, { machine_id: null, data: { justSubmitted: true } })
    return this.ask(c, 'more')
  }

  private async allDone(c: Ctx) {
    this.save(c, { step: 'registered', machine_id: null, data: {} })
    if (c.flow.role !== 'owner') return this.text(c, COPY.delegateDone)
    await this.text(c, say('allDone', { name: this.firstName(c) }))
    const sess = this.agent.onboarding.newSessionFor(c.ch, c.actor)
    await this.text(c, say('appLink', { brand: BRAND, link: this.agent.onboarding.magicLink(sess, c.actor) }))
  }

  private async status(c: Ctx, withLink: boolean) {
    const ownerId = c.flow.owner_id
    const ms = ownerId ? this.store.machines(ownerId).filter((m) => m.class || m.status !== 'draft') : []
    if (!ms.length) return this.text(c, COPY.noMachines)
    await this.text(c, [`Your machines:`, ...ms.map((m) => `• ${cap(this.machineLabel(m))}: ${STATUS_LABEL[m.status] ?? m.status}`)].join('\n'))
    if (withLink && c.flow.role === 'owner') {
      const sess = this.agent.onboarding.newSessionFor(c.ch, c.actor)
      await this.text(c, say('appLink', { brand: BRAND, link: this.agent.onboarding.magicLink(sess, c.actor) }))
    }
  }

  // ================================================================== STOP, handoff

  private async stopAll(c: Ctx) {
    const ownerId = c.flow.owner_id
    if (ownerId && c.flow.role === 'owner') {
      const withdrawn = this.store.withdrawAll(ownerId)
      for (const w of withdrawn) this.store.emit('consent.withdrawn', { actor: 'owner', personId: ownerId, payload: { consent_id: w.id, purpose: w.purpose } })
      this.store.updatePerson(ownerId, { status: 'paused' })
      this.store.sql.run("update hx_machines set status='paused' where owner_id=? and status in ('pending','active','needs_info')", ownerId)
    }
    this.agent.store.sql.run('update persons set opted_out=1 where id=?', c.actor)
    this.agent.bus.change('contacts')
    this.save(c, { step: 'paused', data: { ...c.flow.data, resumeStep: AT_REST.has(c.flow.step as Step) ? 'registered' : c.flow.step } })
    return this.text(c, COPY.stopped)
  }

  private async handoff(c: Ctx) {
    const conv = this.agent.dmConversation(c.ch, c.actor)
    await this.text(c, COPY.handoff)
    this.agent.store.sql.run("update conversations set assignee='Ops desk' where id=?", conv.id)
    this.store.emit('handover.to_person', { actor: 'owner', personId: c.flow.owner_id, machineId: c.flow.machine_id, payload: { reason: 'asked for a person', step: c.flow.step, summary: this.handoverSummary(c) } })
    this.bus.log({ kind: 'agent', lane: 'A', title: 'Handed to the ops desk', detail: this.handoverSummary(c) })
    this.bus.change('conversations', { id: conv.id })
  }

  /** What the desk needs in 30 seconds: who, where in the flow, which machine. */
  private handoverSummary(c: Ctx) {
    const p = this.owner(c)
    const m = this.machine(c)
    return `${p?.name ?? 'Unknown'} (${c.flow.role}) at step "${c.flow.step}"${m ? `, ${this.machineLabel(m)} [${m.id}]` : ''}`
  }

  // ================================================================== Mitra (assisted onboarding, S07)

  private async mitraCreateOwner(c: Ctx, form: { id: string }) {
    const o = c.flow.data.mitraOwner ?? {}
    // The owner becomes a WhatsApp contact by number, so we can message them to confirm.
    let personId = this.agent.store.findByLink('pn', o.phone)
    if (!personId) personId = this.agent.store.createPerson(o.name).id
    personId = this.agent.identity.attachPhone(personId, o.phone, 'mitra', c.ch)
    this.agent.store.sql.run("update persons set display_name=?, account_status='active' where id=?", o.name, personId)
    const p = this.store.ensurePerson(personId, `+${o.phone}`, `mitra:${c.actor}`)
    this.store.updatePerson(p.id, { name: o.name, village: o.village, status: 'active', kyc_level: 'T0' })
    this.store.sql.run('update hx_evidence set owner_id=? where id=?', p.id, form.id)
    for (const [purpose, version] of [['C1', CONSENT_VERSION.C1], ['C2', CONSENT_VERSION.C2]] as const) {
      const cid = this.store.giveConsent(p.id, purpose, 'paper', version, 'paper form (ticked)', form.id)
      this.store.emit('consent.given', { actor: `mitra:${c.actor}`, personId: p.id, payload: { consent_id: cid, purpose, channel: 'paper', evidence_id: form.id } })
    }
    this.store.emit('person.registered', { actor: `mitra:${c.actor}`, personId: p.id, payload: { roles: ['owner'], language: 'en', kyc_level: 'T0', via: 'mitra' }, key: `person.registered:${p.id}` })
    this.save(c, { owner_id: p.id, data: { ...c.flow.data, mitraOwner: { ...o, personId, hxId: p.id } } })
    this.bus.change('contacts')
    await this.text(c, say('mitraOwnerCreated', { owner: o.name }))
    return this.newMachine(c)
  }

  private async mitraFinished(c: Ctx) {
    const o = c.flow.data.mitraOwner ?? {}
    const mitraName = this.agent.store.person(c.actor)?.display_name ?? 'Our field partner'
    // Ask the owner to confirm on WhatsApp (the kit: a digital confirmation of the paper consent).
    const ownerFlow: HxFlow = { ...this.newFlow({ channelId: c.ch, personId: o.personId } as InboundDm), owner_id: o.hxId, step: 'confirm_mitra', data: { mitra: mitraName } }
    this.store.saveFlow(ownerFlow)
    await this.notify(o.hxId, say('ownerConfirm', { owner: o.name.split(' ')[0], mitra: mitraName, brand: BRAND }), 'owner_confirm', [o.name.split(' ')[0], mitraName], [
      ['oc_yes', COPY.ownerConfirmYes],
      ['oc_no', COPY.ownerConfirmNo],
    ])
    await this.text(c, say('mitraDone', { owner: o.name }))
    this.save(c, { owner_id: null, machine_id: null, data: {} })
    return this.ask(c, 'm_menu')
  }

  private async onConfirmMitra(c: Ctx) {
    const ownerId = c.flow.owner_id!
    if (this.yes(c, 'oc_yes')) {
      for (const [purpose, version] of [['C1', CONSENT_VERSION.C1], ['C2', CONSENT_VERSION.C2]] as const) {
        const cid = this.store.giveConsent(ownerId, purpose, 'whatsapp', version, `confirmed Mitra registration: ${c.text}`)
        this.store.emit('consent.given', { actor: 'owner', personId: ownerId, payload: { consent_id: cid, purpose, channel: 'whatsapp', confirms: 'paper' } })
      }
      this.save(c, { step: 'registered', data: {} })
      return this.text(c, COPY.ownerConfirmed)
    }
    if (this.no(c, 'oc_no')) {
      this.store.updatePerson(ownerId, { status: 'paused' })
      this.store.sql.run("update hx_machines set status='paused' where owner_id=?", ownerId)
      for (const m of this.store.machines(ownerId)) this.store.addFlag(m.id, 'owner_denied_mitra')
      this.store.emit('consent.withdrawn', { actor: 'owner', personId: ownerId, payload: { reason: 'owner says the Mitra registration is wrong' } })
      this.save(c, { step: 'registered', data: {} })
      this.bus.change('hykr')
      return this.text(c, COPY.ownerDenied)
    }
    return this.unclear(c)
  }

  // ================================================================== desk decisions (the stand-in for PoC #6 sign-off)

  /** Message an owner: free text inside the 24-hour window, otherwise an approved template. */
  private async notify(ownerId: string, body: string, template: string, params: string[], buttons?: [string, string][]) {
    const p = this.store.person(ownerId)
    if (!p) return
    const flow = this.store.flow(p.person_id)
    const ch = flow?.channel_id ?? this.agent.channels.all().find((x) => x.kind === 'cloud' && this.agent.store.links(p.person_id).some((l) => l.channel_id === x.id))?.id
    if (!ch) return
    const conv = this.agent.dmConversation(ch, p.person_id)
    const open = !!conv.last_inbound_at && Date.now() - conv.last_inbound_at < WINDOW_MS
    if (open) {
      if (buttons) await this.agent.buttons(ch, p.person_id, body, buttons.map(([id, title]) => ({ id, title })))
      else await this.agent.text(ch, p.person_id, body)
    } else {
      await this.agent.template(ch, p.person_id, template, 'en_US', params, `Template "${template}"`)
    }
  }

  /** Refuses a desk decision here for a machine the app decides (D76). */
  private decidedInApp(machineId: string): { ok: false; error: string } | null {
    const ext = this.externalDesk?.(machineId)
    return ext ? { ok: false, error: `This machine is checked in EquipXchange${ext.code ? ` (${ext.code})` : ''}. Decide there; the result shows here.` } : null
  }

  async deskApprove(machineId: string, by: string) {
    const m = this.store.machine(machineId)
    if (!m) return { ok: false, error: 'not found' }
    const elsewhere = this.decidedInApp(machineId)
    if (elsewhere) return elsewhere
    this.store.updateMachine(machineId, { status: 'active', verified_at: Date.now(), desk_note: null })
    this.store.updatePerson(m.owner_id, { kyc_level: 'T1' })
    this.store.emit('machine.verified', { actor: `desk:${by}`, personId: m.owner_id, machineId, payload: { assurance_level: m.reg_no ? 'A2' : 'A1', reasons: ['desk sign-off'], flags: this.store.flags(m) } })
    this.store.reached(m.owner_id, 'verified')
    await this.notify(m.owner_id, say('verified', { machine: this.machineLabel(m) }), 'machine_update', [this.store.person(m.owner_id)?.name?.split(' ')[0] ?? 'there', this.machineLabel(m)])
    this.bus.log({ kind: 'agent', lane: 'A', title: `Machine verified by the desk (${machineId})`, detail: by })
    this.bus.change('hykr')
    return { ok: true }
  }

  async deskAsk(machineId: string, kind: string, note: string, by: string) {
    const m = this.store.machine(machineId)
    if (!m) return { ok: false, error: 'not found' }
    const elsewhere = this.decidedInApp(machineId)
    if (elsewhere) return elsewhere
    const what = note || `a clear photo of the ${KIND_LABEL[kind] ?? 'document'}`
    this.awaitFromOwner(machineId, kind, what, `desk:${by}`)
    const p = this.store.person(m.owner_id)!
    await this.notify(m.owner_id, say('needsInfo', { machine: this.machineLabel(m), what }), 'machine_update', [p.name?.split(' ')[0] ?? 'there', this.machineLabel(m)])
    return { ok: true }
  }

  /**
   * Marks a machine as waiting for something from its owner and sets their chat to take the next reply as
   * that: a photo of the paper, or (kind `driver`) the driver's contact. Sends nothing: the caller tells the
   * owner (this desk, or the app through the bridge, D79).
   */
  awaitFromOwner(machineId: string, kind: string, what: string, actor: string) {
    const m = this.store.machine(machineId)
    if (!m) return false
    this.store.updateMachine(machineId, { status: 'needs_info', desk_note: what })
    this.store.emit('machine.flagged', { actor, personId: m.owner_id, machineId, payload: { reasons: [what], needs: kind } })
    const p = this.store.person(m.owner_id)
    const flow = p ? this.store.flow(p.person_id) : undefined
    if (flow) {
      const returnStep = AT_REST.has(flow.step as Step) && flow.step !== 'needs_info' ? flow.step : flow.step === 'needs_info' ? (flow.data.needs?.returnStep ?? 'registered') : flow.step
      flow.data = { ...flow.data, needs: { machineId, kind, what, returnStep } }
      if (AT_REST.has(flow.step as Step)) {
        flow.step = kind === 'driver' ? 'driver' : 'needs_info'
        if (kind === 'driver') flow.data.driverThen = 'desk'
      }
      this.store.saveFlow(flow)
    }
    this.bus.change('hykr')
    return true
  }

  async deskReject(machineId: string, reason: string, by: string) {
    const m = this.store.machine(machineId)
    if (!m) return { ok: false, error: 'not found' }
    const elsewhere = this.decidedInApp(machineId)
    if (elsewhere) return elsewhere
    this.store.updateMachine(machineId, { status: 'rejected', desk_note: reason })
    this.store.emit('machine.rejected', { actor: `desk:${by}`, personId: m.owner_id, machineId, payload: { reasons: [reason] } })
    await this.notify(m.owner_id, say('rejected', { machine: this.machineLabel(m), reason }), 'machine_update', [this.store.person(m.owner_id)?.name?.split(' ')[0] ?? 'there', this.machineLabel(m)])
    this.bus.change('hykr')
    return { ok: true }
  }

  private async needsInfoReceived(c: Ctx, ev: { id: string }) {
    const n = c.flow.data.needs ?? {}
    if (n.machineId) {
      this.store.updateMachine(n.machineId, { status: 'pending' })
      this.store.emit('machine.evidence_added', { actor: 'owner', personId: c.flow.owner_id, machineId: n.machineId, payload: { evidence_id: ev.id, kind: n.kind, answers: 'desk request' } })
      // A machine the app has: the new paper goes there for its desk (D79).
      for (const f of this.onPaperAdded) f(n.machineId)
    }
    await this.text(c, COPY.needsInfoThanks)
    const back = (n.returnStep as Step) ?? 'registered'
    this.save(c, { data: { ...c.flow.data, needs: null } })
    this.bus.change('hykr')
    if (AT_REST.has(back)) return this.save(c, { step: back })
    return this.ask(c, back, true)
  }

  // ================================================================== reminders

  /** Every minute: one nudge after 30 minutes of silence; a template if the 24-hour window has closed. */
  async tick(now = Date.now()) {
    const due = this.store.sql.all<any>('select * from hx_flow where last_prompt_at < ? and reminders < 2', now - REMIND_AFTER_MS)
    for (const r of due) {
      const f: HxFlow = { ...r, data: JSON.parse(r.data || '{}') }
      if (AT_REST.has(f.step as Step)) continue
      const conv = this.agent.dmConversation(f.channel_id, f.actor_id)
      const open = !!conv.last_inbound_at && now - conv.last_inbound_at < WINDOW_MS
      if (conv.assignee) continue
      const c: Ctx = { m: { channelId: f.channel_id, personId: f.actor_id, type: 'other', text: '' }, ch: f.channel_id, actor: f.actor_id, flow: f, text: '', voice: false, sandbox: false }
      if (open && f.reminders === 0) {
        await this.text(c, COPY.reminder)
        this.save(c, { reminders: 1 })
        await this.ask(c, f.step as Step, true)
        this.save(c, { reminders: 1, last_prompt_at: now })
      } else if (!open) {
        const name = this.owner(c)?.name?.split(' ')[0] ?? 'there'
        await this.agent.template(f.channel_id, f.actor_id, 'continue_registration', 'en_US', [name], 'Template "continue_registration"')
        this.save(c, { reminders: 2 })
      }
    }
  }

  // ================================================================== reporting

  funnel() {
    const counts = this.store.sql.all<{ step: string; n: number }>('select step, count(*) n from hx_funnel group by step')
    const by: Record<string, number> = Object.fromEntries(counts.map((r) => [r.step, r.n]))
    by.c1 = Math.max(by.c1 ?? 0, this.counted('c1'))
    const steps = [...FUNNEL, 'submitted', 'verified'].map((s) => ({ step: s, reached: by[s] ?? 0 }))
    return {
      steps,
      owners: this.store.sql.get<{ n: number }>("select count(*) n from hx_people where roles like '%owner%'")?.n ?? 0,
      declined: this.counted('declined'),
      machines: Object.fromEntries(this.store.sql.all<{ status: string; n: number }>('select status, count(*) n from hx_machines group by status').map((r) => [r.status, r.n])),
    }
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** "My driver is ramesh, 98480 12345" → "Ramesh": the name typed next to a driver's number, if any. */
export function driverName(text: string): string | null {
  const words = text
    .replace(/\+?\d[\d\s-]{6,}\d/g, ' ')
    .replace(/\b(my|the|driver|operator|is|name|number|no|phone|mobile|and|his|her|he|she|called)\b/gi, ' ')
    .replace(/[^\p{L}\s.]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1)
  if (!words.length) return null
  return words
    .slice(0, 4)
    .join(' ')
    .replace(/\b\p{Ll}/gu, (x) => x.toUpperCase())
}

function isPast(date: string) {
  const m = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/.exec(date) ?? null
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(date)
  const d = iso ? new Date(`${iso[1]}-${iso[2]}-${iso[3]}T23:59:59+05:30`) : m ? new Date(`${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}T23:59:59+05:30`) : null
  return !!d && d.getTime() < Date.now()
}
