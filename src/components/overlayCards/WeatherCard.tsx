import React from 'react';
import { motion } from 'framer-motion';
import {
  Sun, Cloud, CloudRain, CloudLightning, CloudSnow, CloudFog, CloudSun, Moon, MapPin, Thermometer, Droplets,
  Wind, Umbrella, Leaf, Eye, Gauge, Sunrise, Sunset, Clock, CalendarRange, Navigation, Droplet, CalendarDays, Radio,
} from 'lucide-react';
import type { WeatherData } from './types';
import { CardShell, CountUp, EASE, GrowBar, Reveal, SectionLabel, Stat, StatGrid } from './kit';
import { AmbientSky } from './motion';

type IconT = React.ComponentType<{ size?: number; className?: string; style?: React.CSSProperties }>;

const ICONS: Record<string, [IconT, string]> = {
  sunny: [Sun, '#FBBF24'],
  cloudy: [CloudSun, '#CBD5E1'],
  rain: [CloudRain, '#67E8F9'],
  thunderstorm: [CloudLightning, '#FCD34D'],
  snow: [CloudSnow, '#F8FAFC'],
  fog: [CloudFog, '#94A3B8'],
  night_clear: [Moon, '#C4B5FD'],
  night_cloudy: [Cloud, '#C4B5FD'],
};

const GRADIENTS: Record<string, string> = {
  sunny: 'linear-gradient(135deg, #1D4ED8 0%, #0369A1 50%, #082F49 100%)',
  cloudy: 'linear-gradient(135deg, #1E3A5F 0%, #172A45 55%, #0B1627 100%)',
  rain: 'linear-gradient(135deg, #102238 0%, #16304A 55%, #0A1624 100%)',
  thunderstorm: 'linear-gradient(135deg, #1A1438 0%, #12122B 55%, #0A0A1C 100%)',
  snow: 'linear-gradient(135deg, #2D4763 0%, #1C2E42 55%, #0F1B2A 100%)',
  fog: 'linear-gradient(135deg, #243447 0%, #1A2635 55%, #0F1822 100%)',
  night_clear: 'linear-gradient(135deg, #1E1B4B 0%, #111235 55%, #070A1C 100%)',
  night_cloudy: 'linear-gradient(135deg, #1F2340 0%, #151A30 55%, #0A0E1C 100%)',
};

const codeFor = (condition?: string, code?: string) => {
  if (code && ICONS[code]) return code;
  const c = (condition || '').toLowerCase();
  if (/thunder|lightning/.test(c)) return 'thunderstorm';
  if (/rain|drizzle|shower/.test(c)) return 'rain';
  if (/snow/.test(c)) return 'snow';
  if (/fog|mist/.test(c)) return 'fog';
  if (/cloud|overcast/.test(c)) return 'cloudy';
  if (/sun|clear/.test(c)) return 'sunny';
  return undefined;
};
const iconFor = (condition?: string, code?: string): [IconT, string] => ICONS[codeFor(condition, code) ?? ''] ?? [Thermometer, '#22D3EE'];

const AQI_COLORS = ['#34D399', '#A3E635', '#FBBF24', '#FB923C', '#EF4444', '#A855F7'];
const UV_COLORS = ['#34D399', '#FBBF24', '#FB923C', '#EF4444', '#A855F7'];

/** Coloured scale with a marker at the value (UV index, air quality). */
const ScaleBar: React.FC<{ percent: number; colors: string[] }> = ({ percent, colors }) => (
  <div className="relative mt-1.5 flex h-2.5 items-center">
    <div className="flex h-1 w-full overflow-hidden rounded-full opacity-85">
      {colors.map((c) => <div key={c} className="flex-1" style={{ background: c }} />)}
    </div>
    <motion.span
      className="absolute h-2.5 w-2.5 -translate-x-1/2 rounded-full border-2 border-[#02060C] bg-white"
      initial={{ left: '0%' }}
      animate={{ left: `${Math.max(0, Math.min(100, percent))}%` }}
      transition={{ type: 'spring', damping: 14, delay: 0.35 }}
    />
  </div>
);

const minutes = (hhmm?: string) => {
  const m = hhmm?.match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : undefined;
};

/** Sun cycle: an arc from sunrise to sunset with the sun at the place's local time. */
const SunCycle: React.FC<{ sunrise: string; sunset: string; now?: string }> = ({ sunrise, sunset, now }) => {
  const rise = minutes(sunrise);
  const set = minutes(sunset);
  const cur = minutes(now);
  const daylight = rise !== undefined && set !== undefined ? set - rise : undefined;
  const t = cur !== undefined && daylight ? Math.max(0, Math.min(1, (cur - rise!) / daylight)) : undefined;
  const isDay = cur !== undefined && rise !== undefined && set !== undefined && cur >= rise && cur <= set;
  const W = 300;
  const H = 76;
  const a = Math.PI * (1 - (t ?? 0));
  const sx = W / 2 + Math.cos(a) * (W / 2 - 8);
  const sy = H - Math.sin(a) * (H - 8);
  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-white/10 bg-black/35 p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">
        <Sunrise size={13} className="text-cyan-200" /> Sun cycle
        {daylight ? <span className="ml-auto font-normal normal-case tracking-normal text-slate-500">{Math.floor(daylight / 60)} h {daylight % 60} min of daylight</span> : null}
      </div>
      <svg viewBox={`0 0 ${W} ${H + 4}`} className="w-full">
        <path d={`M8,${H} A${W / 2 - 8},${H - 8} 0 0 1 ${W - 8},${H}`} stroke="rgba(251,191,36,0.35)" strokeWidth={2} strokeDasharray="4 5" fill="none" />
        <line x1={0} x2={W} y1={H} y2={H} stroke="rgba(255,255,255,0.12)" />
        <circle cx={8} cy={H} r={3} fill="#FBBF24" />
        <circle cx={W - 8} cy={H} r={3} fill="#FB923C" />
        {t !== undefined && isDay && (
          <motion.circle r={8} fill="#FCD34D" style={{ filter: 'drop-shadow(0 0 8px #FBBF24)' }} initial={{ cx: 8, cy: H }} animate={{ cx: sx, cy: sy }} transition={{ duration: 1.2, ease: EASE, delay: 0.4 }} />
        )}
      </svg>
      <div className="flex items-center justify-between text-[13px] tabular-nums">
        <span className="flex items-center gap-1"><Sunrise size={14} className="text-amber-400" />{sunrise}</span>
        {now && <span className="text-[11px] text-slate-500">{isDay ? `Now ${now}` : `Night · ${now}`}</span>}
        <span className="flex items-center gap-1">{sunset}<Sunset size={14} className="text-orange-400" /></span>
      </div>
    </div>
  );
};

export const WeatherCard: React.FC<{ data: WeatherData }> = ({ data }) => {
  const code = codeFor(data.condition, data.conditionCode);
  const [HeroIcon, iconColor] = iconFor(data.condition, data.conditionCode);
  const unit = data.tempUnit ? `°${data.tempUnit}` : '°';
  const tiles: Array<{ label: string; icon: IconT; value: string; side?: React.ReactNode; below?: React.ReactNode }> = [];
  if (data.feelsLike !== undefined) tiles.push({ label: 'Feels like', icon: Thermometer, value: `${data.feelsLike}${unit}` });
  if (data.humidity !== undefined) tiles.push({ label: 'Humidity', icon: Droplets, value: `${data.humidity}%`, below: <div className="mt-1.5"><GrowBar percent={data.humidity} color="#67E8F9" height={4} delay={0.4} /></div> });
  if (data.dewPoint !== undefined) tiles.push({ label: 'Dew point', icon: Droplet, value: `${data.dewPoint}${unit}` });
  if (data.windSpeed !== undefined) {
    tiles.push({
      label: 'Wind', icon: Wind, value: `${data.windSpeed} ${data.windUnit ?? ''}${data.windDirection ? ` ${data.windDirection}` : ''}`.trim(),
      side: data.windDegrees !== undefined ? (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-cyan-200/35">
          <motion.span initial={{ rotate: data.windDegrees + 60 }} animate={{ rotate: data.windDegrees + 180 - 45 }} transition={{ type: 'spring', damping: 9, stiffness: 60, delay: 0.3 }}>
            <Navigation size={14} className="text-cyan-200" />
          </motion.span>
        </span>
      ) : undefined,
    });
  }
  if (data.precipitationChance !== undefined) tiles.push({ label: 'Rain chance', icon: Umbrella, value: `${data.precipitationChance}%`, below: <div className="mt-1.5"><GrowBar percent={data.precipitationChance} color="#38BDF8" height={4} delay={0.45} /></div> });
  if (data.uvIndex !== undefined) tiles.push({ label: 'UV index', icon: Sun, value: `${data.uvIndex}${data.uvDescription ? ` · ${data.uvDescription}` : ''}`, below: <ScaleBar percent={(data.uvIndex / 11) * 100} colors={UV_COLORS} /> });
  if (data.airQuality !== undefined) tiles.push({ label: 'Air quality', icon: Leaf, value: `${data.airQuality}${data.airQualityStatus ? ` · ${data.airQualityStatus}` : ''}`, below: <ScaleBar percent={(data.airQuality / 120) * 100} colors={AQI_COLORS} /> });
  if (data.visibility !== undefined) tiles.push({ label: 'Visibility', icon: Eye, value: `${data.visibility} km` });
  if (data.pressure !== undefined) tiles.push({ label: 'Pressure', icon: Gauge, value: `${data.pressure} hPa` });
  // Sunrise/sunset get their own sun-cycle arc; single values fall back to tiles.
  if (data.sunrise && !data.sunset) tiles.push({ label: 'Sunrise', icon: Sunrise, value: data.sunrise });
  if (data.sunset && !data.sunrise) tiles.push({ label: 'Sunset', icon: Sunset, value: data.sunset });

  const hourly = data.hourlyForecast ?? [];
  const daily = data.dailyForecast ?? [];
  const withRange = daily.length > 1 && daily.every((d) => d.low !== undefined && d.high !== undefined);
  const minT = withRange ? Math.min(...daily.map((d) => d.low as number)) : 0;
  const range = withRange ? Math.max(1, Math.max(...daily.map((d) => d.high as number)) - minT) : 1;

  // The day the agent's answer is about ("demain", "tomorrow"…): it leads the card; the current
  // conditions move to "Right now". Live days are dated; without live data, the detector's own
  // "Tomorrow" entry stands in.
  const focusIndex = data.forecastDay
    ? (daily[data.forecastDay]?.date ? data.forecastDay : daily.findIndex((d) => d.day === 'Tomorrow' && data.forecastDay === 1))
    : -1;
  const focus = focusIndex >= 0 ? daily[focusIndex] : undefined;
  const focusName = data.forecastDay === 2 ? 'In 2 days' : 'Tomorrow';
  const focusDate = focus?.date
    ? new Date(`${focus.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    : undefined;
  const focusHours = focus?.date ? (data.hourlyAhead ?? []).filter((h) => h.date === focus.date) : [];
  const shownHours = focus ? focusHours : hourly;
  const heroCode = focus ? codeFor(focus.condition, focus.conditionCode) ?? code : code;
  const [HeroIconF, iconColorF] = focus ? iconFor(focus.condition, focus.conditionCode) : [HeroIcon, iconColor];
  const nowTemp = data.liveTemp ?? data.temp;

  return (
    <CardShell accent={iconColorF} gradient={GRADIENTS[heroCode ?? ''] ?? 'linear-gradient(135deg, #15263A 0%, #0F1D2E 55%, #081018 100%)'} ambient={<AmbientSky code={heroCode} />}>
      <div>
        {focus ? (
          <Reveal index={0} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex items-center gap-1.5 rounded-full border border-cyan-200/35 bg-cyan-200/15 px-2.5 py-0.5 text-[12px] font-semibold text-cyan-100">
                  <CalendarDays size={12} /> {focusName}{focusDate ? ` · ${focusDate}` : ''}
                </span>
                {data.city && (
                  <span className="flex items-center gap-1 text-[15px] font-semibold">
                    <MapPin size={14} className="text-cyan-200" />
                    <span className="truncate">{[data.city, data.region, data.country].filter(Boolean).join(', ')}</span>
                  </span>
                )}
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                {focus.high !== undefined && <CountUp value={focus.high} className="text-[64px] font-extralight leading-none tracking-tight" />}
                {focus.high !== undefined && <span className="text-xl text-slate-300">{unit}</span>}
                {focus.low !== undefined && (
                  <span className="text-[28px] font-light tabular-nums text-slate-400">/ {focus.low}°</span>
                )}
              </div>
              {focus.condition && <div className="text-[17px] font-medium text-slate-300">{focus.condition}</div>}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {focus.pop !== undefined && (
                  <span className="flex items-center gap-1 rounded-full bg-black/35 px-2.5 py-1 text-[12px] text-cyan-200"><Umbrella size={12} /> {focus.pop}% rain</span>
                )}
                {focus.uvIndex !== undefined && (
                  <span className="flex items-center gap-1 rounded-full bg-black/35 px-2.5 py-1 text-[12px] text-amber-200"><Sun size={12} /> UV {focus.uvIndex}</span>
                )}
                {focus.sunrise && focus.sunset && (
                  <span className="flex items-center gap-1 rounded-full bg-black/35 px-2.5 py-1 text-[12px] text-slate-300"><Sunrise size={12} className="text-amber-400" /> {focus.sunrise} – {focus.sunset}</span>
                )}
              </div>
            </div>
            <motion.div initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', damping: 10, stiffness: 140, delay: 0.15 }}>
              <motion.div animate={{ y: [0, -6, 0] }} transition={{ duration: 3.6, repeat: Infinity, ease: 'easeInOut' }}>
                <HeroIconF size={84} style={{ color: iconColorF, filter: `drop-shadow(0 0 18px ${iconColorF}66)` }} />
              </motion.div>
            </motion.div>
          </Reveal>
        ) : (
          <Reveal index={0} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              {data.city && (
                <div className="flex items-center gap-1.5 text-[17px] font-semibold">
                  <MapPin size={15} className="text-cyan-200" />
                  <span className="truncate">{[data.city, data.region, data.country].filter(Boolean).join(', ')}</span>
                </div>
              )}
              <div className="flex items-start">
                <CountUp value={data.temp} decimals={Number.isInteger(data.temp) ? 0 : 1} className="text-[64px] font-extralight leading-none tracking-tight" />
                <span className="mt-2 text-xl text-slate-300">{unit}</span>
              </div>
              {data.condition && <div className="text-[17px] font-medium text-slate-300">{data.condition}</div>}
              {(data.high !== undefined || data.low !== undefined) && (
                <div className="text-[13px] text-slate-400">
                  {[data.high !== undefined && `H ${data.high}°`, data.low !== undefined && `L ${data.low}°`].filter(Boolean).join('  ·  ')}
                </div>
              )}
            </div>
            <div>
              <motion.div initial={{ scale: 0.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', damping: 10, stiffness: 140, delay: 0.15 }}>
                <motion.div animate={{ y: [0, -6, 0] }} transition={{ duration: 3.6, repeat: Infinity, ease: 'easeInOut' }}>
                  <HeroIcon size={84} style={{ color: iconColor, filter: `drop-shadow(0 0 18px ${iconColor}66)` }} />
                </motion.div>
              </motion.div>
            </div>
          </Reveal>
        )}
      </div>

      {shownHours.length > 0 && (
        <Reveal index={1}>
          <SectionLabel icon={<Clock size={13} className="text-cyan-200" />}>{focus ? `${focusName}, hour by hour` : 'Next hours'}</SectionLabel>
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {shownHours.map((h, i) => {
              const [HI, hc] = iconFor(h.condition, h.conditionCode);
              return (
                <motion.div
                  key={`${h.time}-${i}`}
                  initial={{ opacity: 0, x: 16 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.12 + i * 0.035, type: 'spring', damping: 16 }}
                  whileHover={{ y: -3 }}
                  className={`flex shrink-0 flex-col items-center gap-1 rounded-xl px-3 py-2 ${i === 0 && !focus ? 'border border-cyan-200/35 bg-cyan-200/15' : 'bg-black/35'}`}
                >
                  <span className={`text-[11px] ${i === 0 && !focus ? 'text-slate-100' : 'text-slate-400'}`}>{h.time}</span>
                  <HI size={22} style={{ color: hc }} />
                  <span className="text-[15px] font-semibold tabular-nums">{h.temp}°</span>
                  <span className="h-3 text-[11px] text-cyan-300">{h.pop ? `${h.pop}%` : ''}</span>
                </motion.div>
              );
            })}
          </div>
        </Reveal>
      )}

      {daily.length > 0 && (
        <Reveal index={2}>
          <SectionLabel icon={<CalendarRange size={13} className="text-cyan-200" />}>{daily.length > 1 ? `${daily.length}-day forecast` : 'Forecast'}</SectionLabel>
          <div className="flex flex-col gap-2">
            {daily.map((d, i) => {
              const [DI, dc] = iconFor(d.condition, d.conditionCode);
              return (
                <Reveal key={`${d.day}-${i}`} index={3 + i} className={`flex items-center gap-2 rounded-lg text-[14px] ${i === focusIndex ? '-mx-2 border border-cyan-200/30 bg-cyan-200/10 px-2 py-1' : ''}`}>
                  <span className="w-12 font-medium">{d.day}</span>
                  {d.condition && <DI size={18} style={{ color: dc }} />}
                  <span className="w-8 text-[11px] text-cyan-300">{d.pop ? `${d.pop}%` : ''}</span>
                  {withRange ? (
                    <>
                      <span className="w-9 text-center tabular-nums text-slate-400">{d.low}°</span>
                      <div className="relative h-1.5 flex-1 rounded-full bg-white/10">
                        <motion.div
                          className="absolute h-1.5 rounded-full"
                          style={{ left: `${(((d.low as number) - minT) / range) * 100}%`, background: 'linear-gradient(90deg, #67E8F9, #FBBF24)' }}
                          initial={{ width: 0 }}
                          animate={{ width: `${Math.max(6, (((d.high as number) - (d.low as number)) / range) * 100)}%` }}
                          transition={{ duration: 0.7, ease: EASE, delay: 0.3 + i * 0.06 }}
                        />
                      </div>
                      <span className="w-9 text-center tabular-nums">{d.high}°</span>
                    </>
                  ) : (
                    <span className="flex-1 tabular-nums">
                      {[d.high !== undefined && `High ${d.high}°`, d.low !== undefined && `Low ${d.low}°`].filter(Boolean).join('  ·  ')}
                    </span>
                  )}
                </Reveal>
              );
            })}
          </div>
        </Reveal>
      )}

      {!focus && data.sunrise && data.sunset && (
        <Reveal index={3}>
          <SunCycle sunrise={data.sunrise} sunset={data.sunset} now={data.localTime} />
        </Reveal>
      )}

      {focus && (nowTemp !== undefined || tiles.length > 0) && (
        <Reveal index={3}>
          <SectionLabel icon={<Radio size={13} className="text-cyan-200" />}>
            Right now{nowTemp !== undefined ? ` · ${nowTemp}${unit}` : ''}{data.condition ? ` · ${data.condition}` : ''}
          </SectionLabel>
        </Reveal>
      )}

      {tiles.length > 0 && (
        <Reveal index={3}>
          <StatGrid>
            {tiles.map((t) => (
              <Stat key={t.label} label={t.label} icon={<t.icon size={13} className="text-cyan-200" />}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate">{t.value}</span>
                  {t.side}
                </div>
                {t.below}
              </Stat>
            ))}
          </StatGrid>
        </Reveal>
      )}
    </CardShell>
  );
};
