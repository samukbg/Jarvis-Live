// The Antigravity CLI (agy ≥ 1.3) names models with their reasoning effort
// ("gemini-3.8-flash-high"): passing --effort as well is rejected ("conflicts with
// --effort=medium"), and a bare name needs an effort the model offers ("gemini-3.1-pro" has
// no "medium"). `available` = the ids `agy models` lists (agents/detect.js).
const EFFORT = /-(low|medium|high|xhigh|max)$/;

export function agyModelArgs(selection, available = []) {
  const m = String(selection || '').toLowerCase().trim().split(/\s+/)[0];
  if (!m.startsWith('gemini')) return available[0] ? ['--model', available[0]] : [];
  if (EFFORT.test(m)) return ['--model', m];
  const pick = ['medium', 'high', 'low'].map((e) => `${m}-${e}`).find((id) => available.includes(id))
    || available.find((id) => id.startsWith(`${m}-`));
  return pick ? ['--model', pick] : ['--model', m, '--effort', 'medium'];
}
