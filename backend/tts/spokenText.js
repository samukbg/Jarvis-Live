// Text as a voice should read it. Answers write units the way the cards read them ("12°C"),
// which a speech engine may spell out oddly or skip ("twelve C"): say them as words.
import { languageCode } from './systemVoice.js';

const DEGREES = { en: ['degree', 'degrees'], fr: ['degré', 'degrés'], pt: ['grau', 'graus'], es: ['grado', 'grados'], it: ['grado', 'gradi'], de: ['Grad', 'Grad'] };

export function spokenText(text, language) {
  const [one, many] = DEGREES[languageCode(language)] || DEGREES.en;
  return String(text || '')
    .replace(/\*\*|__|`/g, '')
    .replace(/(-?\d+(?:[.,]\d+)?)\s*°\s*([CF])\b/g, (_m, n, u) => `${n} ${Math.abs(parseFloat(n.replace(',', '.'))) === 1 ? one : many} ${u === 'F' ? 'Fahrenheit' : 'Celsius'}`)
    .replace(/(-?\d+(?:[.,]\d+)?)\s*°/g, (_m, n) => `${n} ${Math.abs(parseFloat(n.replace(',', '.'))) === 1 ? one : many}`);
}
