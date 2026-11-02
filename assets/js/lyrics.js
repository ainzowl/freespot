// Lyrics and descriptions.
//
// Both are optional extras: they load only when the user opens them, never block
// playback, and are cached in localStorage so a track's lyrics are fetched once.
//
// Lyrics come from LRCLIB (synced LRC when available, plain text otherwise) with
// lyrics.ovh as a fallback. Descriptions come from the same Invidious record the
// player already needs, so opening "About" usually costs one request at most.

import { LYRICS, STORAGE } from './config.js';
import { load, store, fetchWithTimeout } from './util.js';
import { ARTISTS } from './catalog.js';
import * as invidious from './invidious.js';

const META_KEY = STORAGE.meta;
const MAX_ENTRIES = 300;

const meta = load(META_KEY, {}) || {};

function remember(kind, id, value) {
  if (!id) return value;
  meta[`${kind}:${id}`] = { at: Date.now(), value };
  const keys = Object.keys(meta);
  if (keys.length > MAX_ENTRIES) {
    keys.sort((a, b) => (meta[a].at || 0) - (meta[b].at || 0))
      .slice(0, keys.length - MAX_ENTRIES)
      .forEach((k) => delete meta[k]);
  }
  store(META_KEY, meta);
  return value;
}

function recall(kind, id) {
  const hit = id && meta[`${kind}:${id}`];
  return hit ? hit.value : null;
}

// ---------------------------------------------------------------------------
// Title / artist parsing
// ---------------------------------------------------------------------------

const NOISE = /\s*[([][^)\]]*(official|video|audio|lyric|lyrics|visuali[sz]er|remaster|hd|4k|mv|m\/v|live|performance|explicit|clean|topic)[^)\]]*[)\]]/gi;

/** Split "Artist - Song (Official Video)" into its parts. */
export function parseTrack(track) {
  const title = String(track.title || '').replace(/\s+/g, ' ').trim();
  const artistKnown = (ARTISTS[track.artistId] || {}).name || '';

  let artist = artistKnown;
  let name = title;

  // "Artist - Song" is the common YouTube music upload shape.
  const parts = title.split(/\s+[–—-]\s+/);
  if (parts.length >= 2) {
    const first = parts[0].trim();
    const rest = parts.slice(1).join(' - ').trim();
    // Only trust the prefix when it looks like the channel or the title is long.
    if (first && rest && (first.length < 40)) {
      if (!artist || artist.toLowerCase().includes(first.toLowerCase()) || first.toLowerCase().includes(artist.toLowerCase())) {
        artist = artist || first;
        name = rest;
      } else if (first.length <= artist.length + 6) {
        name = rest;
      }
    }
  }

  name = name.replace(NOISE, '').replace(/\s+/g, ' ').trim();
  name = name.replace(/\s*[([][^)\]]*$/, '').trim();
  artist = String(artist || '').replace(NOISE, '').trim();

  return { artist, name: name || title };
}

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

export function parseLrc(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const stamps = [...line.matchAll(/\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const content = line.replace(/\[[^\]]*\]/g, '').trim();
    if (!content) continue;
    for (const match of stamps) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const frac = match[3] ? Number(`0.${match[3].padEnd(3, '0')}`) : 0;
      out.push({ time: minutes * 60 + seconds + frac, text: content });
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

async function getJson(url) {
  const res = await fetchWithTimeout(url, { headers: { Accept: 'application/json' } }, 9000);
  if (!res.ok) throw new Error(`Lyrics unavailable (${res.status})`);
  return res.json();
}

/**
 * Fetch lyrics for a track.
 *
 * Returns `{ synced, plain, lines, source }` or null when nothing was found.
 * Nothing here throws: a missing lyric is normal, not an error.
 */
export async function lyricsFor(track) {
  if (!track) return null;
  const cached = recall('lyrics', track.videoId);
  if (cached !== null) return cached;

  const { artist, name } = parseTrack(track);
  if (!name) return remember('lyrics', track.videoId, null);

  // 1. Exact LRCLIB match (gives synced lyrics when they exist).
  try {
    const qs = new URLSearchParams({ track_name: name });
    if (artist) qs.set('artist_name', artist);
    const data = await getJson(`${LYRICS.lrclib}/get?${qs}`);
    const synced = String(data.syncedLyrics || '');
    const plain = String(data.plainLyrics || '');
    if (synced || plain) {
      return remember('lyrics', track.videoId, {
        synced: !!synced,
        plain: plain || synced,
        lines: synced ? parseLrc(synced) : [],
        source: 'LRCLIB',
      });
    }
  } catch {}

  // 2. LRCLIB search, best-effort match on the same title.
  try {
    const qs = new URLSearchParams({ q: `${artist ? `${artist} ` : ''}${name}`.trim() });
    const list = await getJson(`${LYRICS.lrclib}/search?${qs}`);
    const rows = Array.isArray(list) ? list : [];
    const lower = name.toLowerCase();
    const best = rows.find((row) => String(row.trackName || '').toLowerCase().includes(lower) && row.syncedLyrics)
      || rows.find((row) => String(row.trackName || '').toLowerCase().includes(lower) && row.plainLyrics)
      || rows.find((row) => row.syncedLyrics || row.plainLyrics);
    if (best) {
      const synced = String(best.syncedLyrics || '');
      const plain = String(best.plainLyrics || '');
      return remember('lyrics', track.videoId, {
        synced: !!synced,
        plain: plain || synced,
        lines: synced ? parseLrc(synced) : [],
        source: 'LRCLIB',
      });
    }
  } catch {}

  // 3. lyrics.ovh, plain text only.
  if (artist) {
    try {
      const data = await getJson(`${LYRICS.ovh}/${encodeURIComponent(artist)}/${encodeURIComponent(name)}`);
      const text = String(data.lyrics || '').trim();
      if (text) {
        return remember('lyrics', track.videoId, {
          synced: false,
          plain: text,
          lines: [],
          source: 'lyrics.ovh',
        });
      }
    } catch {}
  }

  return remember('lyrics', track.videoId, null);
}

// ---------------------------------------------------------------------------
// Description
// ---------------------------------------------------------------------------

/** Full description for a track, cached after the first lookup. */
export async function descriptionFor(track) {
  if (!track || !track.videoId) return '';

  const cached = recall('desc', track.videoId);
  if (cached !== null) return cached;

  if (track.description) return remember('desc', track.videoId, String(track.description).trim());

  try {
    const info = await invidious.video(track.videoId);
    return remember('desc', track.videoId, String(info.description || '').trim());
  } catch {
    return '';
  }
}

/** Fetch description + lyrics together for the About sheet. */
export async function detailsFor(track) {
  const [description, lyrics] = await Promise.allSettled([
    descriptionFor(track),
    lyricsFor(track),
  ]);
  return {
    description: description.status === 'fulfilled' ? description.value : '',
    lyrics: lyrics.status === 'fulfilled' ? lyrics.value : null,
  };
}

export function clearMeta() {
  for (const key of Object.keys(meta)) delete meta[key];
  store(META_KEY, meta);
}
