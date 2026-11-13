import { BRAND } from './profile'

/**
 * Everything the bot says, in one place, so wording can change without touching the flow (UJ owns it).
 * English first. Consent texts C1 and C2 are the shared kit's wording (section 7.1); their version is
 * stored on every consent record.
 * Lines without {placeholders} are pre-spoken once and reused as voice notes.
 */
export const CONSENT_VERSION = { C1: 'C1-en-v1', C2: 'C2-en-v1' } as const

export const COPY = {
  welcome: `Welcome to ${BRAND}! We find work for your machines from contractors near you, and pay you the same day. Signing up takes about 5 minutes, right here on WhatsApp. You can type, tap the buttons, or send voice notes.`,
  c1: 'To list your machine, we need your name, mobile number and village. We use these only to find work for you. Do you agree? Send STOP at any time to stop.',
  c1Yes: 'Yes, I agree',
  c1No: 'No',
  declined: 'No problem, nothing has been saved. Send START whenever you want to join.',
  didntCatch: 'Sorry, I didn’t catch that.',

  askName: 'What is your full name?',
  nameHeard: 'I heard “{name}”. Is that right?',
  nameRetry: 'Okay, please type your full name.',
  nameInvalid: 'Please send just your full name.',
  askVillage: 'Which village or town is your machine based in?',
  villageHeard: 'I heard “{village}”. Is that right?',
  villageRetry: 'Okay, please type the village or town name.',
  yesRight: 'Yes, that’s right',
  noChange: 'No, change it',
  askRole: 'Do you drive the machine yourself, or do you have an operator?',
  roleSelf: 'I drive it myself',
  roleOperator: 'I have an operator',
  profileDone: 'Thanks, {name}! Now let’s add your machine.',

  c2: 'To verify your machine, please send photos of the RC (or the invoice if it is not registered), the insurance and the machine’s number plate (PIN plate). We use these only to check the machine and its papers, and we do not share them with customers. Do you agree?',
  c2Yes: 'Yes, I agree',
  c2No: 'Not now',
  c2Declined: 'Okay. Your listing stays as a draft: without papers we can’t verify your machine or send you work. When you are ready, send PAPERS.',

  askClass: 'What type of machine is it?',
  classButton: 'Choose type',
  askClassOther: 'What kind of machine is it? For example: roller, crane or grader.',
  askMachinePhoto: 'Send a clear photo of the whole machine. Tap the 📎 clip, then Camera.',
  askRc: 'Now a photo of the RC (registration certificate). No RC? Tap “No RC”.',
  noRc: 'No RC',
  askInvoice: 'Do you have the purchase invoice? Send a photo of it, or tap “No invoice”.',
  noInvoice: 'No invoice',
  noPapersNote: 'Okay. Our team will need to see the machine in person, and will call you to arrange it.',
  askInsurance: 'Send a photo of the insurance paper.',
  later: 'Send later',
  askPin: 'Send a photo of the PIN plate: the metal plate on the frame with a 17-character number.',
  cantFind: 'Can’t find it',
  askHours: 'Send a photo of the hour meter, so we have today’s reading.',
  skip: 'Skip',
  askLocation: 'Where is the machine usually parked? Share the location: tap the 📎 clip, then Location, then “Send your current location”.',
  laterShort: 'Later',
  askVideo: 'Last one, and optional: send a short video walking around the machine, and say today’s code word: {code}.',
  mediaHint: 'Please send a photo. Tap the 📎 clip, then Camera. Or tap a button.',
  blurry: 'That photo is hard to read. Please send a clearer photo of the {expected}, in good light.',
  locationHint: 'Please share the location: tap the 📎 clip, then Location. Or type the place name.',
  wrongPhoto: 'That photo looks like {seen}, not the {expected}. Please send the {expected}.',

  detailsRead: 'From your papers I read: {details}. Is that right?',
  detailsOk: 'Yes, correct',
  detailsFix: 'Something’s wrong',
  askFixField: 'What should I change?',
  fixButton: 'Choose',
  askMakeModel: 'What is the make and model? For example: JCB 3DX.',
  askYear: 'Which year was it made?',
  askRegNo: 'What is the registration number? For example: TS 03 AB 1234.',
  askPinNo: 'What is the PIN, the 17 characters on the PIN plate?',
  insuranceExpired: 'Your insurance looks expired ({date}). We can still list the machine, but it can’t go on jobs until the insurance is renewed.',

  rcName: 'The RC is in the name of {rcName}. Who is that?',
  relMe: 'That’s me',
  relFamily: 'Family member',
  relOther: 'Someone else',
  askRelProof: 'Please send a photo of a document that shows the relationship, like a ration card. Or tap “Send later”.',
  relOtherNote: 'Thanks. Our team will check who owns the machine before it goes live.',

  askRateHour: 'What is your lowest rate per hour, with the operator? For example: 900.',
  rateHeard: '₹{amount} per hour. Is that right?',
  rateInvalid: 'Please send the rate as a number of rupees, for example 900.',
  askRateDay: 'And your lowest rate for a full day (8 hours)?',
  hourlyOnly: 'Hourly only',
  askDiesel: 'Who provides the diesel?',
  dieselOwner: 'I provide it',
  dieselCustomer: 'Customer provides',
  askRadius: 'How far will you travel for a job?',
  radius10: 'Up to 10 km',
  radius25: 'Up to 25 km',
  radius50: 'Up to 50 km',

  summaryAsk: 'Submit it for checking?',
  submit: 'Submit',
  change: 'Change something',
  editWhat: 'What would you like to change?',
  submitted: 'Submitted ✅ Our team will check your machine within 24 hours and message you here.',
  anythingElse: 'Anything else?',
  moreMachine: 'Add another machine',
  moreManager: 'Add a manager',
  moreDone: 'I’m done',
  allDone: 'You’re all set, {name}! We’ll message you as soon as your machine is verified.',
  appLink: 'You can also see your machines in the {brand} app: {link}',

  verified: 'Good news! ✅ Your {machine} is verified and live. You’ll get job offers here.',
  needsInfo: 'We need one more thing for your {machine}: {what}. Please send it here.',
  needsInfoThanks: 'Thanks! We’ve sent it to our team.',
  rejected: 'Sorry, we couldn’t verify your {machine}: {reason}. Reply here, or say “talk to a person” if you have questions.',

  welcomeBack: 'Welcome back, {name}! Let’s continue where you left off.',
  reminder: 'Just checking in, we’re nearly there.',
  help: `${BRAND} helps you get work for your machines. You can type, tap or send voice notes. Send STATUS to see your machines, “add machine” to add another, “add driver” to tell us who drives, “talk to a person” to reach our team, or STOP to stop messages.`,
  stopped: 'You asked to stop. We have stopped using your details. Past records are kept only as the law requires. Send START to come back.',
  handoff: 'Okay, I’m connecting you to our team. Someone will reply here soon (7 am to 9 pm).',
  noMachines: 'You have no machines yet. Say “add machine” to add one.',
  registeredHint: 'You’re registered. Send STATUS to see your machines, “add machine” to add another, or ask me anything.',
  pausedHint: 'You stopped messages from us. Send START to come back.',
  delegateDone: 'Thanks! The owner will get a message when each machine is verified.',

  askManager: 'Send your manager’s WhatsApp number, or share their contact (📎 clip, then Contact).',
  managerInvalid: 'Please send a WhatsApp number, like +91 90000 00000.',
  managerAdded: 'Done. {who} can now add machines for you. They just need to message this number.',
  managerHello: 'Hi! You’re managing machines for {owner}. Let’s add a machine.',

  askDriver: 'Who drives your machine? Share their contact (📎 clip, then Contact), or type their name and number. They get the job details on WhatsApp the evening before.',
  driverSkip: 'Skip for now',
  driverInvalid: 'Please share the driver’s contact, or type their name and number, like Ramesh 90000 00000.',
  driverAdded: 'Thanks. {who} is down as the driver.',
  driverLater: 'Okay. Send “add driver” any time. We can’t send job offers until we know who drives.',

  mitraHello: 'Hi {name}! You’re registered as an {brand} Mitra. Do you want to register an owner?',
  mitraNew: 'Register an owner',
  mitraAskName: 'What is the owner’s full name?',
  mitraAskPhone: 'What is the owner’s WhatsApp number?',
  mitraAskVillage: 'Which village or town is the owner in?',
  mitraAskForm: 'Please send a photo of the signed consent form.',
  mitraOwnerCreated: 'Thanks. {owner} is registered, with consent from the paper form. Now let’s add the machine.',
  mitraDone: 'Done! We’ve sent {owner} a WhatsApp message to confirm.',
  ownerConfirm: 'Hi {owner}, {mitra} registered you and your machine on {brand} using a paper form. Is that right?',
  ownerConfirmYes: 'Yes, that’s right',
  ownerConfirmNo: 'No, it’s wrong',
  ownerConfirmed: 'Thank you! You’re registered. We’ll message you when your machine is verified.',
  ownerDenied: 'Thanks for telling us. We’ve paused this registration and our team will look into it.',
}

export type CopyKey = keyof typeof COPY

export function say(key: CopyKey, vars: Record<string, string | number> = {}): string {
  return COPY[key].replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? (k === 'brand' ? BRAND : '')))
}

/** Lines with no personal data or variables: safe to pre-speak once and reuse. */
export const staticLines = () => Object.values(COPY).filter((l) => !l.includes('{'))

/** Daily code word for the walkaround video: proves the video was recorded today, by this owner. */
export function codeWord(date = new Date()) {
  const words = ['MANGO', 'RIVER', 'TIGER', 'LOTUS', 'COPPER', 'MONSOON', 'PEACOCK', 'BANYAN', 'COCONUT', 'SAPPHIRE']
  const day = Math.floor((date.getTime() + 5.5 * 3_600_000) / 86_400_000)
  return `${words[day % words.length]} ${10 + (day % 89)}`
}
