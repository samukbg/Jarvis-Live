// "Jarvis" said on its own (calling it before asking) or in front of a request. With Gemini Live
// off every utterance goes to an agent, so a lone "Jarvis" used to start a whole agent run
// ("On it — I'm asking Antigravity.") before the real question became a second one.
import { languageCode } from '../tts/systemVoice.js';

// Speech recognisers write the name many ways: Jarvis, Javis, Jervis, Jarvas, Jarvis Live.
const WAKE = /^\s*(?:(?:hey|hi|hello|ok|okay|yo|oi|ol[aá]|salut|bonjour|hola|ciao|hallo)[\s,]+)?(?:j[ae]r?v[aeiy]s)(?:\s+live)?(?=$|[\s,.!?;:—–-])[\s,.!?;:—–-]*/iu;

/** { called, rest }: whether the text starts with the wake word, and what follows it. */
export function stripWakeWord(text) {
  const s = String(text || '');
  const m = s.match(WAKE);
  if (!m) return { called: false, rest: s.trim() };
  return { called: true, rest: s.slice(m[0].length).trim() };
}

const REPLIES = {
  en: 'Yes, sir?',
  fr: 'Oui, monsieur ?',
  pt: 'Sim, senhor?',
  es: '¿Sí, señor?',
  it: 'Sì, signore?',
  de: 'Ja, Sir?',
};

/** What Jarvis says when only called by name, in the user's language. */
export function wakeReply(language) {
  return REPLIES[languageCode(language)] || REPLIES.en;
}
