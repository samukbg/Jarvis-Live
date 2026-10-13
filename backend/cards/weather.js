// Weather: Open-Meteo forecast + air quality for the city the agent named.
import { cached, compact, getJson, norm, round } from './util.js';

const WMO = {
  0: ['Clear sky', 'sunny'], 1: ['Mainly clear', 'sunny'], 2: ['Partly cloudy', 'cloudy'], 3: ['Overcast', 'cloudy'],
  45: ['Fog', 'fog'], 48: ['Freezing fog', 'fog'],
  51: ['Light drizzle', 'rain'], 53: ['Drizzle', 'rain'], 55: ['Heavy drizzle', 'rain'], 56: ['Freezing drizzle', 'rain'], 57: ['Freezing drizzle', 'rain'],
  61: ['Light rain', 'rain'], 63: ['Rain', 'rain'], 65: ['Heavy rain', 'rain'], 66: ['Freezing rain', 'rain'], 67: ['Freezing rain', 'rain'],
  71: ['Light snow', 'snow'], 73: ['Snow', 'snow'], 75: ['Heavy snow', 'snow'], 77: ['Snow grains', 'snow'],
  80: ['Light showers', 'rain'], 81: ['Showers', 'rain'], 82: ['Violent showers', 'rain'], 85: ['Snow showers', 'snow'], 86: ['Snow showers', 'snow'],
  95: ['Thunderstorm', 'thunderstorm'], 96: ['Thunderstorm with hail', 'thunderstorm'], 99: ['Thunderstorm with hail', 'thunderstorm'],
};

export function wmo(code, isDay = true) {
  const [condition, base] = WMO[code] ?? [undefined, undefined];
  let conditionCode = base;
  if (!isDay && base === 'sunny') conditionCode = 'night_clear';
  if (!isDay && base === 'cloudy') conditionCode = 'night_cloudy';
  return { condition, conditionCode };
}

export function compass(deg) {
  if (!Number.isFinite(deg)) return undefined;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

export function aqiStatus(eaqi) {
  if (!Number.isFinite(eaqi)) return undefined;
  if (eaqi <= 20) return 'Good';
  if (eaqi <= 40) return 'Fair';
  if (eaqi <= 60) return 'Moderate';
  if (eaqi <= 80) return 'Poor';
  if (eaqi <= 100) return 'Very poor';
  return 'Extremely poor';
}

export function uvDescription(uv) {
  if (!Number.isFinite(uv)) return undefined;
  if (uv < 3) return 'Low';
  if (uv < 6) return 'Moderate';
  if (uv < 8) return 'High';
  if (uv < 11) return 'Very high';
  return 'Extreme';
}

const hhmm = (iso) => (typeof iso === 'string' && iso.includes('T') ? iso.split('T')[1].slice(0, 5) : undefined);
const weekday = (date, i) =>
  i === 0 ? 'Today' : new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

/** Maps Open-Meteo responses to WeatherData fields. */
export function mapForecast(f, aq) {
  const c = f.current ?? {};
  const isDay = c.is_day !== 0;
  const now = wmo(c.weather_code, isDay);
  const h = f.hourly ?? {};
  const d = f.daily ?? {};
  const hourlyForecast = (h.time ?? []).slice(0, 24).map((t, i) => compact({
    time: i === 0 ? 'Now' : hhmm(t),
    temp: round(h.temperature_2m?.[i]),
    condition: wmo(h.weather_code?.[i], h.is_day?.[i] !== 0).condition,
    conditionCode: wmo(h.weather_code?.[i], h.is_day?.[i] !== 0).conditionCode,
    pop: h.precipitation_probability?.[i] ?? undefined,
  }));
  // 48 hours with their date: a "tomorrow" answer shows tomorrow's hours.
  const hourlyAhead = (h.time ?? []).slice(0, 48).map((t, i) => compact({
    date: t.slice(0, 10),
    time: hhmm(t),
    temp: round(h.temperature_2m?.[i]),
    condition: wmo(h.weather_code?.[i], h.is_day?.[i] !== 0).condition,
    conditionCode: wmo(h.weather_code?.[i], h.is_day?.[i] !== 0).conditionCode,
    pop: h.precipitation_probability?.[i] ?? undefined,
  }));
  const dailyForecast = (d.time ?? []).map((t, i) => compact({
    date: t,
    day: weekday(t, i),
    sunrise: hhmm(d.sunrise?.[i]),
    sunset: hhmm(d.sunset?.[i]),
    uvIndex: round(d.uv_index_max?.[i], 1),
    condition: wmo(d.weather_code?.[i]).condition,
    conditionCode: wmo(d.weather_code?.[i]).conditionCode,
    high: round(d.temperature_2m_max?.[i]),
    low: round(d.temperature_2m_min?.[i]),
    pop: d.precipitation_probability_max?.[i] ?? undefined,
  }));
  const eaqi = aq?.current?.european_aqi;
  return compact({
    liveTemp: round(c.temperature_2m, 1),
    condition: now.condition,
    conditionCode: now.conditionCode,
    isDay,
    high: round(d.temperature_2m_max?.[0]),
    low: round(d.temperature_2m_min?.[0]),
    feelsLike: round(c.apparent_temperature),
    humidity: c.relative_humidity_2m,
    dewPoint: round(c.dew_point_2m),
    localTime: hhmm(c.time),
    windSpeed: round(c.wind_speed_10m),
    windUnit: f.current_units?.wind_speed_10m ?? 'km/h',
    windDirection: compass(c.wind_direction_10m),
    windDegrees: c.wind_direction_10m,
    uvIndex: round(c.uv_index ?? d.uv_index_max?.[0], 1),
    uvDescription: uvDescription(c.uv_index ?? d.uv_index_max?.[0]),
    pressure: round(c.pressure_msl),
    visibility: Number.isFinite(c.visibility) ? round(c.visibility / 1000, 1) : undefined,
    sunrise: hhmm(d.sunrise?.[0]),
    sunset: hhmm(d.sunset?.[0]),
    precipitationChance: d.precipitation_probability_max?.[0] ?? undefined,
    airQuality: round(eaqi),
    airQualityStatus: aqiStatus(eaqi),
    hourlyForecast,
    hourlyAhead,
    dailyForecast,
  });
}

/**
 * Wrong-place guard: the agent's temperature must fit this place's weather — now, or any day
 * of the forecast (a "tomorrow" answer states tomorrow's low/high, not the current reading).
 */
export function plausibleTemp(stated, patch) {
  if (!Number.isFinite(stated)) return true;
  if (Number.isFinite(patch.liveTemp) && Math.abs(stated - patch.liveTemp) <= 8) return true;
  const days = (patch.dailyForecast ?? []).filter((d) => Number.isFinite(d.low) && Number.isFinite(d.high));
  if (!days.length) return !Number.isFinite(patch.liveTemp);
  const lo = Math.min(...days.map((d) => d.low));
  const hi = Math.max(...days.map((d) => d.high));
  return stated >= lo - 4 && stated <= hi + 4;
}

const GEO_LANGUAGES = ['pt', 'es', 'fr', 'de', 'it'];
const geoSearch = (city, language) => cached(`geo:${language}:${norm(city)}`, 24 * 3600e3, () =>
  getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=8&language=${language}&format=json`))
  .then((res) => res?.results ?? [])
  .catch(() => []);

async function geocode(city, country) {
  let list = await geoSearch(city, 'en');
  // A city in its own language ("Lisboa", "Wien") finds only villages in English: when the best
  // match is not a real town, the other languages' matches count too, the biggest first.
  if (!(list[0]?.population >= 10_000)) {
    const more = (await Promise.all(GEO_LANGUAGES.map((l) => geoSearch(city, l)))).flat();
    const seen = new Set();
    list = [...list, ...more]
      .filter((r) => !seen.has(r.id) && seen.add(r.id))
      .sort((a, b) => (b.population || 0) - (a.population || 0));
  }
  if (!list.length) return null;
  if (country) {
    const want = norm(country);
    const hit = list.find((r) => norm(r.country) === want || norm(r.country_code) === want || norm(r.admin1) === want);
    if (hit) return hit;
  }
  return list[0];
}

export async function enrichWeather(data) {
  if (!data?.city) return null;
  const place = await geocode(data.city, data.country ?? data.region);
  if (!place) return null;
  const unit = data.tempUnit === 'F' ? 'fahrenheit' : 'celsius';
  const q = `latitude=${place.latitude}&longitude=${place.longitude}&timezone=auto`;
  const [f, aq] = await cached(`wx:${place.id}:${unit}`, 10 * 60e3, () => Promise.all([
    getJson(`https://api.open-meteo.com/v1/forecast?${q}&temperature_unit=${unit}&forecast_days=7&forecast_hours=48`
      + '&current=temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,is_day,weather_code,wind_speed_10m,wind_direction_10m,pressure_msl,visibility,uv_index'
      + '&hourly=temperature_2m,weather_code,precipitation_probability,is_day'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,uv_index_max,precipitation_probability_max'),
    getJson(`https://air-quality-api.open-meteo.com/v1/air-quality?${q}&current=european_aqi`).catch(() => null),
  ]));
  const patch = mapForecast(f, aq);
  if (!plausibleTemp(data.temp, patch)) return null;
  return {
    data: { ...patch, city: place.name, country: place.country, latitude: place.latitude, longitude: place.longitude },
    prefer: 'stated',
    sources: ['Open-Meteo'],
  };
}
