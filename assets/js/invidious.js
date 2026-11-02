// Invidious: keyless public mirrors for audio streams and video metadata.
//
// These instances proxy the media themselves (`?local=true`), which means the
// resulting URL sends CORS headers and supports Range requests. That matters for
// two things the app needs and YouTube itself refuses to give a browser:
//
//   1. playing videos whose owner disabled embedding, and
//   2. downloading a real audio file we can read, report progress for, and store
//      in the Cache API for offline playback.
//
// Instances are community-run and disappear, so every call walks a small list,
// remembers the one that answered, and gives up quickly on dead hosts.

import { INVIDIOUS, STORAGE } from './config.js';
import { fetchWithTimeout, load, store } from './util.js';

const CACHE_TTL = 30 * 60 * 1000;
const REQUEST_TIMEOUT = 9000;

// Resolved stream URLs are signed and short-lived, but resolving one costs a
// round trip to a mirror that may be slow or down. They are kept in memory and
// mirrored to localStorage so a reload, or a second download of the same track,
// reuses the URL instead of issuing a fresh resolution.
//
// A proxied URL is ~1.2 KB, so the store is capped to keep localStorage small.
const STREAM_TTL = 6 * 60 * 60 * 1000;
const MAX_STORED_STREAMS = 120;
const STREAM_STORE = STORAGE.streams;

// Preferred quality order: m4a 128k first (plays everywhere, including iOS),
// then m4a 48k, then opus which Safari cannot always decode.
const AUDIO_ITAGS = ['140', '139', '251', '250', '249'];

let preferred = INVIDIOUS[0];
const videoCache = new Map();
const audioCache = new Map();
const streamStore = readStreamStore();

/**
 * Signed googlevideo URLs carry `expire=<unix seconds>`. A proxied mirror URL
 * usually keeps that parameter, so its real lifetime can be read instead of
 * guessed; anything without one falls back to a conservative TTL.
 */
function expiryOf(url, fallback) {
  try {
    const value = Number(new URL(url).searchParams.get('expire'));
    if (isFinite(value) && value > 0) return value * 1000;
  } catch {}
  return fallback;
}

function readStreamStore() {
  const raw = load(STREAM_STORE, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function persistStreams() {
  try {
    const entries = Object.entries(streamStore)
      .filter(([, entry]) => entry && entry.expiresAt > Date.now())
      .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
      .slice(0, MAX_STORED_STREAMS);
    store(STREAM_STORE, Object.fromEntries(entries));
  } catch {}
}

function rememberedStreams(videoId) {
  const entry = streamStore[videoId];
  if (!entry || !Array.isArray(entry.list)) return null;
  if (entry.expiresAt <= Date.now()) {
    delete streamStore[videoId];
    persistStreams();
    return null;
  }
  return entry.list;
}

function rememberStreams(videoId, list) {
  const expiresAt = Math.min(...list.map((s) => expiryOf(s.url, Date.now() + STREAM_TTL)));
  streamStore[videoId] = { at: Date.now(), expiresAt, list };
  persistStreams();
}

/** Instances in the order they should be tried. */
export function instances() {
  return preferred
    ? [preferred, ...INVIDIOUS.filter((i) => i !== preferred)]
    : INVIDIOUS.slice();
}

/** Remember an instance that answered, so later calls skip dead hosts. */
export function prefer(base) {
  if (INVIDIOUS.includes(base)) preferred = base;
}

async function getJson(base, path) {
  const res = await fetchWithTimeout(`${base}${path}`, { headers: { Accept: 'application/json' } }, REQUEST_TIMEOUT);
  if (!res.ok) throw new Error(`${new URL(base).host} returned ${res.status}`);
  return res.json();
}

/** Walk every instance until one answers. */
async function first(path) {
  let lastError = null;
  for (const base of instances()) {
    try {
      const json = await getJson(base, path);
      prefer(base);
      return { base, json };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Public mirrors are unreachable');
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

const VIDEO_FIELDS = [
  'title', 'author', 'authorId', 'lengthSeconds', 'videoThumbnails',
  'description', 'descriptionHtml', 'viewCount', 'publishedText',
].join(',');

/** Full record for one video, including its description. Cached per session. */
export async function video(videoId) {
  const key = String(videoId);
  const hit = videoCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;

  const { base, json } = await first(`/api/v1/videos/${encodeURIComponent(key)}?fields=${VIDEO_FIELDS}`);
  const thumbs = Array.isArray(json.videoThumbnails) ? json.videoThumbnails : [];
  const best = thumbs.find((t) => t.quality === 'maxres' || t.quality === 'maxresdefault')
    || thumbs.find((t) => t.quality === 'high')
    || thumbs[thumbs.length - 1]
    || null;

  const description = descriptionText(json);
  const data = {
    id: key,
    title: json.title || '',
    author: json.author || '',
    authorId: json.authorId || '',
    lengthSeconds: Number(json.lengthSeconds) || 0,
    thumb: best ? best.url : '',
    description,
    views: Number(json.viewCount) || 0,
    published: json.publishedText || '',
    instance: base,
  };
  videoCache.set(key, { at: Date.now(), data });
  return data;
}

function descriptionText(json) {
  const plain = String(json.description || '').trim();
  if (plain) return plain;
  const html = String(json.descriptionHtml || '');
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

/**
 * Direct audio URL for a video.
 *
 * The returned URL is the instance's own proxy (`local=true`), so it is
 * same-origin to that instance and sends `Access-Control-Allow-Origin: *`.
 * Resolves once and is reused for playback and download until it expires.
 */
export async function audio(videoId) {
  return (await audioStreams(videoId))[0];
}

/**
 * Direct audio URL for a video, from one specific instance.
 *
 * Fetched separately per instance so a mirror that answers metadata but refuses
 * the media (a common partial outage) can be skipped by the caller.
 */
export async function audioFrom(videoId, base) {
  const json = await getJson(
    base,
    `/api/v1/videos/${encodeURIComponent(videoId)}?fields=adaptiveFormats,lengthSeconds&local=true`
  );

  const formats = Array.isArray(json.adaptiveFormats) ? json.adaptiveFormats : [];
  let format = null;
  for (const itag of AUDIO_ITAGS) {
    format = formats.find((f) => String(f.itag) === itag && f.url);
    if (format) break;
  }
  if (!format) format = formats.find((f) => f.url && /^audio\//.test(f.type || f.mimeType || ''));
  if (!format) throw new Error('No audio stream for this video');

  return {
    url: format.url,
    instance: base,
    itag: String(format.itag || ''),
    mime: String(format.type || format.mimeType || 'audio/mp4').split(';')[0],
    length: Number(format.clen) || 0,
    duration: Number(json.lengthSeconds) || 0,
  };
}

/**
 * Audio stream metadata, tried across instances best-first.
 *
 * Resolution is expensive and mirrors are flaky, so the result is cached three
 * ways: in memory for the session, on disk across reloads, and with a real
 * expiry read from the signed URL. A stored URL that is still valid is returned
 * without touching the network at all.
 */
export async function audioStreams(videoId) {
  const key = String(videoId);

  const hit = audioCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL && hit.list) return hit.list;

  const stored = rememberedStreams(key);
  if (stored) {
    audioCache.set(key, { at: Date.now(), data: stored[0], list: stored });
    return stored;
  }

  const list = [];
  for (const base of instances()) {
    try {
      const stream = await audioFrom(key, base);
      prefer(base);
      list.push(stream);
    } catch {
      // This instance cannot resolve it; the next one might.
    }
    if (list.length >= 3) break;
  }
  if (!list.length) throw new Error('No audio stream for this video');

  audioCache.set(key, { at: Date.now(), data: list[0], list });
  rememberStreams(key, list);
  return list;
}

/**
 * Every plausible stream URL, best first.
 *
 * Used by the player: the resolves from each instance are tried in order, then
 * the cheaper `latest_version` redirects as a last resort. The caller walks the
 * list until one actually starts.
 */
export async function audioCandidates(videoId) {
  const candidates = [];
  try {
    for (const stream of await audioStreams(videoId)) {
      if (!candidates.includes(stream.url)) candidates.push(stream.url);
    }
  } catch {}

  for (const base of instances()) {
    const url = `${base}/latest_version?id=${encodeURIComponent(videoId)}&itag=140&local=true`;
    if (!candidates.includes(url)) candidates.push(url);
  }
  return candidates;
}

/** Forget cached URLs (they are signed and expire). */
export function forget(videoId) {
  if (videoId) {
    audioCache.delete(String(videoId));
    videoCache.delete(String(videoId));
    delete streamStore[String(videoId)];
    persistStreams();
  } else {
    audioCache.clear();
    videoCache.clear();
    for (const key of Object.keys(streamStore)) delete streamStore[key];
    persistStreams();
  }
}

// ---------------------------------------------------------------------------
// Search, channels, playlists, trending
// ---------------------------------------------------------------------------

function thumbOf(item) {
  const list = item.videoThumbnails || item.authorThumbnails || [];
  const best = list.find((t) => t.quality === 'maxres' || t.quality === 'maxresdefault')
    || list.find((t) => t.quality === 'high')
    || list[list.length - 1]
    || null;
  return best ? best.url : (item.playlistThumbnail || '');
}

function toVideo(item) {
  if (!item || !item.videoId) return null;
  return {
    id: item.videoId,
    title: item.title || 'Untitled',
    channel: item.author || '',
    channelId: item.authorId || null,
    thumb: thumbOf(item),
    duration: Number(item.lengthSeconds) > 0 ? Number(item.lengthSeconds) : 0,
    durationText: item.lengthText || '',
  };
}

export async function search(query, type = 'video') {
  const { json } = await first(`/api/v1/search?q=${encodeURIComponent(query)}&type=${type}`);
  return Array.isArray(json) ? json : [];
}

export async function searchAll(query) {
  const [videos, channels, playlists] = await Promise.allSettled([
    search(query, 'video'),
    search(query, 'channel'),
    search(query, 'playlist'),
  ]);
  const take = (r) => (r.status === 'fulfilled' ? r.value : []);
  return {
    videos: take(videos).map(toVideo).filter(Boolean).map((v) => ({ ...v, durationText: v.duration ? '' : '' })),
    channels: take(channels).map((c) => ({
      id: c.authorId,
      name: c.author,
      thumb: thumbOf(c),
      subscriberCount: Number(c.subCount) > 0 ? `${Number(c.subCount).toLocaleString()} subscribers` : '',
    })).filter((c) => c.id),
    playlists: take(playlists).map((p) => ({
      id: p.playlistId,
      title: p.title,
      author: p.author,
      thumb: thumbOf(p) || p.playlistThumbnail || '',
      count: Number(p.videoCount) || 0,
    })).filter((p) => p.id),
  };
}

export async function channel(channelId) {
  const { json } = await first(`/api/v1/channels/${encodeURIComponent(channelId)}`);
  const videos = (json.latestVideos || []).map(toVideo).filter(Boolean);
  return {
    channel: {
      id: channelId,
      name: json.author || 'Artist',
      thumb: thumbOf(json),
      subscriberCount: Number(json.subCount) > 0 ? `${Number(json.subCount).toLocaleString()} subscribers` : '',
      description: String(json.description || '').trim(),
    },
    videos,
  };
}

export async function channelVideos(channelId) {
  const { json } = await first(`/api/v1/channels/${encodeURIComponent(channelId)}/videos`);
  return (json.videos || []).map(toVideo).filter(Boolean);
}

export async function playlist(playlistId) {
  const { json } = await first(`/api/v1/playlists/${encodeURIComponent(playlistId)}`);
  return {
    playlist: {
      id: playlistId,
      title: json.title || 'Playlist',
      author: json.author || '',
      thumb: thumbOf(json) || json.playlistThumbnail || '',
      videoCount: Number(json.videoCount) || (json.videos || []).length,
    },
    videos: (json.videos || []).map(toVideo).filter(Boolean),
  };
}

/**
 * Heuristics for "this is a compilation, not a song".
 *
 * A search for popular music returns plenty of "Top 100 Songs of the Week"
 * uploads. Playing one means the queue is a single five-hour upload, which looks
 * broken even though it is technically valid audio.
 */
const COMPILATION = /\b(top\s*\d+|top\s+songs|top\s+hits|playlist|mix|megamix|compilation|best\s+of|greatest\s+hits|nonstop|non-stop|full\s+album|hours?\s+of|\d+\s*(hour|hr)s?\b|weekly|chart)\b/i;

function looksLikeSong(video) {
  if (!video || !video.title) return false;
  if (video.duration > 900) return false;
  if (COMPILATION.test(video.title)) return false;
  return true;
}

export async function trending() {
  // Invidious' /trending?type=Music is unreliable and often returns podcasts and
  // news. Targeted music searches are a better signal, then compilations are
  // filtered out so the chart is songs rather than "Top 100 Hits 2026" uploads.
  const queries = ['popular music videos', 'new music', 'music video'];
  const results = await Promise.allSettled(queries.map((q) => search(q, 'video')));

  const seen = new Set();
  const list = [];
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    for (const item of result.value) {
      const video = toVideo(item);
      if (!video || seen.has(video.id) || !looksLikeSong(video)) continue;
      seen.add(video.id);
      list.push(video);
    }
  }

  // Interleave nothing: order is per-query relevance, which is what a chart is.
  return list.slice(0, 20);
}

export { toVideo };


export { descriptionText };
