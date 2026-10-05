import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Eye, Code } from 'lucide-react';
import type { DetectedSpecialContent, WeatherData, FinanceData, FlightData, SystemDiagnosticsData, TaskRoadmapData, MediaAudioData, TranslationData, ChartData, SportsScoreData, RecipeData, WalletData } from './types';
import { WeatherCard } from './WeatherCard';
import { FinanceCard } from './FinanceCard';
import { FlightCard } from './FlightCard';
import { SystemDiagnosticsCard } from './SystemDiagnosticsCard';
import { TaskRoadmapCard } from './TaskRoadmapCard';
import { MediaAudioCard } from './MediaAudioCard';
import { TranslationCard } from './TranslationCard';
import { DataChartCard } from './DataChartCard';
import { SportsScoreCard } from './SportsScoreCard';
import { RecipeCard } from './RecipeCard';
import { WalletCard } from './WalletCard';
import { FormattedMarkdown } from '../FormattedMarkdown';
import { useCardEnrichment } from './useCardEnrichment';
import type { CardLive } from './enrichment';
import { SourceFooter } from './motion';

export const SpecialCardRenderer: React.FC<{ 
  detected: DetectedSpecialContent;
  rawContent: string;
}> = ({ detected, rawContent }) => {
  const [viewMode, setViewMode] = useState<'visual' | 'raw'>('visual');

  const { data, enrichment, loading, refresh } = useCardEnrichment(detected);
  const live: CardLive = { live: (enrichment?.refreshMs ?? 0) > 0, fetchedAt: enrichment?.fetchedAt, refresh };

  const renderComponent = () => {
    switch (detected.type) {
      case 'weather': return <WeatherCard data={data as WeatherData} />;
      case 'finance': return <FinanceCard data={data as FinanceData} live={live} />;
      case 'flight': return <FlightCard data={data as FlightData} live={live} />;
      case 'system': return <SystemDiagnosticsCard data={data as SystemDiagnosticsData} live={live} />;
      case 'task_roadmap': return <TaskRoadmapCard data={data as TaskRoadmapData} />;
      case 'media_audio': return <MediaAudioCard data={data as MediaAudioData} live={live} />;
      case 'translation': return <TranslationCard data={data as TranslationData} />;
      case 'chart': return <DataChartCard data={data as ChartData} />;
      case 'sports': return <SportsScoreCard data={data as SportsScoreData} live={live} />;
      case 'recipe': return <RecipeCard data={data as RecipeData} />;
      case 'wallet': return <WalletCard data={data as WalletData} />;
      default: return <FormattedMarkdown content={rawContent} />;
    }
  };

  const meta = LABELS[detected.type] ?? { label: 'Result', color: '#22D3EE' };
  return (
    <div className="flex w-full flex-col gap-3 font-sans normal-case tracking-normal">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-semibold" style={{ color: meta.color }}>{meta.label}</span>
        <div className="relative flex rounded-full border border-white/10 bg-black/40 p-0.5">
          {(['visual', 'raw'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`relative z-10 flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-semibold transition-colors ${viewMode === mode ? 'text-slate-900' : 'text-slate-400 hover:text-slate-200'}`}
            >
              {viewMode === mode && (
                <motion.span layoutId="card-view-pill" className="absolute inset-0 -z-10 rounded-full" style={{ background: meta.color }} transition={{ type: 'spring', damping: 22, stiffness: 300 }} />
              )}
              {mode === 'visual' ? <Eye size={12} /> : <Code size={12} />}
              {mode === 'visual' ? 'Visual' : 'Text'}
            </button>
          ))}
        </div>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={viewMode}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
        >
          {viewMode === 'visual' ? renderComponent() : <FormattedMarkdown content={rawContent} />}
        </motion.div>
      </AnimatePresence>
      {viewMode === 'visual' && <SourceFooter sources={enrichment?.sources} live={live.live} loading={loading} />}
    </div>
  );
};

const LABELS: Record<string, { label: string; color: string }> = {
  weather: { label: 'Weather', color: '#60A5FA' },
  finance: { label: 'Market', color: '#34D399' },
  flight: { label: 'Flight', color: '#38BDF8' },
  system: { label: 'System health', color: '#22D3EE' },
  task_roadmap: { label: 'Roadmap', color: '#A855F7' },
  media_audio: { label: 'Now playing', color: '#F472B6' },
  translation: { label: 'Translation', color: '#FBBF24' },
  chart: { label: 'Chart', color: '#22D3EE' },
  sports: { label: 'Match', color: '#34D399' },
  recipe: { label: 'Recipe', color: '#FB923C' },
  wallet: { label: 'Wallet', color: '#34D399' },
};
