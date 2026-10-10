// The Antigravity CLI (agy ≥ 1.3) names models with their reasoning effort
// ("gemini-3.8-flash-high"): passing --effort as well is rejected ("conflicts with
// --effort=medium"), and a bare name needs an effort the model offers ("gemini-3.1-pro" has
// no "medium"). `available` = the ids `agy models` lists (agents/detect.js).
const EFFORT = /-(low|medium|high|xhigh|max)$/;

function pickModel(selection, available) {
  const m = String(selection || '').toLowerCase().trim().split(/\s+/)[0];
  if (!m.startsWith('gemini')) return available[0] ? ['--model', available[0]] : [];
  if (EFFORT.test(m)) return ['--model', m];
  const pick = ['medium', 'high', 'low'].map((e) => `${m}-${e}`).find((id) => available.includes(id))
    || available.find((id) => id.startsWith(`${m}-`));
  return pick ? ['--model', pick] : ['--model', m, '--effort', 'medium'];
}

/**
 * `effort` (voice delegations: 'low') swaps the chosen model's effort when agy offers it — the
 * agent runs a dozen model turns per task, and on "high" each one thinks ~2.5× longer.
 */
export function agyModelArgs(selection, available = [], { effort } = {}) {
  const args = pickModel(selection, available);
  if (!effort || args[0] !== '--model') return args;
  if (args[2] === '--effort') return [args[0], args[1], '--effort', effort];
  const swapped = args[1].replace(EFFORT, `-${effort}`);
  return available.includes(swapped) ? ['--model', swapped] : args;
}
