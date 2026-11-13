import type { Bus } from '../shared/bus'
import type { Store } from './store'

/**
 * One person can show up under three unrelated identifiers:
 *  - pn    phone number (the only bridge between lanes, often missing)
 *  - bsuid business-scoped user id (Cloud API; differs per business)
 *  - lid   linked-device Local Identifier (Baileys; differs from bsuid)
 * Nothing in either API links bsuid to lid, so records are merged only when a phone number proves it.
 */
export class Identity {
  constructor(
    private store: Store,
    private bus: Bus,
  ) {}

  resolveCloud(o: { channelId: string; waId?: string; bsuid?: string; name?: string }): string {
    const { store } = this
    let personId = (o.bsuid && store.findByLink('bsuid', o.bsuid, o.channelId)) || (o.waId && store.findByLink('pn', o.waId)) || undefined
    if (!personId) personId = store.createPerson(o.name || (o.waId ? `+${o.waId}` : 'WhatsApp user')).id
    if (o.bsuid) store.addLink(personId, 'bsuid', o.bsuid, 'wa_inbound', o.channelId)
    if (o.waId) personId = this.attachPhone(personId, o.waId, 'wa_inbound', o.channelId)
    this.upgradePlaceholderName(personId, o.name)
    return personId
  }

  resolveLinked(o: { channelId: string; lid?: string; pn?: string; name?: string; source: string }): string {
    const { store } = this
    let personId = o.lid ? store.findByLink('lid', o.lid, o.channelId) : undefined
    if (!personId && o.pn) personId = store.findByLink('pn', o.pn)
    if (!personId) {
      const label = o.name || (o.lid ? `LID …${o.lid.slice(-4)}` : o.pn ? `+${o.pn}` : 'Unknown member')
      personId = store.createPerson(label).id
      this.bus.log({ kind: 'agent', lane: 'B', title: `New group member record: ${label}`, detail: o.pn ? 'phone known' : 'no phone: stays pseudonymous until a phone links it' })
    }
    if (o.lid) store.addLink(personId, 'lid', o.lid, o.pn ? o.source : 'linked_inbound', o.channelId)
    if (o.pn) personId = this.attachPhone(personId, o.pn, o.source, o.channelId)
    this.upgradePlaceholderName(personId, o.name)
    return personId
  }

  /** Replace a placeholder name (a phone number or LID stub) with the member's WhatsApp display name. */
  upgradePlaceholderName(personId: string, name?: string) {
    if (!name) return
    const p = this.store.person(personId)
    if (p && isPlaceholder(p.display_name) && !isPlaceholder(name)) {
      this.store.sql.run('update persons set display_name=? where id=?', name, personId)
    }
  }

  /** A phone number arrived for a LID later (lid-mapping.update): link it, merging records if needed. */
  linkLid(channelId: string, lid: string, pn: string, source: string) {
    const personId = this.store.findByLink('lid', lid, channelId)
    if (personId) this.attachPhone(personId, pn, source, channelId)
  }

  /** Attach a phone; if another record already owns it, that is the same human: merge. */
  attachPhone(personId: string, pn: string, source: string, channelId: string): string {
    const owner = this.store.findByLink('pn', pn)
    if (owner && owner !== personId) {
      const a = this.store.person(owner)!
      const b = this.store.person(personId)!
      // keep the older record (usually the onboarded one)
      const [keep, drop] = a.created_at <= b.created_at ? [owner, personId] : [personId, owner]
      this.store.merge(keep, drop)
      this.store.addLink(keep, 'pn', pn, source, channelId)
      this.bus.log({ kind: 'agent', lane: '-', title: 'Identity merged via phone number', detail: `${source}: two records proved to be one person` })
      this.bus.change('contacts')
      return keep
    }
    this.store.addLink(personId, 'pn', pn, source, channelId)
    return personId
  }
}

/** Names that are really identifiers: never show them to an LLM or in a digest. */
export const isPlaceholder = (name: string) => /^\+?\d[\d\s]{5,}$/.test(name) || name === 'WhatsApp user' || name.startsWith('LID …') || name === 'Unknown member'
