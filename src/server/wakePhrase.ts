// "Hey Jarvis": does a short transcript start by calling Jarvis, and what follows? Shared by the
// web/desktop wake listener (Moonshine transcripts) and the phone's (the system's on-device
// recognizer); mobile-app/src/server/wakePhrase.ts is an identical copy. Same names as the
// server's wake word (backend/conversation/wakeWord.js), plus what small speech models hear
// when someone says "Jarvis" ("Travis", "Service", "Charvis"…), but only right at the start —
// "I told Travis" never wakes it.

const GREETING = '(?:hey|hi|hello|ok|okay|yo|oi|ola|olá|salut|bonjour|hola|ciao|hallo|e ai|e aí)';
const NAME = '(?:j[ae]r?v[aeiy]s|jervis|javis|jarvi|charvis|jarbas|jarviz|jarvis live)';
// Mishearings only count after a greeting ("Hey Travis" — not "Travis" alone).
const NAME_AFTER_GREETING = `(?:${NAME}|travis|harvis|service|jarwis|davis)`;

const SEP = '[\\s,.!?;:—–-]';
const RE = new RegExp(`^${SEP}*(?:${GREETING}${SEP}+${NAME_AFTER_GREETING}|${NAME})(?=$|${SEP})${SEP}*`, 'iu');

export interface WakeMatch {
  /** What was said after the name ("what's the weather"), '' when only the name. */
  rest: string;
}

/** The transcript calls Jarvis → { rest }, else null. */
export function matchWakePhrase(transcript: string): WakeMatch | null {
  const s = String(transcript || '').normalize('NFC').trim();
  if (!s || s.length > 200) return null;
  const m = RE.exec(s);
  if (!m) return null;
  return { rest: s.slice(m[0].length).trim() };
}
