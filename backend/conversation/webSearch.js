// A web search for live voices that have none built in (OpenAI Realtime): the facts of an answer
// (weather, news, prices, scores…) in a few sentences. With a Gemini key, Gemini grounded on
// Google Search (fast, and free within the key's tier); else OpenAI's web search with the
// OpenAI key the voice uses.
const GEMINI_SEARCH_MODEL = 'gemini-2.5-flash';
const OPENAI_SEARCH_MODEL = 'gpt-4.1-mini';
const TIMEOUT_MS = 20_000;

const prompt = (query) => `Search the web and answer for a voice assistant, in 1-3 short sentences, with the facts that matter (numbers with units, place, date, source name). Today is ${new Date().toDateString()}.\n\nQuestion: ${query}`;

/** Whether webSearch can run here: it needs a Gemini or an OpenAI key (LFM users often have neither). */
export function webSearchAvailable({ geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY, openaiKey = process.env.OPENAI_API_KEY } = {}) {
  return !!(geminiKey || openaiKey);
}

/** The answer to `query` as plain text; throws when no search is available or it fails. */
export async function webSearch(query, { geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY, openaiKey = process.env.OPENAI_API_KEY, fetchImpl = fetch } = {}) {
  const q = String(query || '').trim().slice(0, 500);
  if (!q) throw new Error('Nothing to search for.');
  if (geminiKey) {
    const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_SEARCH_MODEL || GEMINI_SEARCH_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': geminiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt(q) }] }], tools: [{ google_search: {} }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `Gemini search: HTTP ${res.status}`);
    const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
    if (text) return text;
    throw new Error('Gemini search returned nothing.');
  }
  if (openaiKey) {
    const res = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${openaiKey}` },
      body: JSON.stringify({ model: process.env.OPENAI_SEARCH_MODEL || OPENAI_SEARCH_MODEL, tools: [{ type: 'web_search' }], input: prompt(q) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || `OpenAI search: HTTP ${res.status}`);
    const text = (data.output_text || (data.output || [])
      .flatMap((o) => o.content || [])
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text)
      .join('')).trim();
    if (text) return text;
    throw new Error('OpenAI search returned nothing.');
  }
  throw new Error('No web search available (no Gemini or OpenAI API key).');
}
