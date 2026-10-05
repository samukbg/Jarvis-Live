// An agent's result, in a sheet (mobile AgentOutcomeModal): domain cards (weather, finance,
// flights…) when the content is one, else source cards or formatted markdown.
import { motion } from 'framer-motion';
import { Check, ExternalLink, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useStore } from '../store';
import { FormattedMarkdown, MediaRenderer } from '../components/FormattedMarkdown';
import { detectSpecialContent } from '../components/overlayCards/detectSpecialContent';
import { SpecialCardRenderer } from '../components/overlayCards/SpecialCardRenderer';
import { Pressable, Sheet, alpha, palette, spring } from '../ui';
import { agentMeta } from './status';

// ── Result card parsing ────────────────────────────────────────────────────
interface ResultItem {
  title: string;
  source: string;
  date: string;
  url: string;
  domain: string;
  body: string;
  imageUrl: string;
  mediaUrl: string;
}

function toImageUrl(url: string): string {
  if (!url) return '';
  if (/\.(jpg|jpeg|png|webp|gif|svg|bmp)(\?.*)?$/i.test(url)) return url;
  const unsplash = url.match(/unsplash\.com\/photos\/([a-zA-Z0-9_-]+)/);
  if (unsplash) return `https://source.unsplash.com/${unsplash[1]}/800x500`;
  if (/upload\.wikimedia\.org/i.test(url)) return url;
  if (/\bimages\./i.test(new URL(url).hostname)) return url;
  return '';
}

const MEDIA_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'pdf', 'txt', 'log', 'md', 'json', 'csv', 'glb', 'gltf', 'obj', 'fbx', 'stl', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp']);

function buildResultItem(title: string, raw: string): ResultItem {
  const src = (raw.match(/\*\*Sources?:\*\*\s*([^\n]+)/i)?.[1]
    ?? raw.match(/^Sources?:\s*([^\n]+)/im)?.[1] ?? '').replace(/\*\*/g, '').trim();
  const dt = (raw.match(/\*\*Dates?:\*\*\s*([^\n]+)/i)?.[1]
    ?? raw.match(/^Dates?:\s*([^\n]+)/im)?.[1] ?? '').replace(/\*\*/g, '').trim();
  const urlM = raw.match(/https?:\/\/[^\s)\]>"]+/);
  const url = urlM?.[0] ?? '';
  let domain = '';
  if (url) { try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { /* not a URL */ } }
  const imageUrl = toImageUrl(url);
  let mediaUrl = '';

  // 1. Extract markdown links: [alt](url) or ![alt](url)
  const mdMatches = raw.matchAll(/(?:!\[|\[)([^\]]*)\]\(([^)]+)\)/g);
  for (const match of mdMatches) {
    const candidate = match[2].trim().replace(/^<|>$/g, '');
    const cleanUrl = candidate.split('?')[0].split('#')[0].replace(/\\/g, '/');
    const ext = cleanUrl.split('.').pop()?.toLowerCase() || '';
    if (MEDIA_EXTENSIONS.has(ext)) {
      mediaUrl = candidate;
      break;
    }
  }

  // 2. Fallback: extract bare URLs or paths
  if (!mediaUrl) {
    const bareRegex = /(?:(?:https?|file):\/\/[^\s"'<>`]+|(?:[a-zA-Z]:[\\/][^\s"'<>`]+)|(?:\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+))/gi;
    let match;
    while ((match = bareRegex.exec(raw)) !== null) {
      const candidate = match[0].trim().replace(/[.,;:()\]}'"`*_]+$/, '');
      const cleanUrl = candidate.split('?')[0].split('#')[0].replace(/\\/g, '/');
      const ext = cleanUrl.split('.').pop()?.toLowerCase() || '';
      if (MEDIA_EXTENSIONS.has(ext)) {
        mediaUrl = candidate;
        break;
      }
    }
  }

  // 3. Fallback: extract backtick paths
  if (!mediaUrl) {
    const codeMatches = raw.matchAll(/`([^`]+)`/g);
    for (const match of codeMatches) {
      const candidate = match[1].trim();
      const cleanUrl = candidate.split('?')[0].split('#')[0].replace(/\\/g, '/');
      const ext = cleanUrl.split('.').pop()?.toLowerCase() || '';
      if (MEDIA_EXTENSIONS.has(ext)) {
        mediaUrl = candidate;
        break;
      }
    }
  }

  const body = raw.split('\n').slice(1)
    .filter(l => !/^\*\*(?:Source|Date|Author)[s]?:/i.test(l) && !/^https?:\/\//i.test(l.trim()))
    .join('\n')
    .replace(/(?:!\[|\[)([^\]]*)\]\(([^)]+)\)/g, (match, _alt, url) => {
       if (url === mediaUrl) return ''; // Remove the extracted media URL from the body
       return match;
    })
    .replace(/^---+$/gm, '')
    .trim();
  return { title: title.replace(/\*\*/g, '').trim(), source: src, date: dt, url, domain, body, imageUrl, mediaUrl };
}

function parseResultItems(result: string): ResultItem[] {
  // prefer ### sub-sections (individual items like articles)
  const sub = result.split(/^###\s+/m).slice(1);
  if (sub.length >= 1) return sub.map(s => buildResultItem(s.split('\n')[0], s));
  // fall back to ## top-level sections
  const top = result.split(/^##\s+/m).slice(1);
  if (top.length >= 2) return top.map(s => buildResultItem(s.split('\n')[0], s));
  return [buildResultItem('', result)];
}

function ResultCard({ item, index }: { item: ResultItem; index: number }) {
  const [faviconErr, setFaviconErr] = useState(false);
  const [imageErr, setImageErr] = useState(false);
  const initial = (item.source || item.title || '?')[0].toUpperCase();
  const favicon = item.domain && !faviconErr ? `https://www.google.com/s2/favicons?domain=${item.domain}&sz=64` : null;
  const showImage = !!item.imageUrl && !imageErr && !item.mediaUrl;
  return (
    <motion.article
      initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ ...spring.gentle, delay: 0.05 + index * 0.06 }}
      whileHover={{ y: -2 }}
      className="surface flex flex-col overflow-hidden"
    >
      {item.mediaUrl && <div className="px-3 pt-3"><MediaRenderer src={item.mediaUrl} /></div>}
      {showImage && (
        <div className="max-h-[220px] overflow-hidden">
          <img src={item.imageUrl} alt={item.title} className="block max-h-[220px] w-full object-cover" onError={() => setImageErr(true)} />
        </div>
      )}
      <div className="flex flex-col gap-2 p-4">
        <div className="flex min-w-0 items-center gap-2">
          {favicon
            ? <img src={favicon} alt="" className="h-4 w-4 shrink-0 rounded-[4px]" onError={() => setFaviconErr(true)} />
            : <span className="grid h-4 w-4 shrink-0 place-items-center rounded-[4px] text-[9px] font-bold" style={{ background: alpha(palette.accent, 40), color: palette.accent }}>{initial}</span>}
          <span className="flex-1 truncate t-caption" style={{ color: palette.textTertiary }}>{item.source || 'Result'}</span>
          {item.date && <span className="shrink-0 tabular t-caption" style={{ color: palette.textTertiary }}>{item.date}</span>}
        </div>
        {item.title && <h3 className="t-headline">{item.title}</h3>}
        {item.body && <div className="t-callout" style={{ color: palette.textSecondary }}><FormattedMarkdown content={item.body} compact /></div>}
        {item.url && (
          <a href={item.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 self-start t-footnote transition-colors hover:text-accent" style={{ color: palette.textTertiary }}>
            <ExternalLink size={12} /> {item.domain}
          </a>
        )}
      </div>
    </motion.article>
  );
}

export function ResultSheet() {
  const agentOutcome = useStore((s) => s.agentOutcome);
  const dismissOutcome = useStore((s) => s.dismissOutcome);
  const meta = agentOutcome ? agentMeta(agentOutcome.agentId) : null;
  const body = () => {
    if (!agentOutcome) return null;
    const special = detectSpecialContent(agentOutcome.result, agentOutcome.agentName);
    if (special) return <SpecialCardRenderer detected={special} rawContent={agentOutcome.result} />;
    const items = parseResultItems(agentOutcome.result);
    const structured = items.length > 1 || !!(items[0].title || items[0].source);
    if (!structured) return <div className="surface p-5"><FormattedMarkdown content={agentOutcome.result} /></div>;
    const hasMedia = items.some((i) => i.mediaUrl);
    return (
      <div className={`grid gap-3 ${items.length >= 2 && !hasMedia ? 'md:grid-cols-2' : ''}`}>
        {items.map((item, i) => <ResultCard key={i} item={item} index={i} />)}
      </div>
    );
  };
  return (
    <Sheet
      open={!!agentOutcome}
      onClose={dismissOutcome}
      title={agentOutcome?.agentName ?? ''}
      subtitle="Result"
      icon={meta?.icon ?? Sparkles}
      accent={meta?.color ?? palette.accent}
      width={980}
      footer={
        <div className="flex justify-end">
          <Pressable onClick={dismissOutcome} className="flex h-10 items-center gap-2 rounded-full px-5 t-subhead" style={{ background: palette.accent, color: palette.textInverse }}>
            <Check size={16} strokeWidth={2.4} /> Done
          </Pressable>
        </div>
      }
    >
      {body()}
    </Sheet>
  );
}
