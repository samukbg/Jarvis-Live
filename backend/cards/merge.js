// Same merge policy as src/components/overlayCards/enrichment.ts (mergeEnrichment):
// real values fill what the agent left out; with prefer 'live' they also win.
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

function deepMerge(stated, live, prefer) {
  const out = { ...stated };
  for (const [k, lv] of Object.entries(live)) {
    const sv = stated[k];
    if (isPlain(sv) && isPlain(lv)) out[k] = deepMerge(sv, lv, prefer);
    else if (isEmpty(sv) || (prefer === 'live' && !isEmpty(lv))) out[k] = lv;
  }
  return out;
}

export function mergeCard(stated, enrichment) {
  if (!enrichment?.data || !isPlain(stated)) return stated;
  return deepMerge(stated, enrichment.data, enrichment.prefer ?? 'stated');
}
