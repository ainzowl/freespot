// DownVid: the primary download and playback source.
//
// A small public API that turns a search query into a finished audio file:
//
//   POST /api/music/search    {"query"}                        -> { sessionId, suggestions[] }
//   POST /api/music/download  {"sessionId", "optionId"}        -> { id }
//   GET  /api/progress/<id>                                    -> { progress }
//   GET  /api/file/<id>                                        -> the audio bytes
//
// Three properties of that API shape everything in this file, and all three were
// confirmed against the live service rather than assumed:
//
//  1. It sends **no CORS headers at all**. Not on the JSON endpoints, not on the
//     file endpoint, and its `OPTIONS` reply carries none either. A plain
//     `fetch()` from any other origin cannot read the response, so every request
//     here goes through a relay that adds the headers (see relay/README.md).
//     The relay is configurable, and when it is missing we say so instead of
//     failing silently.
//
//  2. A finished file URL is **single-use**. The first GET returns the audio; an
//     immediate second GET of the same URL returns 404. So a file URL is fetched
//     once, stored, and never requested again — which is also why downloading and
//     caching are the same operation here.
//
//  3. It **ignores `Range`**. A ranged request comes back `200` with the full
//     body instead of `206` with a slice, so the multi-chunk downloader the
//     Invidious path uses cannot work here. The file is fetched as one stream,
//     with progress reported from real byte counts.
//
// The result is cached under the same key the rest of the app already uses, so a
// DownVid download is indistinguishable from any other downloaded track: it
// plays offline, shows a real size, and can be removed from storage.

import { getSettings } from './settings.js';
import { fetchWithTimeout } from './util.js';

// The public deployment. Requests never go here directly from the browser — they
// go to the relay, which forwards them — but the id is needed on every call.
export const DOWNVID_BASE = 'https://downvid-delta.vercel.app';
export const DOWNVID_CLIENT_ID = 'e9e3fe42-0781-4995-918a-3044faa6715d';

const SEARCH_TIMEOUT = 15000;
const CREATE_TIMEOUT = 25000;
const POLL_TIMEOUT = 90000;

// The readiness endpoint usually has the file almost immediately, so a short
// interval gets playback started a second or two sooner than a lazy one would.
// It is a cheap metadata request, not the file transfer.
const POLL_INTERVAL = 400;

/**
 * Where requests are sent.
 *
 * Defaults to the dev relay that ships with this repo, because that is the only
 * endpoint guaranteed to exist while developing. A deployed relay (Cloudflare
 * Worker, see relay/) is supplied through Settings, or for a quick test with
 * `?relay=https://…`.
 */
export function relayBase() {
  try {
    const fromQuery = new URLSearchParams(location.search).get('relay');
    if (fromQuery) return trimSlash(fromQuery);
  } catch {}

  const configured = String(getSettings().downvidRelay || '').trim();
  if (configured) return trimSlash(configured);

  // Same-origin dev relay: server/index.js answers /__relay/*.
  return `${location.origin}${appBase()}/__relay`;
}

const trimSlash = (value) => String(value).replace(/\/+$/, '');

/**
 * The app root path, always ending in exactly one `/`.
 *
 * This module lives at `<base>/assets/js/downvid.js`, so two levels up from its
 * own URL is the app root — whether the app is served from `/` or from a
 * `/repo/` subpath. Getting the slash count wrong here produced
 * `http://host/repo__relay`, which is not a URL at all, so the join is explicit.
 */
function appBase() {
  try {
    // import.meta.url is the module's own absolute URL; resolve the root
    // relative to it rather than string-slicing a pathname.
    return trimSlash(new URL('../../', import.meta.url).pathname) || '';
  } catch {
    return '';
  }
}

/** True when a relay is configured, i.e. the API is reachable at all. */
export function isConfigured() {
  return !!relayBase();
}

function endpoint(path) {
  return `${relayBase()}${path}`;
}

const headers = () => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'x-client-id': DOWNVID_CLIENT_ID,
});

class RelayError extends Error {}

async function readJson(res) {
  const text = await res.text().catch(() => '');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Explain a failure in terms the user can act on.
 *
 * The most likely failure by far is a missing relay, and "Load failed" or
 * "Failed to fetch" tells nobody what to do about it.
 */
function describeFailure(err, what) {
  if (err instanceof RelayError) return err.message;
  const message = String((err && err.message) || err || '');
  if (/load failed|failed to fetch|networkerror/i.test(message)) {
    return `${what}: relay unreachable — set one in Setup`;
  }
  return `${what}: ${message || 'unknown error'}`;
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Turn one of the API's suggestion labels into a usable track.
 *
 * Labels come in two shapes, and the difference matters:
 *
 *   "• 2:44 • House of Gold — Twenty One Pilots"   duration, then title — artist
 *   "Doubt — twenty one pilots"                    no duration
 *
 * The bullet-led form also uses a different dash, so both are split explicitly
 * instead of assuming one separator.
 */
export function parseSuggestion(suggestion, query) {
  if (!suggestion || suggestion.id == null) return null;
  const raw = String(suggestion.label || '').trim();
  if (!raw) return null;

  let rest = raw;
  let duration = '';

  // Leading "• 2:44 • " (or "| 2:44 | ") marks a result that knows its length.
  const withDuration = /^[•|·]\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*[•|·]\s*(.+)$/.exec(rest);
  if (withDuration) {
    duration = withDuration[1];
    rest = withDuration[2];
  } else {
    // Some responses lead with a bare bullet and no duration.
    rest = rest.replace(/^[•|·]\s*/, '');
  }

  // "Title — Artist" with an em dash, or "Title - Artist" with a hyphen.
  let title = rest;
  let artist = '';
  const split = /^(.*?)\s+[—–]\s+(.+)$/.exec(rest) || /^(.*?)\s+-\s+(.+)$/.exec(rest);
  if (split) {
    title = split[1].trim();
    artist = split[2].trim();
  }

  if (!title) return null;
  return {
    optionId: String(suggestion.id),
    query: String(query || ''),
    title,
    artist: artist || String(query || 'Unknown artist'),
    dur: duration,
    label: raw,
  };
}

/** Search the catalogue. Returns parsed suggestions, best first. */
export async function searchMusic(query) {
  const text = String(query || '').trim();
  if (!text) return [];

  let res;
  try {
    res = await fetchWithTimeout(endpoint('/api/music/search'), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ query: text }),
    }, SEARCH_TIMEOUT);
  } catch (err) {
    throw new RelayError(describeFailure(err, 'Search'));
  }

  const json = await readJson(res);
  if (!res.ok) {
    throw new RelayError((json && json.error) || `Search failed (${res.status})`);
  }
  if (!json || !Array.isArray(json.suggestions)) return [];

  const parsed = json.suggestions
    .map((item) => parseSuggestion(item, text))
    .filter(Boolean);

  return parsed.map((item) => ({ ...item, sessionId: json.sessionId }));
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/** Ask the API to prepare one suggestion. Returns the job id. */
export async function createJob(sessionId, optionId) {
  if (!sessionId) throw new RelayError('That result expired — search again');

  let res;
  try {
    res = await fetchWithTimeout(endpoint('/api/music/download'), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ sessionId: String(sessionId), optionId: String(optionId) }),
    }, CREATE_TIMEOUT);
  } catch (err) {
    throw new RelayError(describeFailure(err, 'Download'));
  }

  const json = await readJson(res);
  if (!res.ok) {
    throw new RelayError((json && json.error) || `Download failed (${res.status})`);
  }
  if (!json || !json.id) throw new RelayError('Download did not return a file id');
  return { id: String(json.id), selected: String(json.selected || '') };
}

/**
 * Wait until the server says the file is ready.
 *
 * Progress here is coarse — the endpoint reports a single number and usually
 * jumps straight to 100 — so it is used as a liveness signal, not as a byte
 * counter. The real bytes arrive in `downloadFile` below.
 */
export async function waitForFile(id, { onProgress } = {}) {
  const started = Date.now();
  let last = 0;

  while (Date.now() - started < POLL_TIMEOUT) {
    let json = null;
    try {
      const res = await fetchWithTimeout(endpoint(`/api/progress/${encodeURIComponent(id)}`), {
        method: 'GET',
        headers: headers(),
      }, 15000);
      json = await readJson(res);
      if (res.ok && json && Number(json.progress) >= 100) {
        if (onProgress) onProgress(100);
        return fileUrl(id);
      }
    } catch {
      // A blip is not a failure; keep polling until the deadline.
    }

    if (json && onProgress) {
      const pct = Number(json.progress);
      if (isFinite(pct) && pct !== last) {
        last = pct;
        // The API's scale is not always 0..100, so clamp rather than assume.
        onProgress(Math.max(0, Math.min(99, pct)));
      }
    }

    if (onProgress) onProgress(Math.min(99, Math.max(last, 5)));
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }

  throw new RelayError('Download timed out — the file never became ready');
}

export const fileUrl = (id) => endpoint(`/api/file/${encodeURIComponent(id)}`);

/** One progress reading. Exposed so callers can measure the pipeline. */
export async function checkProgress(id) {
  try {
    const res = await fetchWithTimeout(endpoint(`/api/progress/${encodeURIComponent(id)}`), {
      method: 'GET',
      headers: headers(),
    }, 15000);
    const json = await readJson(res);
    return json && json.progress !== undefined ? Number(json.progress) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the finished file as a Blob, reporting real progress.
 *
 * The URL is single-use, so this is called exactly once per job and the result is
 * stored immediately by the caller. Where the response exposes a length (the
 * relay passes `Content-Length` through) progress is measured in bytes; when the
 * length is unknown the reported value stays indeterminate rather than lying.
 */
export async function downloadFile(id, { onProgress, signal } = {}) {
  const url = fileUrl(id);
  let res;
  try {
    res = await fetch(url, { method: 'GET', headers: { Accept: 'audio/*' }, signal });
  } catch (err) {
    throw new RelayError(describeFailure(err, 'Audio fetch'));
  }

  if (!res.ok) throw new RelayError(`Audio unavailable (${res.status})`);

  const type = res.headers.get('content-type') || 'audio/mp4';
  const total = Number(res.headers.get('content-length')) || 0;

  // No readable stream (or no body): take the whole response in one go.
  if (!res.body || typeof res.body.getReader !== 'function') {
    const blob = await res.blob();
    if (onProgress) onProgress(100);
    return { blob: new Blob([blob], { type }), size: blob.size, total: blob.size };
  }

  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  let lastPaint = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;

    if (onProgress && total) {
      const now = Date.now();
      if (now - lastPaint > 120) {
        lastPaint = now;
        onProgress(Math.min(99, Math.round((received / total) * 100)), received, total);
      }
    }
  }

  const blob = new Blob(chunks, { type });
  if (!blob.size) throw new RelayError('The file came back empty');
  if (onProgress) onProgress(100, blob.size, blob.size);

  return { blob, size: blob.size, total: total || blob.size };
}

/**
 * Resolve a track to a URL for its finished file.
 *
 * Kept for callers that want the raw upstream URL, but note the two constraints
 * that make it unsuitable as an audio-element source for real playback: the URL
 * is single-use (a second request 404s) and it ignores `Range` (a ranged request
 * returns the whole body). That combination means a source built on it can start
 * playing but can never serve a seek, so `media.js` caches the bytes instead and
 * plays from the cache. See `resolveDownVid` there.
 */
export async function prepareStream({ query, optionId } = {}, { onStage } = {}) {
  const say = (stage, extra) => { if (onStage) onStage(stage, extra || {}); };

  say('searching');
  const results = await searchMusic(query);
  if (!results.length) throw new RelayError('Nothing found for that track');

  const pick = optionId
    ? results.find((item) => item.optionId === String(optionId)) || results[0]
    : results[0];

  say('preparing');
  const job = await createJob(pick.sessionId, pick.optionId);

  say('waiting');
  const url = await waitForFile(job.id, { onProgress: (pct) => say('waiting', { progress: pct }) });

  say('done');
  return { url, pick, jobId: job.id };
}

/**
 * Resolve a track to a playable, cached blob in one step.
 *
 * Search is only used when the caller does not already know which suggestion to
 * take. Caching happens in `media.js`, which owns the Cache API — this function
 * stops at the blob.
 */
export async function fetchTrackAudio({ query, optionId } = {}, { onStage, signal } = {}) {
  const say = (stage, extra) => { if (onStage) onStage(stage, extra || {}); };

  say('searching');
  const results = await searchMusic(query);
  if (!results.length) throw new RelayError('Nothing found for that track');

  // Prefer the caller's pick; otherwise the first result is the best match.
  const pick = optionId
    ? results.find((item) => item.optionId === String(optionId)) || results[0]
    : results[0];

  say('preparing');
  const job = await createJob(pick.sessionId, pick.optionId);

  say('waiting');
  await waitForFile(job.id, { onProgress: (pct) => say('waiting', { progress: pct }) });

  say('downloading');
  const { blob } = await downloadFile(job.id, {
    signal,
    onProgress: (pct, received, total) => say('downloading', { progress: pct, received, total }),
  });

  say('done');
  return { blob, pick, jobId: job.id };
}

