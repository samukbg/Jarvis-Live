// Wallet: balances, prices, 24h changes and recent activity across chains.
// EVM (Ethereum, Base, Polygon, Arbitrum) via Blockscout; Solana via its public
// RPC; token 24h changes, liquidity (spam filter) and SPL names via DexScreener;
// native coin 24h changes via CoinGecko.
import { cached, compact, getJson, round } from './util.js';

const EVM_CHAINS = [
  { id: 'ethereum', name: 'Ethereum', host: 'https://eth.blockscout.com', native: { symbol: 'ETH', name: 'Ether', cg: 'ethereum' } },
  { id: 'base', name: 'Base', host: 'https://base.blockscout.com', native: { symbol: 'ETH', name: 'Ether', cg: 'ethereum' } },
  { id: 'polygon', name: 'Polygon', host: 'https://polygon.blockscout.com', native: { symbol: 'POL', name: 'Polygon', cg: 'polygon-ecosystem-token' } },
  { id: 'arbitrum', name: 'Arbitrum', host: 'https://arbitrum.blockscout.com', native: { symbol: 'ETH', name: 'Ether', cg: 'ethereum' } },
];
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const SPL_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

const get = (url) => getJson(url, { timeoutMs: 6000 });
const MIN_LIQUIDITY_USD = 20_000;

/** DexScreener market data by token address (lower-case) for one chain, 30 per call. */
async function dexMarkets(chainId, addresses) {
  const out = {};
  for (let i = 0; i < addresses.length; i += 30) {
    const batch = addresses.slice(i, i + 30);
    const pairs = await cached(`dex:${chainId}:${batch.join(',')}`, 60e3, () => get(`https://api.dexscreener.com/tokens/v1/${chainId}/${batch.join(',')}`)).catch(() => []);
    for (const p of pairs ?? []) {
      const addr = String(p.baseToken?.address ?? '').toLowerCase();
      const liq = Number(p.liquidity?.usd ?? 0);
      // Keep the deepest pair per token.
      if (!out[addr] || liq > out[addr].liquidity) {
        out[addr] = { liquidity: liq, change24h: p.priceChange?.h24, priceUsd: Number(p.priceUsd), symbol: p.baseToken?.symbol, name: p.baseToken?.name, icon: p.info?.imageUrl };
      }
    }
  }
  return out;
}
const units = (raw, decimals) => Number(BigInt(raw || '0')) / 10 ** Number(decimals ?? 18);
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

export const isEvmAddress = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
export const isSolanaAddress = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

export function mapChain(chain, address, info, balances, txs, transfers) {
  const nativeRate = Number(info?.exchange_rate) || undefined;
  const nativeBal = units(info?.coin_balance, 18);
  const tokens = [];
  if (nativeBal > 0) {
    tokens.push(compact({
      symbol: chain.native.symbol, name: chain.native.name, balance: round(nativeBal, 6), priceUSD: nativeRate,
      valueUSD: nativeRate ? round(nativeBal * nativeRate, 2) : undefined, cgId: chain.native.cg,
    }));
  }
  for (const b of balances ?? []) {
    const t = b.token ?? {};
    const rate = Number(t.exchange_rate);
    // Spam filter: airdropped junk often has a quoted price, so also require a
    // clean reputation and a real holder base.
    if (t.type !== 'ERC-20' || !rate) continue;
    if ((t.reputation && t.reputation !== 'ok') || Number(t.holders_count ?? t.holders ?? 0) < 500) continue;
    const bal = units(b.value, t.decimals);
    const value = bal * rate;
    if (value < 0.01) continue;
    tokens.push(compact({
      symbol: t.symbol, name: t.name, balance: round(bal, 6), priceUSD: rate, valueUSD: round(value, 2),
      icon: t.icon_url ?? undefined, contract: t.address_hash ?? t.address ?? undefined,
    }));
  }
  tokens.sort((a, b) => (b.valueUSD ?? 0) - (a.valueUSD ?? 0));
  const totalUSD = round(tokens.reduce((s, t) => s + (t.valueUSD ?? 0), 0), 2);

  const activity = [];
  for (const tx of txs ?? []) {
    const amount = units(tx.value, 18);
    if (!(amount > 0)) continue;
    const incoming = same(tx.to?.hash, address);
    activity.push({
      hash: tx.hash, type: incoming ? 'IN' : 'OUT', asset: chain.native.symbol, amount: round(amount, 6),
      valueUSD: nativeRate ? round(amount * nativeRate, 2) : undefined,
      fromTo: incoming ? tx.from?.hash : tx.to?.hash, timestamp: tx.timestamp,
      status: tx.status === 'ok' || tx.result === 'success' ? 'CONFIRMED' : 'PENDING',
      network: chain.id, url: `${chain.host}/tx/${tx.hash}`,
    });
  }
  for (const tr of transfers ?? []) {
    const rate = Number(tr.token?.exchange_rate);
    if (!rate) continue;
    const amount = units(tr.total?.value, tr.total?.decimals ?? tr.token?.decimals);
    const incoming = same(tr.to?.hash, address);
    const hash = tr.transaction_hash ?? tr.tx_hash;
    activity.push({
      hash, type: incoming ? 'IN' : 'OUT', asset: tr.token?.symbol, amount: round(amount, 6),
      valueUSD: round(amount * rate, 2), fromTo: incoming ? tr.from?.hash : tr.to?.hash, timestamp: tr.timestamp,
      status: 'CONFIRMED', network: chain.id, url: `${chain.host}/tx/${hash}`,
    });
  }
  return { network: { id: chain.id, name: chain.name, totalUSD, nativeToken: chain.native.symbol, tokens }, activity, chain };
}

async function loadEvmChain(chain, address) {
  const base = `${chain.host}/api/v2/addresses/${address}`;
  const [info, balances, txs, transfers] = await Promise.all([
    get(base).catch(() => null),
    get(`${base}/token-balances`).catch(() => []),
    get(`${base}/transactions`).then((r) => r.items).catch(() => []),
    get(`${base}/token-transfers?type=ERC-20`).then((r) => r.items).catch(() => []),
  ]);
  if (!info) return null;
  return mapChain(chain, address, info, balances, txs, transfers);
}

const rpc = (method, params) =>
  fetch(SOLANA_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  }).then((r) => r.json()).then((j) => j.result);

/** SOL + priced SPL tokens + the latest SOL transfers. */
async function loadSolana(address) {
  const [lamports, accounts, sigs] = await Promise.all([
    rpc('getBalance', [address]).then((r) => r?.value ?? 0).catch(() => null),
    rpc('getTokenAccountsByOwner', [address, { programId: SPL_PROGRAM }, { encoding: 'jsonParsed' }]).then((r) => r?.value ?? []).catch(() => []),
    rpc('getSignaturesForAddress', [address, { limit: 6 }]).catch(() => []),
  ]);
  if (lamports === null) return null;
  const holdings = accounts
    .map((a) => a.account?.data?.parsed?.info)
    .filter((i) => i?.tokenAmount?.uiAmount > 0)
    .sort((a, b) => b.tokenAmount.uiAmount - a.tokenAmount.uiAmount)
    .slice(0, 40);
  const mints = holdings.map((h) => h.mint);
  const [solPrice, markets] = await Promise.all([
    cached('cg:solana', 60e3, () => getJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true')).catch(() => null),
    mints.length ? dexMarkets('solana', mints) : {},
  ]);
  const sol = lamports / 1e9;
  // CoinGecko first; wrapped SOL on DexScreener if it is rate-limited.
  const wsol = solPrice?.solana?.usd ? null : (await dexMarkets('solana', ['So11111111111111111111111111111111111111112']))['so11111111111111111111111111111111111111112'];
  const solUsd = solPrice?.solana?.usd ?? wsol?.priceUsd;
  const tokens = [];
  if (sol > 0) {
    tokens.push(compact({ symbol: 'SOL', name: 'Solana', balance: round(sol, 6), priceUSD: solUsd, valueUSD: solUsd ? round(sol * solUsd, 2) : undefined, change24h: round(solPrice?.solana?.usd_24h_change ?? wsol?.change24h, 2) }));
  }
  for (const h of holdings) {
    const m = markets[h.mint.toLowerCase()];
    // Only traded tokens (the rest is spam / dust).
    if (!m?.priceUsd || m.liquidity < MIN_LIQUIDITY_USD) continue;
    const value = h.tokenAmount.uiAmount * m.priceUsd;
    if (value < 0.01) continue;
    tokens.push(compact({ symbol: m.symbol ?? `${h.mint.slice(0, 4)}…`, name: m.name, balance: round(h.tokenAmount.uiAmount, 6), priceUSD: m.priceUsd, valueUSD: round(value, 2), change24h: round(m.change24h, 2), icon: m.icon }));
  }
  tokens.sort((a, b) => (b.valueUSD ?? 0) - (a.valueUSD ?? 0));
  const activity = (sigs ?? []).map((s) => ({
    hash: s.signature, type: 'SWAP', asset: 'Solana transaction', amount: 0,
    fromTo: address, timestamp: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : '',
    status: s.err ? 'PENDING' : 'CONFIRMED', network: 'solana', url: `https://solscan.io/tx/${s.signature}`,
  }));
  return {
    network: { id: 'solana', name: 'Solana', totalUSD: round(tokens.reduce((s, t) => s + (t.valueUSD ?? 0), 0), 2), nativeToken: 'SOL', tokens },
    activity,
  };
}

/** 24h changes: DexScreener for tokens (also dropping untraded ones), CoinGecko for native coins. */
async function addChanges(results) {
  const natives = [...new Set(results.flatMap((r) => r.network.tokens.map((t) => t.cgId).filter(Boolean)))];
  const nativeChanges = natives.length
    ? await cached(`cg:natives:${natives.join(',')}`, 60e3, () => getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${natives.join(',')}&vs_currencies=usd&include_24hr_change=true`)).catch(() => ({}))
    : {};
  await Promise.all(results.map(async (r) => {
    const contracts = r.network.tokens.map((t) => t.contract).filter(Boolean).slice(0, 60);
    const markets = contracts.length ? await dexMarkets(r.network.id, contracts) : {};
    r.network.tokens = r.network.tokens
      .filter((t) => !t.contract || (markets[String(t.contract).toLowerCase()]?.liquidity ?? 0) >= MIN_LIQUIDITY_USD)
      .map((t) => {
        const change = t.cgId ? nativeChanges?.[t.cgId]?.usd_24h_change : markets[String(t.contract).toLowerCase()]?.change24h;
        const { cgId, contract, ...rest } = t;
        return compact({ ...rest, change24h: rest.change24h ?? round(change, 2) });
      });
    r.network.totalUSD = round(r.network.tokens.reduce((s2, t) => s2 + (t.valueUSD ?? 0), 0), 2);
  }));
}

export async function enrichWallet(data) {
  const address = String(data?.address ?? '').trim();
  let results;
  if (isEvmAddress(address)) {
    results = await cached(`wallet:${address.toLowerCase()}`, 60e3, async () => {
      const chains = (await Promise.all(EVM_CHAINS.map((c) => loadEvmChain(c, address)))).filter(Boolean);
      await addChanges(chains);
      return chains;
    });
  } else if (isSolanaAddress(address)) {
    results = await cached(`wallet:sol:${address}`, 60e3, async () => [await loadSolana(address)].filter(Boolean));
  } else {
    return null;
  }
  const found = results.filter((c) => c.network.tokens.length || c.activity.length);
  if (!found.length) return null;
  const networks = found.map((c) => c.network).sort((a, b) => b.totalUSD - a.totalUSD);
  const total = networks.reduce((s, n) => s + n.totalUSD, 0);
  // Portfolio 24h change from each holding's own change.
  const change24hUSD = networks.flatMap((n) => n.tokens).reduce((s, t) => (
    t.change24h !== undefined && t.valueUSD ? s + t.valueUSD - t.valueUSD / (1 + t.change24h / 100) : s
  ), 0);
  const recentTransactions = found.flatMap((c) => c.activity)
    .filter((a) => a.timestamp)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 8);
  return {
    data: compact({
      totalValueUSD: round(total, 2),
      change24hUSD: round(change24hUSD, 2),
      change24hPercent: total > 0 ? round((change24hUSD / (total - change24hUSD)) * 100, 2) : undefined,
      networks, defaultNetwork: networks[0]?.id, recentTransactions,
    }),
    prefer: 'live',
    sources: ['Blockscout', 'CoinGecko', ...(isSolanaAddress(address) ? ['Solana RPC'] : [])],
  };
}
