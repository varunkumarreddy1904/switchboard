/** One inbound 1:1 message, as the business logic (the "brain") sees it. */
export interface InboundMedia {
  id: string
  mime: string
  kind: 'image' | 'document' | 'video'
  caption?: string
  filename?: string
  sha256?: string
}

export interface InboundDm {
  channelId: string
  personId: string
  /** 'voice' = a voice note; `text` is then its transcript. */
  type: 'text' | 'voice' | 'button_reply' | 'list_reply' | 'button' | 'image' | 'document' | 'video' | 'location' | 'contacts' | 'other'
  text: string
  replyId?: string
  media?: InboundMedia
  location?: { lat: number; lng: number; name?: string; address?: string }
  contacts?: { name: string; phone: string }[]
  /** The stored inbox message, so the brain can attach evidence to it. */
  messageId?: string
  /** Meta's message id (wamid). */
  wamid?: string
}

/** The business logic plugged into Switchboard. Switchboard handles WhatsApp; the brain decides what to say. */
export interface Brain {
  handle(m: InboundDm): Promise<void>
}
