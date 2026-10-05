// Flight: route + airline from adsbdb, live position from adsb.lol, aircraft from adsbdb.
import { cached, compact, getJson, haversineKm, round } from './util.js';

export const callsignOf = (flightNumber) => String(flightNumber ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const codeMatches = (stated, airport) =>
  !stated || [airport?.iata_code, airport?.icao_code].some((c) => c && c.toUpperCase() === String(stated).toUpperCase());

const airportPatch = (a) => compact({ city: a.municipality, airport: a.name, latitude: a.latitude, longitude: a.longitude });

/** Share of the great-circle route flown, from the live position. */
export function routeProgress(origin, destination, lat, lon) {
  const done = haversineKm(origin.latitude, origin.longitude, lat, lon);
  const left = haversineKm(lat, lon, destination.latitude, destination.longitude);
  return done + left > 0 ? Math.max(0, Math.min(100, Math.round((done / (done + left)) * 100))) : undefined;
}

export function mapLive(ac) {
  if (!ac || !Number.isFinite(ac.lat)) return null;
  const onGround = ac.alt_baro === 'ground';
  return compact({
    latitude: ac.lat,
    longitude: ac.lon,
    altitudeFt: onGround ? 0 : ac.alt_baro,
    speedKts: round(ac.gs),
    heading: round(ac.track ?? ac.true_heading),
    verticalRateFpm: ac.baro_rate,
    onGround,
    registration: ac.r,
    typeCode: ac.t,
  });
}

export async function enrichFlight(data) {
  const cs = callsignOf(data?.flightNumber);
  if (cs.length < 3) return null;
  const route = await cached(`route:${cs}`, 6 * 3600e3, () => getJson(`https://api.adsbdb.com/v0/callsign/${cs}`).then((r) => r?.response?.flightroute).catch(() => null));
  const routeOk = route && codeMatches(data.origin?.code, route.origin) && codeMatches(data.destination?.code, route.destination);
  const icao = route?.callsign_icao ?? cs;
  const ac = await cached(`live:${icao}`, 25e3, () => getJson(`https://api.adsb.lol/v2/callsign/${icao}`).then((r) => r?.ac?.[0]).catch(() => null));
  const live = mapLive(ac);
  const aircraft = live?.registration
    ? await cached(`aircraft:${live.registration}`, 24 * 3600e3, () => getJson(`https://api.adsbdb.com/v0/aircraft/${live.registration}`).then((r) => r?.response?.aircraft).catch(() => null))
    : null;
  if (!routeOk && !live) return null;

  const patch = compact({
    airline: routeOk ? route.airline?.name : undefined,
    origin: routeOk ? airportPatch(route.origin) : undefined,
    destination: routeOk ? airportPatch(route.destination) : undefined,
    live: live ?? undefined,
    status: live ? (live.onGround ? undefined : 'IN FLIGHT') : undefined,
    progressPercent: live && routeOk && !live.onGround ? routeProgress(route.origin, route.destination, live.latitude, live.longitude) : undefined,
    altitude: live && !live.onGround && live.altitudeFt ? `${Math.round(live.altitudeFt).toLocaleString('en-US')} ft` : undefined,
    speed: live?.speedKts ? `${live.speedKts} kts` : undefined,
    aircraft: aircraft ? [aircraft.manufacturer, aircraft.type].filter(Boolean).join(' ') : live?.typeCode,
    registration: live?.registration,
    aircraftPhotoUrl: aircraft?.url_photo ?? undefined,
  });
  const sources = [routeOk && 'adsbdb', live && 'ADSB.lol · live'].filter(Boolean);
  return { data: patch, prefer: 'live', sources, refreshMs: live && !live.onGround ? 30e3 : 0 };
}
