// Finance: Yahoo Finance chart API (stocks, ETFs, indices and crypto as XXX-USD).
import { cached, compact, compactNumber, getJson, round } from './util.js';

const CRYPTO = new Set([
  'BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'BNB', 'AVAX', 'DOT', 'LINK', 'MATIC', 'POL', 'LTC', 'TRX', 'SHIB', 'TON', 'SUI',
  'PEPE', 'USDC', 'USDT', 'AERO', 'DEGEN', 'ARB', 'OP', 'NEAR', 'ATOM', 'XLM', 'BCH', 'UNI', 'APT', 'HBAR', 'ICP', 'FIL', 'ETC',
]);
const CRYPTO_NAME = /bitcoin|ethereum|solana|crypto|coin|token|dogecoin|ripple|cardano/i;

export const RANGES = { '1D': ['1d', '5m'], '1W': ['5d', '30m'], '1M': ['1mo', '1d'], '1Y': ['1y', '1wk'], ALL: ['max', '3mo'] };

export function yahooSymbol(symbol, name) {
  const s = String(symbol || '').toUpperCase().replace(/^\$/, '').trim();
  if (!s) return null;
  if (s.includes('-') || s.includes('.') || s.startsWith('^')) return s;
  if (CRYPTO.has(s) || CRYPTO_NAME.test(name ?? '')) return `${s}-USD`;
  return s;
}

/** Chart JSON → points (epoch ms, value) and the quote meta. */
export function mapChart(json) {
  const r = json?.chart?.result?.[0];
  if (!r) return null;
  const ts = r.timestamp ?? [];
  const close = r.indicators?.quote?.[0]?.close ?? [];
  const points = ts.map((t, i) => ({ t: t * 1000, value: close[i] })).filter((p) => Number.isFinite(p.value)).map((p) => ({ t: p.t, value: round(p.value, 4) }));
  return { points, meta: r.meta ?? {} };
}

export function mapQuote(meta, histories) {
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose ?? meta.previousClose;
  const change = Number.isFinite(price) && Number.isFinite(prev) ? price - prev : undefined;
  return compact({
    price: round(price, 4),
    currency: meta.currency,
    name: meta.longName ?? meta.shortName,
    exchange: meta.fullExchangeName ?? meta.exchangeName,
    instrumentType: meta.instrumentType,
    previousClose: round(prev, 4),
    change: round(change, 4),
    changePercent: Number.isFinite(change) && prev ? round((change / prev) * 100, 2) : undefined,
    high24h: round(meta.regularMarketDayHigh, 4),
    low24h: round(meta.regularMarketDayLow, 4),
    week52High: round(meta.fiftyTwoWeekHigh, 4),
    week52Low: round(meta.fiftyTwoWeekLow, 4),
    volume24h: compactNumber(meta.regularMarketVolume),
    histories,
  });
}

const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36';

/** Stocks/ETFs: market cap, sector, dividend and analyst target from Nasdaq's quote summary. */
export function mapNasdaqSummary(summary) {
  const v = (k) => summary?.[k]?.value;
  const money = (s) => (s ? Number(String(s).replace(/[$,]/g, '')) : undefined);
  const cap = money(v('MarketCap'));
  return compact({
    marketCap: cap ? `$${compactNumber(cap)}` : undefined,
    sector: v('Sector') && v('Sector') !== 'N/A' ? v('Sector') : undefined,
    industry: v('Industry') && v('Industry') !== 'N/A' ? v('Industry') : undefined,
    dividendYield: v('Yield') && v('Yield') !== 'N/A' ? v('Yield') : undefined,
    targetPrice: money(v('OneYrTarget')) || undefined,
  });
}

async function stockExtras(symbol) {
  return cached(`nasdaq:${symbol}`, 10 * 60e3, async () => {
    for (const cls of ['stocks', 'etf']) {
      const r = await getJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/summary?assetclass=${cls}`, { headers: { 'User-Agent': BROWSER_UA } }).catch(() => null);
      if (r?.data?.summaryData) return mapNasdaqSummary(r.data.summaryData);
    }
    return {};
  });
}

/** Crypto: market cap and rank from CoinGecko. */
async function cryptoExtras(symbol) {
  return cached(`cgm:${symbol}`, 10 * 60e3, async () => {
    const search = await getJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(symbol)}`).catch(() => null);
    // Search results come ordered by market cap: the first symbol match is the main coin.
    const coin = (search?.coins ?? []).find((c) => c.symbol?.toUpperCase() === symbol);
    if (!coin) return {};
    const m = (await getJson(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${coin.id}`).catch(() => []))?.[0];
    return compact({
      marketCap: m?.market_cap ? `$${compactNumber(m.market_cap)}` : undefined,
      marketCapRank: m?.market_cap_rank ?? undefined,
      logoUrl: m?.image ?? coin.large ?? undefined,
    });
  });
}

const chart = (sym, range, interval) =>
  getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`).then(mapChart);

export async function enrichFinance(data) {
  const sym = yahooSymbol(data?.symbol, data?.name);
  if (!sym) return null;
  const results = await cached(`fin:${sym}`, 60e3, async () => {
    const entries = await Promise.all(Object.entries(RANGES).map(async ([key, [range, interval]]) => [key, await chart(sym, range, interval).catch(() => null)]));
    return Object.fromEntries(entries);
  });
  const day = results['1D'] ?? Object.values(results).find(Boolean);
  if (!day) return null;
  const histories = {};
  for (const [key, r] of Object.entries(results)) if (r && r.points.length > 1) histories[key] = r.points;
  const patch = mapQuote(day.meta, histories);
  const isCrypto = patch.instrumentType === 'CRYPTOCURRENCY';
  const extras = await (isCrypto ? cryptoExtras(sym.replace(/-USD$/, '')) : stockExtras(sym)).catch(() => ({}));
  Object.assign(patch, extras);
  // Wrong instrument guard (e.g. ETH the stock vs ETH the coin).
  if (Number.isFinite(data.price) && Number.isFinite(patch.price) && Math.abs(patch.price - data.price) / Math.max(data.price, 1e-9) > 0.25) return null;
  return { data: patch, prefer: 'live', sources: ['Yahoo Finance', isCrypto ? 'CoinGecko' : 'Nasdaq'].filter((x) => extras.marketCap || x === 'Yahoo Finance'), refreshMs: 60e3 };
}
