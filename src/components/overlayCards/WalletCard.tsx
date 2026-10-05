import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Wallet, Copy, Check, Layers, TrendingUp, TrendingDown, ArrowDownLeft, ArrowUpRight, ArrowLeftRight, ExternalLink, BadgeCheck, Clock } from 'lucide-react';
import type { WalletData, WalletToken } from './types';
import { relativeTime } from './enrichment';
import { CardShell, CountUp, GrowBar, Pill, Reveal, SectionLabel, fmt, fmtUSD, palette } from './kit';


const CHAIN_COLORS: Record<string, string> = { ethereum: '#627EEA', base: '#0052FF', polygon: '#8247E5', arbitrum: '#28A0F0', solana: '#14F195' };
const TOKEN_COLORS = ['#627EEA', '#2775CA', '#14F195', '#F7931A', '#8247E5', '#FF007A', '#26A17B'];
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const tokenColor = (t: WalletToken, i: number) => t.color || TOKEN_COLORS[i % TOKEN_COLORS.length];

const TokenIcon: React.FC<{ token: WalletToken; color: string }> = ({ token, color }) => (
  <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border text-[11px] font-extrabold" style={{ color, background: `${color}26`, borderColor: `${color}66` }}>
    {token.icon ? <img src={token.icon} alt="" className="h-6 w-6 rounded-full" /> : token.symbol.slice(0, 4)}
  </span>
);

const Holdings: React.FC<{ tokens: WalletToken[] }> = ({ tokens }) => {
  const sum = tokens.reduce((a, t) => a + (t.valueUSD ?? 0), 0);
  const hasShare = sum > 0 && tokens.every((t) => t.valueUSD !== undefined);
  return (
    <div className="flex flex-col gap-2">
      {tokens.map((t, i) => {
        const share = t.allocationPercent ?? (hasShare ? ((t.valueUSD as number) / sum) * 100 : undefined);
        const c = tokenColor(t, i);
        return (
          <Reveal key={`${t.symbol}-${i}`} index={2 + i} className="flex flex-col gap-1.5 rounded-xl bg-black/35 p-3 transition-colors hover:bg-black/50">
            <div className="flex items-center gap-3">
              <TokenIcon token={t} color={c} />
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-semibold">{t.symbol}{t.name && <span className="ml-2 text-[12px] font-normal text-slate-500">{t.name}</span>}</div>
                {t.balance !== undefined && (
                  <div className="text-[12px] tabular-nums text-slate-400">{fmt(t.balance, 6)} {t.symbol}{t.priceUSD !== undefined ? ` · ${fmtUSD(t.priceUSD)}` : ''}</div>
                )}
              </div>
              <div className="flex flex-col items-end">
                {t.valueUSD !== undefined && <span className="text-[15px] font-semibold tabular-nums">{fmtUSD(t.valueUSD)}</span>}
                {t.change24h !== undefined && (
                  <span className="text-[11px] tabular-nums" style={{ color: t.change24h >= 0 ? palette.success : palette.danger }}>
                    {t.change24h >= 0 ? '+' : '−'}{fmt(Math.abs(t.change24h))}% 24h
                  </span>
                )}
              </div>
            </div>
            {share !== undefined && (
              <div className="flex items-center gap-2">
                <div className="flex-1"><GrowBar percent={share} color={c} height={5} delay={0.25 + i * 0.06} /></div>
                <span className="text-[11px] tabular-nums text-slate-500">{fmt(share, 1)}%</span>
              </div>
            )}
          </Reveal>
        );
      })}
    </div>
  );
};

export const WalletCard: React.FC<{ data: WalletData }> = ({ data }) => {
  const [copied, setCopied] = useState(false);
  const [net, setNet] = useState<string | null>(null);
  const netId = net && data.networks.some((n) => n.id === net) ? net : data.defaultNetwork ?? data.networks[0]?.id;
  const network = data.networks.find((n) => n.id === netId);
  const up = data.change24hPercent !== undefined ? data.change24hPercent >= 0 : data.change24hUSD !== undefined ? data.change24hUSD >= 0 : undefined;
  const tokens = network?.tokens ?? data.tokens ?? [];
  const valued = tokens.filter((t) => (t.valueUSD ?? 0) > 0);
  const txs = (data.recentTransactions ?? []).filter((tx) => !tx.network || !network || tx.network === network.id || data.networks.length < 2);

  const copy = () => {
    navigator.clipboard?.writeText(data.address).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <CardShell accent={palette.success}>
      <div>
        <Reveal index={0} className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[17px] font-semibold">{data.label || 'Wallet'}</div>
            <button onClick={copy} className="mt-0.5 flex items-center gap-1.5 text-[12px] tabular-nums text-slate-400 hover:text-slate-200" aria-label="Copy wallet address">
              {short(data.address)}
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={copied ? 'y' : 'n'} initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.4, opacity: 0 }}>
                  {copied ? <Check size={13} className="text-emerald-400" /> : <Copy size={13} />}
                </motion.span>
              </AnimatePresence>
            </button>
          </div>
          <div>
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-400/15" style={{ boxShadow: `0 0 24px ${palette.success}33` }}>
              <Wallet size={24} className="text-emerald-400" />
            </span>
          </div>
        </Reveal>

        {data.totalValueUSD !== undefined && (
          <Reveal index={1} className="mt-4 flex flex-col gap-1">
            <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">Total value</span>
            <CountUp value={data.totalValueUSD} decimals={2} minDecimals={2} prefix="$" className="text-[34px] font-bold tracking-tight" />
            {up !== undefined && (
              <Pill
                color={up ? palette.success : palette.danger}
                icon={up ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                label={[
                  data.change24hUSD !== undefined ? `${data.change24hUSD >= 0 ? '+' : '−'}${fmtUSD(Math.abs(data.change24hUSD))}` : null,
                  data.change24hPercent !== undefined ? `${data.change24hPercent >= 0 ? '+' : '−'}${fmt(Math.abs(data.change24hPercent))}%` : null,
                  '24h',
                ].filter(Boolean).join('  ')}
              />
            )}
          </Reveal>
        )}
      </div>

      {data.networks.length > 1 && (
        <Reveal index={2}>
          <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist">
            {data.networks.map((n) => {
              const on = n.id === netId;
              return (
                <button key={n.id} role="tab" aria-selected={on} onClick={() => setNet(n.id)}
                  className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] transition-colors ${on ? 'border-emerald-400 bg-emerald-400/15 text-slate-100' : 'border-white/10 bg-black/40 text-slate-400 hover:text-slate-200'}`}>
                  <span className="h-2 w-2 rounded-full" style={{ background: CHAIN_COLORS[n.id] ?? palette.success }} />
                  {n.name}
                  <span className="text-[11px] tabular-nums text-slate-500">{fmtUSD(n.totalUSD)}</span>
                </button>
              );
            })}
          </div>
        </Reveal>
      )}

      <AnimatePresence mode="wait">
        <motion.div key={netId ?? 'tokens'} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.22 }} className="flex flex-col gap-4">
          {valued.length > 0 && (() => {
            // Segmented capacity bar: each holding's share of the network's value.
            const sum = valued.reduce((acc, t) => acc + (t.valueUSD ?? 0), 0) || 1;
            const top = valued.slice(0, 6);
            const rest = valued.slice(6).reduce((acc, t) => acc + (t.valueUSD ?? 0), 0);
            return (
              <div className="flex flex-col gap-2">
                <div className="h-3.5 overflow-hidden rounded-full bg-sky-200/10">
                  <motion.div className="flex h-full gap-[2px]" initial={{ width: 0 }} animate={{ width: '100%' }} transition={{ duration: 0.9, delay: 0.2 }}>
                    {top.map((t) => <div key={t.symbol} style={{ flex: (t.valueUSD ?? 0) / sum, background: tokenColor(t, tokens.indexOf(t)) }} />)}
                    {rest > 0 && <div style={{ flex: rest / sum, background: palette.muted }} />}
                  </motion.div>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-slate-300">
                  {top.map((t) => (
                    <span key={t.symbol} className="flex items-center gap-1.5">
                      <span className="h-2.5 w-2.5 rounded-sm" style={{ background: tokenColor(t, tokens.indexOf(t)) }} />{t.symbol} {fmt(((t.valueUSD ?? 0) / sum) * 100, 1)}%
                    </span>
                  ))}
                  {rest > 0 && <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: palette.muted }} />Other {fmt((rest / sum) * 100, 1)}%</span>}
                </div>
              </div>
            );
          })()}
          {tokens.length > 0 && (
            <div>
              <SectionLabel icon={<Layers size={13} className="text-emerald-400" />}>{network ? `${network.name} · ${fmtUSD(network.totalUSD)}` : 'Holdings'}</SectionLabel>
              <Holdings tokens={tokens} />
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      {txs.length > 0 && (
        <Reveal index={9}>
          <SectionLabel icon={<ArrowLeftRight size={13} className="text-emerald-400" />}>Recent activity</SectionLabel>
          <div className="flex flex-col gap-2">
            {txs.map((tx, i) => {
              const c = tx.type === 'IN' ? palette.success : tx.type === 'OUT' ? palette.danger : palette.accent;
              const Icon = tx.type === 'IN' ? ArrowDownLeft : tx.type === 'OUT' ? ArrowUpRight : ArrowLeftRight;
              return (
                <Reveal key={`${tx.hash}-${i}`} index={10 + i}>
                  <a
                    href={tx.url}
                    target="_blank"
                    rel="noreferrer"
                    className={`flex items-center gap-3 rounded-xl bg-black/35 p-3 transition-colors ${tx.url ? 'hover:bg-black/55' : 'pointer-events-none'}`}
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full" style={{ background: `${c}22` }}><Icon size={16} style={{ color: c }} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px]">{tx.type === 'IN' ? 'Received' : tx.type === 'OUT' ? 'Sent' : 'Swap'} {tx.type === 'SWAP' ? tx.asset : `${fmt(tx.amount, 6)} ${tx.asset}`}</div>
                      <div className="truncate text-[11px] text-slate-500">{tx.type === 'IN' ? 'from' : 'to'} {short(tx.fromTo)} · {relativeTime(tx.timestamp)}</div>
                    </div>
                    <div className="flex flex-col items-end">
                      {tx.valueUSD !== undefined && <span className="text-[13px] tabular-nums">{fmtUSD(tx.valueUSD)}</span>}
                      <span className="flex items-center gap-1 text-[11px]" style={{ color: tx.status === 'CONFIRMED' ? palette.success : palette.warning }}>
                        {tx.status === 'CONFIRMED' ? <BadgeCheck size={12} /> : <Clock size={12} />}{tx.status === 'CONFIRMED' ? 'Verified' : 'Pending'}
                      </span>
                    </div>
                    {tx.url && <ExternalLink size={13} className="shrink-0 text-slate-500" />}
                  </a>
                </Reveal>
              );
            })}
          </div>
        </Reveal>
      )}
    </CardShell>
  );
};
