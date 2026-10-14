// Whether a recognised phrase is Jarvis hearing itself: most of its words are in what Jarvis
// just said. Timing alone dropped real requests — "Jarvis" → "Yes, sir?" → the question asked
// right away was thrown away as echo while the reply was (by its length) still playing.
const words = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\d]+/gu) || [];

export function isEchoOf(heard, spokenTexts) {
  const h = words(heard);
  if (!h.length) return false;
  const spoken = new Set(spokenTexts.flatMap(words));
  if (!spoken.size) return false;
  const inSpoken = h.filter((w) => spoken.has(w)).length;
  return inSpoken / h.length >= 0.7;
}
