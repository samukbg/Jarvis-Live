// Sports: finds the match on ESPN's public scoreboards and reads its summary.
import { cached, compact, getJson, sameName } from './util.js';

const ESPN = 'https://site.web.api.espn.com/apis/site/v2/sports';
const SPORTS = ['soccer/all', 'basketball/nba', 'football/nfl', 'hockey/nhl', 'baseball/mlb', 'basketball/wnba'];

// Order and labels of the stats worth showing, per ESPN stat name.
const STAT_ORDER = [
  ['possessionPct', 'Possession', '%'], ['totalShots', 'Shots'], ['shotsOnTarget', 'Shots on target'], ['wonCorners', 'Corners'],
  ['foulsCommitted', 'Fouls'], ['yellowCards', 'Yellow cards'], ['redCards', 'Red cards'], ['saves', 'Saves'], ['offsides', 'Offsides'],
  ['fieldGoalPct', 'Field goal %'], ['threePointFieldGoalPct', '3-point %'], ['totalRebounds', 'Rebounds'], ['assists', 'Assists'], ['turnovers', 'Turnovers'],
  ['totalYards', 'Total yards'], ['passingYards', 'Passing yards'], ['rushingYards', 'Rushing yards'], ['firstDowns', 'First downs'],
  ['shotsTotal', 'Shots'], ['hits', 'Hits'], ['powerPlayGoals', 'Power-play goals'], ['faceoffPercent', 'Faceoff %'],
];

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');

const teamNames = (c) => [c.team?.displayName, c.team?.shortDisplayName, c.team?.name, c.team?.location].filter(Boolean);
const matchesTeam = (c, name) => teamNames(c).some((n) => sameName(n, name));

export function findEvent(events, a, b) {
  for (const e of events ?? []) {
    const comps = e.competitions?.[0]?.competitors ?? [];
    const ca = comps.find((c) => matchesTeam(c, a));
    const cb = comps.find((c) => c !== ca && matchesTeam(c, b));
    if (ca && cb) return { event: e, ca, cb };
  }
  return null;
}

export function mapStats(boxTeams, idA, idB) {
  const byId = Object.fromEntries((boxTeams ?? []).map((t) => [t.team?.id, Object.fromEntries((t.statistics ?? []).map((s) => [s.name, s.displayValue]))]));
  const A = byId[idA];
  const B = byId[idB];
  if (!A || !B) return [];
  return STAT_ORDER.filter(([k]) => A[k] !== undefined && B[k] !== undefined)
    .slice(0, 7)
    .map(([k, label, suffix = '']) => ({ label, valueA: `${A[k]}${suffix}`, valueB: `${B[k]}${suffix}` }));
}

export function mapScorers(keyEvents, teamId) {
  return (keyEvents ?? [])
    .filter((k) => /goal/i.test(k.type?.type ?? k.type?.text ?? '') && !/disallowed|missed/i.test(k.type?.text ?? '') && k.team?.id === teamId)
    .map((k) => `${k.participants?.[0]?.athlete?.displayName ?? 'Goal'} ${k.clock?.displayValue ?? ''}`.trim());
}

async function scoreboard(sport, date) {
  return cached(`espn:${sport}:${date}`, 30e3, () => getJson(`${ESPN}/${sport}/scoreboard?dates=${date}&limit=400`).then((r) => r.events ?? []).catch(() => []));
}

export async function enrichSports(data) {
  const a = data?.teamA?.name;
  const b = data?.teamB?.name;
  if (!a || !b) return null;
  const today = new Date();
  const days = [ymd(today), ymd(new Date(today.getTime() - 86400e3))];
  let found = null;
  let sport = null;
  for (const s of SPORTS) {
    for (const d of days) {
      found = findEvent(await scoreboard(s, d), a, b);
      if (found) { sport = s; break; }
    }
    if (found) break;
  }
  if (!found) return null;
  const { event, ca, cb } = found;
  const summary = await cached(`espn:sum:${event.id}`, 30e3, () => getJson(`${ESPN}/${sport}/summary?event=${event.id}`).catch(() => null));
  const status = event.competitions?.[0]?.status ?? event.status;
  const live = status?.type?.state === 'in';
  const team = (c) => compact({
    score: Number.isFinite(Number(c.score)) ? Number(c.score) : undefined,
    logo: c.team?.logo,
    scorers: mapScorers(summary?.keyEvents, c.team?.id),
  });
  const patch = compact({
    league: summary?.header?.league?.name ?? event.season?.slug,
    status: status?.type?.shortDetail ?? status?.type?.description,
    live,
    venue: event.competitions?.[0]?.venue?.fullName,
    startTime: event.date,
    teamA: team(ca),
    teamB: team(cb),
    stats: mapStats(summary?.boxscore?.teams, ca.team?.id, cb.team?.id),
  });
  return { data: patch, prefer: 'live', sources: [live ? 'ESPN · live' : 'ESPN'], refreshMs: live ? 30e3 : 0 };
}
