import { EventEmitter } from 'node:events'
import {
  proto,
  WAMessageAddressingMode,
  WAMessageStubType,
  type BaileysEventEmitter,
  type BaileysEventMap,
  type ConnectionState,
  type GroupMetadata,
  type WAMessage,
  type WAMessageKey,
} from 'baileys'
import type { LinkedSocket } from '../shared/linkedSocket'
import type { Persona } from './seed'
import type { LinkedGroup, LinkedMsg, LinkedWorld } from './types'

class TypedEmitter implements BaileysEventEmitter {
  private e = new EventEmitter()
  constructor() {
    this.e.setMaxListeners(50)
  }
  on<T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void) {
    this.e.on(event, listener)
  }
  off<T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void) {
    this.e.off(event, listener)
  }
  removeAllListeners<T extends keyof BaileysEventMap>(event: T) {
    this.e.removeAllListeners(event)
  }
  emit<T extends keyof BaileysEventMap>(event: T, arg: BaileysEventMap[T]) {
    return this.e.emit(event, arg)
  }
}

export const lidJid = (p: Persona) => `${p.lid}@lid`
export const pnJid = (p: Persona) => `${p.pn}@s.whatsapp.net`

/**
 * In-process stand-in for a Baileys v7 socket. It implements the agent's `LinkedSocket`
 * contract (typed against Baileys) and emits the same events with the same shapes, so the
 * agent's BaileysAdapter runs unchanged against this or a real `makeWASocket()` socket.
 */
export class FakeSocket implements LinkedSocket {
  ev = new TypedEmitter()

  constructor(private w: LinkedWorld) {}

  signalRepository = {
    lidMapping: {
      getPNForLID: async (lid: string): Promise<string | null> => {
        const digits = lid.split('@')[0].split(':')[0]
        const pn = this.w.knownPnForLid(digits)
        return pn ? `${pn}@s.whatsapp.net` : null
      },
    },
  }

  async groupMetadata(jid: string): Promise<GroupMetadata> {
    const g = this.w.linkedGroup(jid)
    if (!g || g.memberJoinedAt === null) throw Object.assign(new Error('not-authorized'), { output: { statusCode: 401 } })
    return this.meta(g)
  }

  async groupFetchAllParticipating(): Promise<{ [_: string]: GroupMetadata }> {
    const out: { [_: string]: GroupMetadata } = {}
    for (const g of this.w.linkedGroups()) if (g.memberJoinedAt !== null && g.kind !== 'community') out[g.jid] = this.meta(g)
    return out
  }

  async communityFetchAllParticipating(): Promise<{ [_: string]: GroupMetadata }> {
    const out: { [_: string]: GroupMetadata } = {}
    for (const g of this.w.linkedGroups()) if (g.memberJoinedAt !== null && g.kind === 'community') out[g.jid] = this.meta(g)
    return out
  }

  async communityFetchLinkedGroups(jid: string) {
    const subs = this.w.linkedGroups().filter((g) => g.parent === jid)
    return {
      communityJid: jid,
      isCommunity: true,
      linkedGroups: subs.map((g) => ({
        id: g.jid,
        subject: g.subject,
        creation: Math.floor(g.creation / 1000),
        owner: this.adminJid(g),
        size: g.members.length,
      })),
    }
  }

  async end(_error: Error | undefined): Promise<void> {
    this.w.onSocketEnd()
  }

  // ---- emission helpers used by the sandbox world ----

  connection(update: Partial<ConnectionState>) {
    this.ev.emit('connection.update', update)
  }

  close(statusCode: number, message: string) {
    const error = Object.assign(new Error(message), { output: { statusCode, payload: { statusCode, message } } })
    this.connection({ connection: 'close', lastDisconnect: { error, date: new Date() } })
  }

  upsert(messages: WAMessage[], type: 'notify' | 'append' = 'notify') {
    this.ev.emit('messages.upsert', { messages, type })
  }

  history(messages: WAMessage[]) {
    this.ev.emit('messaging-history.set', {
      chats: [],
      contacts: [],
      messages,
      isLatest: true,
      progress: 100,
      syncType: proto.HistorySync.HistorySyncType.RECENT,
    })
    this.ev.emit('messaging-history.status', {
      syncType: proto.HistorySync.HistorySyncType.RECENT,
      status: 'complete',
      explicit: true,
    })
  }

  lidMapping(p: Persona) {
    this.ev.emit('lid-mapping.update', { lid: lidJid(p), pn: pnJid(p) })
  }

  groupsUpsert(g: LinkedGroup) {
    this.ev.emit('groups.upsert', [this.meta(g)])
  }

  participants(g: LinkedGroup, p: Persona, action: 'add' | 'remove') {
    this.ev.emit('group-participants.update', {
      id: g.jid,
      author: this.adminJid(g) ?? lidJid(p),
      participants: [{ id: lidJid(p), lid: lidJid(p), phoneNumber: p.pnInGroups ? pnJid(p) : undefined }],
      action,
    })
  }

  // ---- shape builders ----

  meta(g: LinkedGroup): GroupMetadata {
    return {
      id: g.jid,
      subject: g.subject,
      desc: g.desc,
      owner: this.adminJid(g),
      addressingMode: WAMessageAddressingMode.LID,
      creation: Math.floor(g.creation / 1000),
      linkedParent: g.parent,
      announce: g.announce,
      restrict: true,
      isCommunity: g.kind === 'community',
      isCommunityAnnounce: g.kind === 'community_announce',
      size: g.members.length,
      participants: g.members.map((id) => {
        const p = this.w.persona(id)!
        return {
          id: lidJid(p),
          lid: lidJid(p),
          phoneNumber: p.pnInGroups ? pnJid(p) : undefined,
          admin: g.admins.includes(id) ? ('admin' as const) : null,
        }
      }),
    }
  }

  private adminJid(g: LinkedGroup) {
    const a = this.w.persona(g.admins[0])
    return a ? lidJid(a) : undefined
  }

  key(g: LinkedGroup, id: string, p: Persona): WAMessageKey {
    return {
      remoteJid: g.jid,
      fromMe: false,
      id,
      participant: lidJid(p),
      participantAlt: p.pnInGroups ? pnJid(p) : undefined,
      addressingMode: 'lid',
    }
  }

  /** Builds the WAMessage a real linked device would receive for this simulated event. */
  build(g: LinkedGroup, m: LinkedMsg): WAMessage {
    const p = this.w.persona(m.personaId)!
    const base: WAMessage = {
      key: this.key(g, m.id, p),
      messageTimestamp: Math.floor(m.at / 1000),
      pushName: p.name,
    }
    const target = m.targetId ? g.messages.find((x) => x.id === m.targetId) : undefined
    const targetKey = target ? this.key(g, target.id, this.w.persona(target.personaId)!) : undefined
    switch (m.kind) {
      case 'text':
        return { ...base, message: { conversation: m.text } }
      case 'reply':
        return {
          ...base,
          message: {
            extendedTextMessage: {
              text: m.text,
              contextInfo: target
                ? { stanzaId: target.id, participant: targetKey!.participant, quotedMessage: { conversation: target.text } }
                : undefined,
            },
          },
        }
      case 'ephemeral':
        return { ...base, message: { ephemeralMessage: { message: { extendedTextMessage: { text: m.text } } } } }
      case 'view_once':
        return {
          ...base,
          message: { viewOnceMessageV2: { message: { imageMessage: { caption: m.text, mimetype: 'image/jpeg', viewOnce: true } } } },
        }
      case 'edit':
        return {
          ...base,
          message: {
            protocolMessage: {
              type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
              key: targetKey,
              editedMessage: { conversation: m.text },
            },
          },
        }
      case 'revoke':
        return { ...base, message: { protocolMessage: { type: proto.Message.ProtocolMessage.Type.REVOKE, key: targetKey } } }
      case 'reaction':
        return { ...base, message: { reactionMessage: { key: targetKey, text: m.text, senderTimestampMs: m.at } } }
      case 'stub_add':
        return { ...base, messageStubType: WAMessageStubType.GROUP_PARTICIPANT_ADD, messageStubParameters: [lidJid(p)] }
      case 'stub_leave':
        return { ...base, messageStubType: WAMessageStubType.GROUP_PARTICIPANT_LEAVE, messageStubParameters: [lidJid(p)] }
      case 'ciphertext':
        return { ...base, messageStubType: WAMessageStubType.CIPHERTEXT, messageStubParameters: ['No matching sessions found for message'] }
    }
  }
}
