import type { Lang } from './voice/engines'

/**
 * The bot's fixed lines in English and Hindi. Hindi is used when the person spoke or wrote Hindi
 * (see Agent.convLang). Button and list ids never change; only their titles are translated.
 */
const EN = {
  consent:
    "Welcome to Northstar! To set up your account we'll save your WhatsApp name and number and the answers you give here. Voice notes you send are turned into text. You're chatting with Northstar's automated assistant.",
  consentYes: 'I agree',
  consentNo: 'No thanks',
  tapToContinue: 'Please tap one of the buttons to continue.',
  didntCatch: 'Sorry, I didn’t catch that.',
  declined: 'No problem, nothing was saved. Send START whenever you want to join.',
  askName: 'Great. What is your full name?',
  nameInvalid: 'Please type your full name (2 to 80 characters).',
  nameInvalidVoice: 'Sorry, I didn’t catch a name. Please say or type your full name.',
  confirmName: 'I heard “{name}”. Is that right?',
  nameYes: 'Yes, that’s right',
  nameNo: 'No, it’s wrong',
  nameRetry: 'Okay. Please type your full name, or say it again.',
  askRole: 'Thanks, {name}. What best describes you?',
  chooseOne: 'Choose one',
  pickRole: 'Please pick an option from the list.',
  askCadence: 'How often should we send you a digest of your groups?',
  daily: 'Daily',
  weekly: 'Weekly',
  never: 'Never',
  pickCadence: 'Please tap Daily, Weekly or Never.',
  done: "You're all set, {name}! Open Northstar with this sign-in link (valid 15 minutes): {link}",
  welcomeBack: 'Welcome back, {name}! Sign in with this link (valid 15 minutes): {link}',
  notMember: "Hi! I'm Northstar's assistant. Send START to create your account, or use the Continue on WhatsApp button in the Northstar app.",
  stopped: "You're unsubscribed from Northstar messages. Send START any time to come back.",
  help: 'Northstar help: send START to create or sign in to your account, STOP to unsubscribe, or just ask a question about Northstar. Voice notes work too.',
  linkAlsoSent: 'I’ve also sent the link as a message.',
  youCanSay: 'You can say: {options}.',
  or: 'or',
  couldntHear: 'Sorry, I couldn’t make out that voice note. Could you say it again, or type it?',
  tooLong: 'That voice note is longer than {seconds} seconds. Please send a shorter one, or type your message.',
  cantListen: 'Sorry, I can’t listen to voice notes right now. Could you type your message?',
  roleFounder: 'Founder',
  roleOperator: 'Operator',
  roleOrganiser: 'Group organiser',
  roleOther: 'Other',
}

const HI: typeof EN = {
  consent:
    'Northstar में आपका स्वागत है! आपका अकाउंट बनाने के लिए हम आपका WhatsApp नाम, नंबर और यहाँ दिए गए जवाब सेव करेंगे। आपके वॉइस नोट टेक्स्ट में बदले जाते हैं। आप Northstar के ऑटोमैटिक असिस्टेंट से बात कर रहे हैं।',
  consentYes: 'मैं सहमत हूँ',
  consentNo: 'नहीं, धन्यवाद',
  tapToContinue: 'आगे बढ़ने के लिए कृपया कोई एक बटन दबाएँ।',
  didntCatch: 'माफ़ कीजिए, समझ नहीं आया।',
  declined: 'कोई बात नहीं, कुछ भी सेव नहीं किया गया। जब भी जुड़ना चाहें, START भेजें।',
  askName: 'बढ़िया। आपका पूरा नाम क्या है?',
  nameInvalid: 'कृपया अपना पूरा नाम लिखें (2 से 80 अक्षर)।',
  nameInvalidVoice: 'माफ़ कीजिए, नाम समझ नहीं आया। कृपया अपना पूरा नाम बोलें या लिखें।',
  confirmName: 'मैंने सुना “{name}”। क्या यह सही है?',
  nameYes: 'हाँ, सही है',
  nameNo: 'नहीं, ग़लत है',
  nameRetry: 'ठीक है। कृपया अपना पूरा नाम लिखें, या फिर से बोलें।',
  askRole: 'धन्यवाद, {name}। आपके लिए कौन-सा विकल्प सबसे सही है?',
  chooseOne: 'एक चुनें',
  pickRole: 'कृपया सूची में से एक विकल्प चुनें।',
  askCadence: 'आपके ग्रुप्स का डाइजेस्ट (सारांश) हम कितनी बार भेजें?',
  daily: 'रोज़',
  weekly: 'हर हफ़्ते',
  never: 'कभी नहीं',
  pickCadence: 'कृपया रोज़, हर हफ़्ते या कभी नहीं चुनें।',
  done: 'सब तैयार है, {name}! इस साइन-इन लिंक से Northstar खोलें (15 मिनट तक मान्य): {link}',
  welcomeBack: 'फिर से स्वागत है, {name}! इस लिंक से साइन इन करें (15 मिनट तक मान्य): {link}',
  notMember: 'नमस्ते! मैं Northstar का असिस्टेंट हूँ। अकाउंट बनाने के लिए START भेजें या बोलें, या Northstar ऐप में "Continue on WhatsApp" बटन इस्तेमाल करें।',
  stopped: 'आपको Northstar के मैसेज से अनसब्सक्राइब कर दिया गया है। वापस आने के लिए कभी भी START भेजें।',
  help: 'Northstar मदद: अकाउंट बनाने या साइन इन करने के लिए START भेजें, अनसब्सक्राइब करने के लिए STOP, या Northstar के बारे में कोई भी सवाल पूछें। वॉइस नोट भी चलेंगे।',
  linkAlsoSent: 'लिंक मैंने मैसेज में भी भेज दिया है।',
  youCanSay: 'आप बोल सकते हैं: {options}।',
  or: 'या',
  couldntHear: 'माफ़ कीजिए, वह वॉइस नोट समझ नहीं आया। क्या आप फिर से बोल सकते हैं, या लिख सकते हैं?',
  tooLong: 'यह वॉइस नोट {seconds} सेकंड से लंबा है। कृपया छोटा वॉइस नोट भेजें, या अपना मैसेज लिखें।',
  cantListen: 'माफ़ कीजिए, अभी मैं वॉइस नोट नहीं सुन पा रहा। क्या आप अपना मैसेज लिख सकते हैं?',
  roleFounder: 'फ़ाउंडर',
  roleOperator: 'ऑपरेटर',
  roleOrganiser: 'ग्रुप ऑर्गनाइज़र',
  roleOther: 'अन्य',
}

/**
 * Telugu: only the lines the voice layer itself says (a note it could not hear, the spoken list of choices).
 * Every other fixed line falls back to English. To be checked by a native speaker before a pilot.
 */
const TE: Partial<typeof EN> = {
  tapToContinue: 'కొనసాగడానికి దయచేసి ఒక బటన్ నొక్కండి.',
  didntCatch: 'క్షమించండి, నాకు అర్థం కాలేదు.',
  linkAlsoSent: 'లింక్‌ను మెసేజ్‌గా కూడా పంపాను.',
  youCanSay: 'మీరు ఇలా చెప్పవచ్చు: {options}.',
  or: 'లేదా',
  couldntHear: 'క్షమించండి, ఆ వాయిస్ నోట్ నాకు అర్థం కాలేదు. మళ్ళీ చెప్పగలరా, లేదా టైప్ చేయగలరా?',
  tooLong: 'ఆ వాయిస్ నోట్ {seconds} సెకన్ల కంటే ఎక్కువగా ఉంది. దయచేసి చిన్నది పంపండి, లేదా మీ మెసేజ్ టైప్ చేయండి.',
  cantListen: 'క్షమించండి, ఇప్పుడు నేను వాయిస్ నోట్లు వినలేకపోతున్నాను. మీ మెసేజ్ టైప్ చేయగలరా?',
}

export type StringKey = keyof typeof EN

export function t(lang: Lang, key: StringKey, vars: Record<string, string | number> = {}): string {
  const s = lang === 'hi' ? HI[key] : lang === 'te' ? (TE[key] ?? EN[key]) : EN[key]
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''))
}

/** "You can say: Daily, Weekly, or Never." in the person's language. */
export function youCanSay(lang: Lang, options: string[]): string {
  const list = options.length > 1 ? `${options.slice(0, -1).join(', ')}, ${t(lang, 'or')} ${options[options.length - 1]}` : options.join('')
  return t(lang, 'youCanSay', { options: list })
}
