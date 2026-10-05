// Fetches (and, while live, keeps refreshing) the real data behind a card.
// Shared by web and mobile — keep identical.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_KEY, BACKEND_HTTP } from '../../store';
import type { DetectedSpecialContent } from './types';
import { ENRICHABLE, fetchEnrichment, mergeEnrichment, type CardEnrichment } from './enrichment';

export function useCardEnrichment(detected: DetectedSpecialContent) {
  const enrichable = ENRICHABLE.has(detected.type);
  const [enrichment, setEnrichment] = useState<CardEnrichment | null>(null);
  const [loading, setLoading] = useState(enrichable);
  const [tick, setTick] = useState(0);
  const key = `${detected.type}:${JSON.stringify(detected.data)}`;
  const latest = useRef(detected);
  latest.current = detected;

  useEffect(() => {
    if (!enrichable) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let liveEvery = 0;
    const run = async () => {
      // Web: pause while the tab is hidden (RN has no document).
      const hidden = (globalThis as { document?: { visibilityState?: string } }).document?.visibilityState === 'hidden';
      const result = hidden ? null : await fetchEnrichment(BACKEND_HTTP, API_KEY, latest.current.type, latest.current.data).catch(() => null);
      if (!alive) return;
      if (result) setEnrichment(result);
      setLoading(false);
      // Keep polling through a hidden tab or a failed refresh once the data is live.
      if (result) liveEvery = result.refreshMs ?? 0;
      const every = result ? liveEvery : hidden ? Math.max(liveEvery, 5000) : liveEvery;
      if (every > 0) timer = setTimeout(run, every);
    };
    run();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [key, enrichable, tick]);

  const data = useMemo(() => mergeEnrichment(detected.data, enrichment), [detected.data, enrichment]);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, enrichment, loading, refresh };
}
