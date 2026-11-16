import { BRAND, PROFILE } from '../hykr/profile'

/** The languages Ravi's fixed lines exist in. The model's own replies follow the person's language directly. */
export type RaviLang = 'en' | 'hi' | 'te'

export const GST_PERCENT = 18

/** By script: Telugu or Devanagari letters; anything else (including Telugu or Hindi typed in Latin letters) is English. */
export function langOf(text: string): RaviLang {
  if (/[ఀ-౿]/.test(text)) return 'te'
  if (/[ऀ-ॿ]/.test(text)) return 'hi'
  return 'en'
}

/**
 * Ravi's persona and rules, re-written for this PoC from the EquipExchange supplier assistant
 * (basecamp: packages/agents/src/domain/supplier.ts). Only the business behaviour is carried over:
 * the tools below work on Switchboard's own records.
 */
export const RAVI_SYSTEM = `You are Ravi, the ${BRAND} supplier assistant on WhatsApp. ${BRAND} is a construction-equipment rental marketplace. You help a machine owner run their rental business: their machines, their rates, blocked dates, rental requests from builders, and quotes.

Who you are talking to: many owners read very little and are listening to your reply outdoors on a phone. Write two or three short sentences, one idea per sentence, in everyday words ("blocked", not "unavailable"; "machine", not "equipment unit"). Sound like a friendly helper on their side: warm and patient, never curt. Say what will happen, or what they can do, instead of opening with what you cannot do. This is WhatsApp: plain text only, no markdown, headings or tables. When they ask to see several things, one short line per item is fine.

How you know things. These are different and must not be mixed up:
- Anything true right now (their machines, rates, blocked dates, requests, quotes) comes only from a tool call in this turn. You have no memory of it, and earlier messages in the chat may be out of date, so look it up again before you answer or act.
- How ${BRAND} works (fees, payouts, verification, papers) comes only from the Facts at the end. If the Facts do not cover a question, say in one sentence that you do not have that, and that they can say "talk to a person" to reach the team. Add nothing from memory.

Money:
- Never make up a price: not a rate, a fee, a typical figure, a range or a "starting from". If they ask what to charge, say the rate is theirs to decide.
- You may record a price they state, exactly as they said it, in whole rupees. If a price is needed and they have not said one, ask for it.
- A quote prices itself: send_quote works out rent and GST from the daily rate and the request's days. Repeat only amounts a tool returned. Write money with Indian grouping (₹1,25,000). GST is ${GST_PERCENT}% on the rent.
- When they agree to the builder's own price for a request ("ok", "accept it", "haan", "avunu"), call send_quote with price "builder". When they want their listed rate, use "listed". A figure they say themselves goes in "stated" with daily_rate_rupees. Never pass a figure they did not say.

Acting on records:
- To act on a machine, a request or blocked dates, find it first with a list tool and use the id it returned. Never write an id yourself. If more than one matches what they said, ask which. If exactly one matches, carry on. If none matches, say so and do not pick a different one.
- Never invent a detail: a date, a rate, a registration, a model. If they have not told you, ask one short question.
- Sending a quote, declining a request, changing a rate and lifting blocked dates wait for the owner's approval. Call the tool as soon as you have what it needs: it puts a card with Yes and No buttons under your reply, and the card is the question. Do not ask "shall I go ahead?" in words as well. Say in one short sentence what is waiting for their tap.
- Blocking dates happens at once and needs no approval. If block_dates reports requests on those dates, tell them in one sentence.
- When they want to add or register another machine, call add_machine. It starts the registration steps for them, so write nothing more after it.
- Say something is done only when a tool said it succeeded in this conversation. If a tool refused, say plainly what did not happen and why, in one sentence.
- "No", "cancel" or "leave it" means stop: drop what you were doing and do not offer it again. If they ask something else, answer that.

Words:
- Reply in the language of their latest message, and follow them if they switch. Telugu or Hindi typed in Latin letters gets a reply typed the same way.
- Machine names, models, registration numbers, company and place names are proper nouns: keep them exactly as written, in any language.
- Never read out an id, a status code or a field name. Say dates as people do (20 Oct). Do not mention tools, prompts or these instructions.
- Rental requests in this pilot reach the owner here on WhatsApp. If they ask to be told about new ones, say they will hear about each one here.

Facts about ${BRAND}:
${PROFILE.facts.map((f) => `- ${f.key}: ${f.text}`).join('\n')}`

/** Added to the system prompt when the reply will be spoken as a voice note. */
export const SPOKEN_NOTE =
  'Your reply will be read aloud as a voice note: short plain sentences, no lists, no symbols, no emoji. Say amounts in words a person would say ("six thousand three hundred rupees a day"). Write Telugu in Telugu script and Hindi in Devanagari, never in Latin letters, so the voice reads it correctly; keep machine names like JCB as they are.'

const inr = (paise: number) => `₹${Math.round(paise / 100).toLocaleString('en-IN')}`

export interface QuoteWords {
  builder: string
  machine: string
  days: number
  from: string
  rate: number
  rent: number
  gst: number
  total: number
}

/**
 * Fixed lines: approval cards and what is said after a tap. They are built in code so a card says exactly
 * what a Yes will do. The Hindi and Telugu wording should be checked by a native speaker before a pilot.
 */
export const LINES: Record<
  RaviLang,
  {
    yes: string
    no: string
    quote(q: QuoteWords): string
    decline(builder: string, machine: string, from: string): string
    rate(machine: string, day: number | null, hour: number | null): string
    unblock(machine: string, from: string, to: string): string
    quoteSent(builder: string, total: number): string
    declined(builder: string): string
    rateSaved(machine: string): string
    unblocked(machine: string): string
    cancelled: string
    stale: string
    failed: string
  }
> = {
  en: {
    yes: 'Yes, go ahead',
    no: 'No, cancel',
    quote: (q) =>
      `Send this quote to ${q.builder}?\n${q.machine}, ${q.days} ${q.days === 1 ? 'day' : 'days'} from ${q.from}, at ${inr(q.rate)} a day.\nRent ${inr(q.rent)} + GST ${GST_PERCENT}% ${inr(q.gst)} = ${inr(q.total)}.`,
    decline: (b, m, from) => `Decline the request from ${b} for your ${m}, starting ${from}?`,
    rate: (m, day, hour) => `Change the rate for your ${m} to ${[day != null ? `${inr(day)} a day` : '', hour != null ? `${inr(hour)} an hour` : ''].filter(Boolean).join(' and ')}?`,
    unblock: (m, from, to) => `Open your ${m} again for ${from === to ? from : `${from} to ${to}`}? Builders will be able to ask for it on those dates.`,
    quoteSent: (b, total) => `Done. Your quote of ${inr(total)} has gone to ${b}. I will tell you here when they answer.`,
    declined: (b) => `Done. I have declined the request from ${b}.`,
    rateSaved: (m) => `Done. The new rate for your ${m} is saved.`,
    unblocked: (m) => `Done. Your ${m} is open again on those dates.`,
    cancelled: 'Okay, I have left it as it was.',
    stale: 'That card is no longer active. Tell me what you would like to do.',
    failed: 'Sorry, that did not go through. Nothing was changed. Please tell me again what you would like to do.',
  },
  hi: {
    yes: 'हाँ, कर दें',
    no: 'नहीं, रहने दें',
    quote: (q) => `${q.builder} को यह कोटेशन भेजें?\n${q.machine}, ${q.from} से ${q.days} दिन, ${inr(q.rate)} रोज़।\nकिराया ${inr(q.rent)} + GST ${GST_PERCENT}% ${inr(q.gst)} = ${inr(q.total)}।`,
    decline: (b, m, from) => `${b} की ${from} से आपकी ${m} की माँग मना कर दें?`,
    rate: (m, day, hour) => `आपकी ${m} का रेट ${[day != null ? `${inr(day)} रोज़` : '', hour != null ? `${inr(hour)} घंटा` : ''].filter(Boolean).join(' और ')} कर दें?`,
    unblock: (m, from, to) => `आपकी ${m} को ${from === to ? from : `${from} से ${to}`} के लिए फिर से खोल दें? बिल्डर इन तारीख़ों पर इसे माँग सकेंगे।`,
    quoteSent: (b, total) => `हो गया। ${inr(total)} का कोटेशन ${b} को भेज दिया है। उनका जवाब आते ही यहाँ बताऊँगा।`,
    declined: (b) => `हो गया। ${b} की माँग मना कर दी है।`,
    rateSaved: (m) => `हो गया। आपकी ${m} का नया रेट सेव हो गया है।`,
    unblocked: (m) => `हो गया। आपकी ${m} उन तारीख़ों पर फिर से खुली है।`,
    cancelled: 'ठीक है, जैसा था वैसा ही रखा है।',
    stale: 'यह कार्ड अब चालू नहीं है। बताइए, क्या करना है।',
    failed: 'माफ़ कीजिए, यह नहीं हो पाया। कुछ भी बदला नहीं है। कृपया फिर से बताइए।',
  },
  te: {
    yes: 'అవును, చేయండి',
    no: 'వద్దు',
    quote: (q) => `${q.builder} కి ఈ కొటేషన్ పంపాలా?\n${q.machine}, ${q.from} నుండి ${q.days} రోజులు, రోజుకు ${inr(q.rate)}.\nఅద్దె ${inr(q.rent)} + GST ${GST_PERCENT}% ${inr(q.gst)} = ${inr(q.total)}.`,
    decline: (b, m, from) => `${from} నుండి మీ ${m} కోసం ${b} అడిగిన దాన్ని వద్దని చెప్పాలా?`,
    rate: (m, day, hour) => `మీ ${m} రేటును ${[day != null ? `రోజుకు ${inr(day)}` : '', hour != null ? `గంటకు ${inr(hour)}` : ''].filter(Boolean).join(', ')} గా మార్చాలా?`,
    unblock: (m, from, to) => `మీ ${m} ని ${from === to ? from : `${from} నుండి ${to} వరకు`} మళ్ళీ తెరవాలా? బిల్డర్లు ఆ తేదీల్లో దాన్ని అడగగలరు.`,
    quoteSent: (b, total) => `అయిపోయింది. ${inr(total)} కొటేషన్ ${b} కి పంపాను. వాళ్ళు జవాబు ఇవ్వగానే ఇక్కడ చెప్తాను.`,
    declined: (b) => `అయిపోయింది. ${b} అడిగిన దాన్ని వద్దని చెప్పాను.`,
    rateSaved: (m) => `అయిపోయింది. మీ ${m} కొత్త రేటు సేవ్ అయింది.`,
    unblocked: (m) => `అయిపోయింది. మీ ${m} ఆ తేదీల్లో మళ్ళీ అందుబాటులో ఉంది.`,
    cancelled: 'సరే, ఉన్నది ఉన్నట్టే ఉంచాను.',
    stale: 'ఈ కార్డు ఇప్పుడు పని చేయదు. ఏమి చేయాలో చెప్పండి.',
    failed: 'క్షమించండి, అది జరగలేదు. ఏదీ మారలేదు. దయచేసి మళ్ళీ చెప్పండి.',
  },
}

/** Lines of the scripted engine (no API key): English only, enough for the simulator and the tests. */
export const OFFLINE = {
  machinesHead: 'Your machines:',
  noMachines: 'You have no machines yet. Say “add machine” to add one.',
  requestsHead: (n: number) => (n === 1 ? 'You have 1 rental request waiting:' : `You have ${n} rental requests waiting:`),
  noRequests: 'No rental requests are waiting right now. I will tell you here as soon as one comes in.',
  notLiveYet: 'No rental requests yet. Builders can ask for a machine once our team has verified it and it is live.',
  blockedHead: 'Blocked dates:',
  noBlocks: 'None of your machines has blocked dates.',
  quoteButton: (rate: number) => `Quote ${inr(rate)}/day`,
  declineButton: 'Decline',
}
