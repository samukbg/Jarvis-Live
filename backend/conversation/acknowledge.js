// What Jarvis says before handing a task to an agent ("Je m'en occupe : je demande à
// Antigravity."), in the language the user spoke — so a delegated task never starts in silence.

const AGENT_NAMES = {
  agy: 'Antigravity', gemini: 'Antigravity', antigravity: 'Antigravity', nexus: 'Antigravity',
  claude: 'Claude', hermes: 'Hermes', codex: 'Codex',
};

const PHRASES = {
  en: (a) => `On it — I'm asking ${a}.`,
  fr: (a) => `Je m'en occupe : je demande à ${a}.`,
  pt: (a) => `Estou nisso — vou pedir ao ${a}.`,
  es: (a) => `Me encargo: se lo pido a ${a}.`,
  it: (a) => `Ci penso io: chiedo a ${a}.`,
  de: (a) => `Mache ich – ich frage ${a}.`,
};

// Frequent words that mostly belong to one language (accents stripped).
const MARKERS = {
  fr: ['le', 'la', 'les', 'est', 'quelle', 'quel', 'pour', 'demain', "c'est", 'je', 'tu', 'vous', 'avec', 'quoi', 'meteo', 'temperature', 'aujourd', 'du', 'des', 'une', 'et'],
  pt: ['o', 'a', 'os', 'qual', 'para', 'amanha', 'hoje', 'voce', 'tempo', 'temperatura', 'em', 'do', 'da', 'uma', 'e', 'nao', 'com'],
  es: ['el', 'la', 'los', 'cual', 'para', 'manana', 'hoy', 'tiempo', 'temperatura', 'en', 'del', 'una', 'y', 'por', 'favor', 'codigo', 'revisa', 'que'],
  it: ['il', 'la', 'che', 'tempo', 'domani', 'oggi', 'fa', 'per', 'della', 'una', 'e', 'qual', 'temperatura', 'a'],
  de: ['der', 'die', 'das', 'ist', 'wie', 'wetter', 'morgen', 'heute', 'und', 'ich', 'nicht', 'mit'],
  en: ['the', 'is', 'what', "what's", 'weather', 'tomorrow', 'today', 'please', 'and', 'in', 'for', 'how', 'my', 'you'],
};

/** 'fr' | 'pt' | 'es' | 'it' | 'de' | 'en' from the user's words; `fallback` when unsure. */
export function guessLanguage(text, fallback = 'en') {
  const words = String(text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[¿¡?!.,;:()"«»]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 2) return PHRASES[fallback] ? fallback : 'en';
  let best = null;
  let bestScore = 0;
  for (const [lang, markers] of Object.entries(MARKERS)) {
    const set = new Set(markers);
    const score = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
    if (score > bestScore) { best = lang; bestScore = score; }
  }
  return best ?? (PHRASES[fallback] ? fallback : 'en');
}

/** The acknowledgement for handing `userText` to `agentId`. */
export function acknowledgement(agentId, userText = '', fallbackLang = 'en') {
  const id = String(agentId || '').toLowerCase();
  const name = AGENT_NAMES[id] ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'an agent');
  const lang = userText ? guessLanguage(userText, fallbackLang) : (PHRASES[fallbackLang] ? fallbackLang : 'en');
  return PHRASES[lang](name);
}
