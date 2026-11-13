import type { BaileysEventEmitter, WASocket } from 'baileys'

/**
 * The slice of a Baileys v7 socket the agent depends on. Every member is typed by indexing
 * into Baileys' own `WASocket`, so the sandbox's fake socket and a real `makeWASocket()`
 * socket are interchangeable, and a Baileys upgrade that changes this surface fails `tsc`.
 */
export interface LinkedSocket {
  ev: BaileysEventEmitter
  groupMetadata: WASocket['groupMetadata']
  groupFetchAllParticipating: WASocket['groupFetchAllParticipating']
  communityFetchAllParticipating: WASocket['communityFetchAllParticipating']
  communityFetchLinkedGroups: WASocket['communityFetchLinkedGroups']
  signalRepository: { lidMapping: { getPNForLID(lid: string): Promise<string | null> } }
  end: WASocket['end']
}

/** Compile-time proof that a real Baileys socket satisfies the contract. */
type Assert<T extends true> = T
export type _RealSocketFitsContract = Assert<WASocket extends LinkedSocket ? true : false>

/** Factory used by the agent's runner; called again after a 515 restartRequired. */
export type LinkedSocketFactory = () => Promise<LinkedSocket>

export const statusCodeOf = (err: unknown): number | undefined =>
  (err as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
