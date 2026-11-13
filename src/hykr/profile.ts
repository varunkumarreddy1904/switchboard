import type { BusinessProfile } from '../agent/llm'

/**
 * EquipXchange (HYKR): what the WhatsApp assistant may say. Numbers are the drafts from the Pilot Product
 * Design Session Kit and the PoC review pack (fee, payout timing, referral); change them here, never in
 * prompts or code, until the rules engine (#23) owns them.
 */
export const BRAND = 'EquipXchange'

export const PROFILE: BusinessProfile = {
  name: BRAND,
  assistant: `You are ${BRAND}'s assistant on WhatsApp. ${BRAND} helps owners of construction machines (backhoe loaders / JCBs, excavators, breakers, tippers) in Warangal, Hanamkonda and Kazipet get work from nearby contractors. You are helping a machine owner register.`,
  scope: `${BRAND}, registering an owner and their machines, and how jobs and payouts work`,
  facts: [
    {
      key: 'what we do',
      text: `${BRAND} finds work for your machines from contractors near you. You get job offers here on WhatsApp and reply yes or no. You are paid by UPI the same evening the job's hours are confirmed.`,
      words: /\b(what is|what do you|how does (this|it) work|equipxchange|about you)\b/i,
    },
    {
      key: 'fee',
      text: 'Launch offer: no platform fee for your first 30 days. After that a small fee (about 9%) is taken from the owner’s side of each job. You always see your earnings before you accept an offer.',
      words: /\b(fee|fees|commission|charge|charges|cost|costs|how much do you take|cut)\b/i,
    },
    {
      key: 'payout',
      text: 'You are paid by UPI the same evening the customer confirms the hours. We set up your payout details before your first job.',
      words: /\b(pay|paid|payment|payout|money|upi|when do i get)\b/i,
    },
    {
      key: 'verification',
      text: 'Our team checks your machine and papers within 24 hours. You get a message here as soon as it is verified and live.',
      words: /\b(verify|verified|verification|check|how long|when.*live)\b/i,
    },
    {
      key: 'papers',
      text: 'We need photos of the RC (or the purchase invoice if the machine is not registered), the insurance, the PIN plate and the hour meter. We use them only to check the machine, and we never share them with customers.',
      words: /\b(why.*(rc|papers|documents|photos)|papers|documents|share my|privacy|safe)\b/i,
    },
    {
      key: 'pin plate',
      text: 'The PIN plate is the metal plate on the machine’s frame with a 17-character Product Identification Number. On a backhoe it is usually near the front, on the right side of the frame.',
      words: /\b(pin plate|pin number|what is (a |the )?pin)\b/i,
    },
    {
      key: 'hour meter',
      text: 'The hour meter shows how many hours the engine has run. A photo of it at the start and end of each job is how hours are agreed.',
      words: /\b(hour meter|hours meter|meter)\b/i,
    },
    {
      key: 'jobs',
      text: 'Contractors ask for a machine by voice note. We send you an offer with the place, time, hours and your earnings; you reply yes or no. The customer pays an advance before the job.',
      words: /\b(jobs?|work|offers?|customers?|contractors?)\b/i,
    },
    { key: 'referral', text: 'Refer another owner: you get ₹500 when they complete their first job.', words: /\b(refer|referral|friend)\b/i },
    {
      key: 'support',
      text: 'Say "talk to a person" any time to reach our team (7 am to 9 pm). Send STOP to stop messages, or HELP for help.',
      words: /\b(help|support|person|human|call me|contact)\b/i,
    },
  ],
  outOfScope: `I can help with registering your machines and how ${BRAND} works. Say "talk to a person" to reach our team.`,
}

/** Words speech-to-text should expect: brand, machine and place names. */
export const VOCABULARY = `${BRAND}, JCB, backhoe loader, excavator, Poclain, breaker, tipper, roller, RC, PIN plate, hour meter, insurance, invoice, Hanamkonda, Kazipet, Warangal, diesel, rupees, per hour, per day, kilometres.`
