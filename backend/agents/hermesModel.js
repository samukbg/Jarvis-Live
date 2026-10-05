// Hermes needs both a model and a provider. Detected models are "provider::model"
// (agents/detect.js); older saved selections are plain model names.
const LEGACY_PROVIDERS = {
  'deepseek-v4-flash': 'DeepSeek',
  'nvidia/nemotron-3-super-120b-a12b:free': 'OpenRouter',
  'tencent/hy3:free': 'nous',
  'poolside/laguna-s-2.1:free': 'nous',
};

/** "nous::upstage/solar-pro4:free" → { provider: 'nous', model: 'upstage/solar-pro4:free' }. */
export function splitHermesModel(selection) {
  const s = String(selection || '').trim();
  const i = s.indexOf('::');
  if (i > 0) return { provider: s.slice(0, i), model: s.slice(i + 2) };
  return { provider: LEGACY_PROVIDERS[s] || null, model: s || null };
}
