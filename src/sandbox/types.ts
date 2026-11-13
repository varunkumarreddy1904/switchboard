import type { LinkedGroupKind, Persona } from './seed'

export type Status = 'accepted' | 'sent' | 'delivered' | 'read' | 'failed'

export interface Button {
  id: string
  title: string
  kind: 'reply' | 'quick_reply' | 'copy_code' | 'join_group' | 'url'
  value?: string
}

export interface ListRow {
  id: string
  title: string
  description?: string
}

/** A message in a persona's 1:1 chat with the business, or in a Cloud API group. */
export interface DmMessage {
  id: string
  personaId: string
  from: 'persona' | 'business'
  at: number
  kind: 'text' | 'template' | 'interactive' | 'reply' | 'system' | 'audio' | 'image' | 'location' | 'contacts'
  text: string
  /** Voice notes / audio: the sandbox media id (play it from /sandbox/api/media/:id). */
  audio?: { mediaId: string; voice: boolean; seconds: number | null }
  /** What the persona said in a simulated voice note (the phone shows it; the agent must transcribe). */
  spoken?: string
  /** Photos a persona sends (a synthetic fixture). */
  image?: { mediaId: string; file: string; caption?: string }
  location?: { lat: number; lng: number; name?: string }
  contact?: { name: string; phone: string }
  /** Persona messages: the business sent a read receipt (blue ticks). */
  readByBusiness?: boolean
  header?: string
  footer?: string
  buttons?: Button[]
  list?: { button: string; sections: { title?: string; rows: ListRow[] }[] }
  templateName?: string
  status?: Status
  error?: { code: number; title: string; details?: string }
  pricing?: string
  contextId?: string
  tapped?: string
}

export interface ApiGroup {
  id: string
  subject: string
  description?: string
  inviteCode: string
  participants: string[]
  createdAt: number
  requestId: string
  joinApprovalMode: string
  rejected: { personaId: string; at: number; reason: string }[]
  messages: DmMessage[]
  lastInboundAt: number | null
}

export type LinkedMsgKind =
  | 'text'
  | 'reply'
  | 'ephemeral'
  | 'view_once'
  | 'edit'
  | 'revoke'
  | 'reaction'
  | 'stub_add'
  | 'stub_leave'
  | 'ciphertext'

export interface LinkedMsg {
  id: string
  jid: string
  personaId: string
  at: number
  kind: LinkedMsgKind
  text: string
  targetId?: string
  /** For UI: state after edits / deletes / reactions are applied. */
  editedText?: string
  deleted?: boolean
  reactions: Record<string, string>
}

export interface LinkedGroup {
  jid: string
  subject: string
  desc: string
  kind: LinkedGroupKind
  parent?: string
  announce: boolean
  admins: string[]
  members: string[]
  creation: number
  /** When the member number joined; it sees only messages from this point on. null = not a member. */
  memberJoinedAt: number | null
  messages: LinkedMsg[]
}

export type LinkedDeviceState = 'unlinked' | 'awaiting_scan' | 'paired_restart' | 'open' | 'logged_out'

export interface LinkedWorld {
  persona(id: string): Persona | undefined
  personaByLid(lid: string): Persona | undefined
  linkedGroup(jid: string): LinkedGroup | undefined
  linkedGroups(): LinkedGroup[]
  /** Which LID→PN mappings the member device "knows" (participantAlt / lid-mapping.update). */
  knownPnForLid(lid: string): string | null
  onSocketConnect(): void
  onSocketEnd(): void
}
