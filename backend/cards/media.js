// Media: live Spotify playback (macOS), iTunes catalogue metadata, lrclib lyrics.
import { execFile } from 'child_process';
import { promisify } from 'util';
import { cached, compact, getJson, norm, round, sameName } from './util.js';

const execFileAsync = promisify(execFile);
const SEP = '\u001f';

// Never launches Spotify: only reads it when it is already running.
const SPOTIFY_SCRIPT = `if application "Spotify" is running then
  tell application "Spotify"
    set d to ASCII character 31
    return (player state as string) & d & (name of current track) & d & (artist of current track) & d & (album of current track) & d & ((duration of current track) as string) & d & ((player position) as string) & d & (artwork url of current track)
  end tell
end if
return ""`;

// AppleScript prints numbers in the Mac's locale ("12,5" in France).
const num = (s) => parseFloat(String(s ?? '').replace(',', '.'));

export function parseSpotify(stdout) {
  const parts = String(stdout ?? '').trim().split(SEP);
  if (parts.length < 7 || !parts[1]) return null;
  const [state, title, artist, album, durationMs, position, artwork] = parts;
  return compact({
    isPlaying: state === 'playing',
    title,
    artist,
    album,
    durationSec: round(num(durationMs) / 1000, 1),
    positionSec: round(num(position), 1),
    coverUrl: artwork || undefined,
  });
}

export async function spotifyNow() {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', SPOTIFY_SCRIPT], { timeout: 3000 });
    return parseSpotify(stdout);
  } catch {
    return null;
  }
}

/** "[01:02.34] line" → { t: 62.34, time: "1:02", text }. */
export function parseLrc(lrc) {
  const out = [];
  for (const line of String(lrc ?? '').split('\n')) {
    const m = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (!m) continue;
    const t = Number(m[1]) * 60 + Number(m[2]);
    out.push({ t: round(t, 2), time: `${m[1].replace(/^0(\d)/, '$1')}:${m[2].slice(0, 2)}`, text: m[3] || '♪' });
  }
  return out;
}

async function lyricsFor(title, artist, durationSec) {
  const key = `lrc:${norm(title)}:${norm(artist)}`;
  return cached(key, 24 * 3600e3, async () => {
    const q = `track_name=${encodeURIComponent(title)}${artist ? `&artist_name=${encodeURIComponent(artist)}` : ''}${durationSec ? `&duration=${Math.round(durationSec)}` : ''}`;
    let hit = artist ? await getJson(`https://lrclib.net/api/get?${q}`).catch(() => null) : null;
    if (!hit) {
      const list = await getJson(`https://lrclib.net/api/search?q=${encodeURIComponent(`${title} ${artist ?? ''}`.trim())}`).catch(() => []);
      hit = (list ?? []).find((r) => sameName(r.trackName, title) && (!artist || sameName(r.artistName, artist)));
    }
    if (!hit || hit.instrumental) return null;
    const synced = parseLrc(hit.syncedLyrics);
    if (synced.length) return { lyrics: synced, lyricsSynced: true };
    const plain = String(hit.plainLyrics ?? '').split('\n').map((text) => ({ text })).filter((l) => l.text.trim());
    return plain.length ? { lyrics: plain, lyricsSynced: false } : null;
  });
}

async function catalogue(title, artist) {
  return cached(`itunes:${norm(title)}:${norm(artist)}`, 24 * 3600e3, async () => {
    const res = await getJson(`https://itunes.apple.com/search?entity=song&limit=5&term=${encodeURIComponent(`${title} ${artist ?? ''}`.trim())}`);
    const hit = (res?.results ?? []).find((r) => sameName(r.trackName, title) && (!artist || sameName(r.artistName, artist)));
    if (!hit) return null;
    return compact({
      artist: hit.artistName,
      album: hit.collectionName,
      coverUrl: hit.artworkUrl100?.replace('100x100bb', '600x600bb'),
      genre: hit.primaryGenreName,
      releaseYear: hit.releaseDate?.slice(0, 4),
      durationSec: hit.trackTimeMillis ? round(hit.trackTimeMillis / 1000) : undefined,
    });
  });
}

export async function enrichMedia(data) {
  if (!data?.title) return null;
  const sources = [];
  const live = await spotifyNow();
  const isLive = live && sameName(live.title, data.title) && (!data.artist || sameName(live.artist, data.artist));
  const meta = await catalogue(data.title, data.artist ?? (isLive ? live.artist : undefined)).catch(() => null);
  const artist = data.artist ?? (isLive ? live.artist : meta?.artist);
  const durationSec = (isLive ? live.durationSec : undefined) ?? meta?.durationSec;
  const lyrics = await lyricsFor(data.title, artist, durationSec).catch(() => null);
  if (meta) sources.push('Apple Music catalogue');
  if (isLive) sources.push('Spotify · live');
  if (lyrics) sources.push('LRCLIB');
  if (!meta && !isLive && !lyrics) return null;
  const patch = compact({
    ...meta,
    ...(isLive ? { ...live, title: undefined, source: 'spotify' } : {}),
    durationSec,
    ...lyrics,
  });
  delete patch.title;
  return { data: patch, prefer: 'stated', sources, refreshMs: isLive ? 2000 : 0 };
}

const ACTIONS = { play: 'play', pause: 'pause', toggle: 'playpause', next: 'next track', prev: 'previous track' };

export async function spotifyControl(action) {
  if (process.platform !== 'darwin' || !ACTIONS[action]) throw new Error('unsupported');
  await execFileAsync('osascript', ['-e', `if application "Spotify" is running then tell application "Spotify" to ${ACTIONS[action]}`], { timeout: 3000 });
  await new Promise((r) => setTimeout(r, 250));
  return spotifyNow();
}
