// Downloads: resolve audio, store it, and serve it back offline.
//
// Two sources, tried in order:
//
//   1. Public Invidious mirrors. Their media URLs are proxied by the instance
//      itself, so they send CORS headers and support Range requests. That means
//      the bytes are readable: we can stream them, show a real byte-accurate
//      progress bar, and store a normal typed response.
//   2. The paid video-download-api provider. Its media host sends no CORS
//      headers, so the bytes cannot be read — but a `no-cors` response can still
//      be stored and replayed by the service worker. That is the last resort.
//
// Playback never spends money: downloading is an explicit action.

import { providerKey, getSettings } from './settings.js';
import { createJob, pollJob } from './provider.js';
import { byId } from './catalog.js';
import { emit } from './events.js';
import { sleep } from './util.js';
import * as invidious from './invidious.js';

const CACHE = 'freepot-audio-v1';

const jobs = new Map();
const queue = [];
const listeners = new Set();
let running = 0;
const MAX_PARALLEL = 2;

let cachePromise = null;
const audioCache = () => {
  if (!cachePromise) cachePromise = caches.open(CACHE);
  return cachePromise;
};

// Cached blobs are stored under a synthetic same-origin key. The key is prefixed
// with the app's own base path so two deployments on the same origin (say two
// GitHub Pages project sites) cannot read each other's audio.
//
// This module lives at `<base>/assets/js/media.js`, so two levels up is the app
// root regardless of whether it is served from `/` or `/<repo>/`.
const APP_BASE = new URL('../../', import.meta.url).pathname;
export const cacheKeyFor = (trackId) => `${APP_BASE}__audio/${encodeURIComponent(trackId)}`;
const requestFor = (trackId) => new Request(new URL(cacheKeyFor(trackId), location.origin));

const blobUrls = new Map();

export function onDownloadChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let notifyTimer = null;
let pendingKind = 'progress';

/**
 * Tell the UI that download state changed.
 *
 * `kind` is 'progress' for byte-level updates and 'state' for anything that
 * changes what is stored. Listeners that would have to re-scan the whole cache
 * (download icons, storage stats) only run for 'state'; a progress tick must
 * stay cheap or it competes with the transfer it is reporting on.
 */
function notify(force, kind = 'state') {
  // A state change is never downgraded to progress, and the flag is reset once
  // the batch fires — otherwise one state change made every later tick look like
  // a state change and every tick re-scanned the cache.
  pendingKind = pendingKind === 'state' || kind === 'state' ? 'state' : 'progress';

  if (force) {
    if (notifyTimer) clearTimeout(notifyTimer);
    pendingKind = 'state';
    flush();
    return;
  }
  if (!notifyTimer) notifyTimer = setTimeout(flush, 200);
}

function flush() {
  notifyTimer = null;
  const kind = pendingKind;
  pendingKind = 'progress';
  for (const fn of listeners) {
    try { fn(kind); } catch {}
  }
  emit('downloads-changed', kind);
}

export const jobOf = (trackId) => jobs.get(trackId);
export const jobState = (trackId) => (jobs.get(trackId) || {}).state;

export function jobPercent(trackId) {
  const job = jobs.get(trackId);
  if (!job) return 0;
  if (job.state === 'done') return 100;
  if (job.state !== 'downloading') return 0;
  if (job.source === 'invidious') return Math.min(99, Math.round(job.fraction || 0));
  // Provider reports 0..1000 while preparing; saving is the last stretch.
  if (job.phase === 'preparing') return Math.min(90, Math.round((job.progress / 1000) * 90));
  if (job.phase === 'saving') return 95;
  return 0;
}

export function jobLabel(trackId) {
  const job = jobs.get(trackId);
  if (!job) return '';
  if (job.state === 'queued') return 'Waiting';
  if (job.state === 'done') return 'Saved';
  if (job.state === 'error') return job.error || 'Failed';
  if (job.phase === 'saving') return 'Saving to device';
  if (job.source === 'invidious' && job.total) {
    return `${Math.round(job.fraction)}% · ${fmtBytes(job.received)} of ${fmtBytes(job.total)}`;
  }
  return job.text || 'Preparing';
}

function fmtBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export async function isDownloaded(trackId) {
  try {
    const cache = await audioCache();
    return !!(await cache.match(requestFor(trackId)));
  } catch {
    return false;
  }
}

/**
 * A URL the audio element can play from disk.
 *
 * Blob URLs are used rather than the service-worker route because they work
 * before the worker has claimed the page, support seeking, and keep the correct
 * content type even for the opaque provider fallback.
 */
export async function cachedUrl(trackId) {
  if (blobUrls.has(trackId)) return blobUrls.get(trackId);
  const blob = await cachedBlob(trackId);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  blobUrls.set(trackId, url);
  return url;
}

/**
 * The stored audio as a Blob.
 *
 * Used for playback (an object URL) and for handing the finished file to the
 * browser so a download only crosses the network once.
 */
export async function cachedBlob(trackId) {
  try {
    const cache = await audioCache();
    const hit = await cache.match(requestFor(trackId));
    if (!hit) return null;
    const blob = await hit.blob();
    return blob && blob.size ? blob : null;
  } catch {
    return null;
  }
}

export async function cachedBytes(trackId) {
  const blob = await cachedBlob(trackId);
  return blob ? blob.size : 0;
}

export async function removeDownload(trackId) {
  try {
    const cache = await audioCache();
    await cache.delete(requestFor(trackId));
  } catch {}
  const url = blobUrls.get(trackId);
  if (url) {
    URL.revokeObjectURL(url);
    blobUrls.delete(trackId);
  }
  jobs.delete(trackId);
  notify(true);
}

export async function clearDownloads() {
  for (const url of blobUrls.values()) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  blobUrls.clear();
  try { await caches.delete(CACHE); } catch {}
  jobs.clear();
  queue.length = 0;
  notify(true);
}

export async function countDownloads(trackIds) {
  let n = 0;
  for (const id of trackIds) if (await isDownloaded(id)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export function cancelQueued() {
  for (let i = queue.length - 1; i >= 0; i--) {
    const job = jobs.get(queue[i]);
    if (job && job.state === 'queued') {
      jobs.delete(queue[i]);
      queue.splice(i, 1);
    }
  }
  notify(true);
}

export function enqueue(track) {
  if (!track || !track.videoId) return false;
  const state = jobState(track.id);
  if (state === 'queued' || state === 'downloading' || state === 'done') return false;

  jobs.set(track.id, { state: 'queued', phase: 'preparing', progress: 0, text: 'Queued', track });
  queue.push(track.id);
  notify(true);
  pump();
  return true;
}

export function enqueueMany(tracks) {
  let queued = 0;
  for (const track of tracks) if (enqueue(track)) queued++;
  return queued;
}

function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job || !job.track) continue;
    running++;
    download(job.track)
      .catch(() => {})
      .finally(() => {
        running--;
        pump();
      });
  }
}

async function download(track) {
  const id = track.id;

  if (await isDownloaded(id)) {
    jobs.set(id, { state: 'done', phase: 'saved', progress: 1000, track });
    notify(true);
    return true;
  }

  jobs.set(id, { state: 'downloading', phase: 'preparing', progress: 0, text: 'Starting', track });
  notify(true);

  // Public mirrors first: free, readable bytes, real progress.
  try {
    const ok = await downloadFromInvidious(track);
    if (ok) {
      jobs.set(id, { state: 'done', phase: 'saved', progress: 1000, track });
      notify(true);
      return true;
    }
  } catch {
    // Fall through to the paid provider.
  }

  if (!providerKey()) {
    jobs.set(id, {
      state: 'error',
      phase: 'failed',
      error: 'Mirrors unavailable — try again, or set a download key in Setup',
      track,
    });
    notify(true);
    return false;
  }

  try {
    jobs.set(id, { state: 'downloading', phase: 'preparing', progress: 0, text: 'Contacting provider', track, source: 'provider' });
    notify(true);

    const job = await createJob(track.videoId);
    const mediaUrl = await pollJob(job.progressUrl, {
      onProgress: ({ progress, text }) => {
        const current = jobs.get(id);
        if (!current) return;
        jobs.set(id, { ...current, phase: 'preparing', progress, text: text || 'Preparing' });
        notify();
      },
    });

    jobs.set(id, { state: 'downloading', phase: 'saving', progress: 1000, text: 'Saving', track, source: 'provider' });
    notify(true);

    await saveOpaque(id, mediaUrl);

    jobs.set(id, { state: 'done', phase: 'saved', progress: 1000, track });
    notify(true);
    return true;
  } catch (err) {
    jobs.set(id, { state: 'error', phase: 'failed', error: err.message, track });
    notify(true);
    return false;
  }
}

/**
 * Download from the mirrors, racing them.
 *
 * Mirror metadata and mirror bandwidth are unrelated, and public mirrors also
 * throttle *per connection*. Two things follow:
 *
 *  - instances are raced: the first one that actually delivers a byte wins, not
 *    the one that answered the metadata request first;
 *  - the file is fetched as several parallel range requests, because one
 *    connection caps at ~30 KB/s while four connections saturate the host.
 *
 * Measured on a 5 MB track: 166 s sequential, 18 s with four ranges.
 *
 * A remembered URL can also be expired even though its `expire` parameter says
 * otherwise (mirrors revoke them early). If every stored stream fails, the cache
 * entry is dropped and resolution runs once more before giving up.
 */
async function downloadFromInvidious(track) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let streams = [];
    try {
      streams = await invidious.audioStreams(track.videoId);
    } catch {
      return false;
    }
    if (!streams.length) return false;

    for (const stream of streams) {
      try {
        if (await downloadRanges(track.id, stream)) return true;
      } catch {
        // This mirror refused or broke; the next one may serve it.
      }
    }

    // Every remembered URL failed: resolve fresh ones and try once more.
    invidious.forget(track.videoId);
  }
  return false;
}

const PART_COUNT = 4;
const PART_TIMEOUT = 60000;

/**
 * Fetch one stream as parallel byte ranges.
 *
 * Falls back to a single stream when the server ignores Range (a 200 with the
 * whole body), so this never makes a download worse than the plain path.
 */
async function downloadRanges(id, stream) {
  const size = Number(stream.length) || 0;
  if (!size) return downloadSingle(id, stream);

  const parts = Math.min(PART_COUNT, Math.max(1, Math.ceil(size / (256 * 1024))));
  const chunk = Math.ceil(size / parts);
  const buffers = new Array(parts);
  const received = new Array(parts).fill(0);
  let lastPaint = 0;

  const report = (force) => {
    const now = Date.now();
    if (!force && now - lastPaint < 150) return;
    lastPaint = now;
    const total = received.reduce((a, b) => a + b, 0);
    const current = jobs.get(id);
    if (!current) return;
    jobs.set(id, {
      ...current,
      state: 'downloading',
      source: 'invidious',
      received: total,
      total: size,
      fraction: Math.min(99, (total / size) * 100),
      text: 'Downloading',
    });
    notify(false, 'progress');
  };

  const fetchPart = async (index) => {
    const start = index * chunk;
    const end = Math.min(size - 1, start + chunk - 1);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PART_TIMEOUT);

    try {
      const res = await fetch(stream.url, {
        headers: { Range: `bytes=${start}-${end}`, Accept: 'audio/*' },
        signal: controller.signal,
      });

      // Server ignored Range: it is sending the whole file for every part.
      if (res.status !== 206) {
        throw new RangeUnsupported();
      }
      if (!res.ok && res.status !== 206) throw new Error(`Range failed (${res.status})`);

      const reader = res.body.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received[index] += value.byteLength;
        report(false);
      }
      buffers[index] = new Blob(chunks);
      return true;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    await Promise.all(Array.from({ length: parts }, (_, i) => fetchPart(i)));
  } catch (err) {
    if (err instanceof RangeUnsupported) return downloadSingle(id, stream);
    throw err;
  }

  const total = received.reduce((a, b) => a + b, 0);
  if (!total) return false;

  const blob = new Blob(buffers.filter(Boolean), { type: stream.mime || 'audio/mp4' });
  const cache = await audioCache();
  await cache.put(requestFor(id), new Response(blob, {
    headers: {
      'Content-Type': stream.mime || 'audio/mp4',
      'Content-Length': String(blob.size),
    },
  }));
  return !!(await cache.match(requestFor(id)));
}

class RangeUnsupported extends Error {}

/** Plain single-request download, used when Range is unavailable. */
async function downloadSingle(id, stream) {
  const controller = new AbortController();
  let stallTimer = null;
  const armStall = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), PART_TIMEOUT);
  };

  try {
    armStall();
    const res = await fetch(stream.url, { headers: { Accept: 'audio/*' }, signal: controller.signal });
    if (!res.ok) return false;

    const total = Number(res.headers.get('content-length')) || stream.length || 0;
    let received = 0;
    let lastPaint = 0;
    const chunks = [];
    const reader = res.body.getReader();

    for (;;) {
      armStall();
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;

      const now = Date.now();
      if (now - lastPaint > 150) {
        lastPaint = now;
        const current = jobs.get(id);
        if (!current) return false;
        jobs.set(id, {
          ...current,
          state: 'downloading',
          source: 'invidious',
          received,
          total: total || received,
          fraction: total ? Math.min(99, (received / total) * 100) : 0,
          text: 'Downloading',
        });
        notify(false, 'progress');
      }
    }

    if (!received) return false;

    const blob = new Blob(chunks, { type: stream.mime || 'audio/mp4' });
    const cache = await audioCache();
    await cache.put(requestFor(id), new Response(blob, {
      headers: {
        'Content-Type': stream.mime || 'audio/mp4',
        'Content-Length': String(blob.size),
      },
    }));
    return !!(await cache.match(requestFor(id)));
  } finally {
    clearTimeout(stallTimer);
  }
}

// Provider media URLs have no CORS headers, so the bytes cannot be read. They
// can still be stored as an opaque response and replayed by the service worker.
async function saveOpaque(trackId, url) {
  const cache = await audioCache();
  let lastError = 'Could not save audio';

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { mode: 'no-cors' });
      if (res.type !== 'opaque' && !res.ok) throw new Error(`Audio unavailable (${res.status})`);
      await cache.put(requestFor(trackId), res);
      if (await cache.match(requestFor(trackId))) return true;
      lastError = 'Storage rejected the file';
    } catch (err) {
      lastError = err.message;
    }
    await sleep(1000 * (attempt + 1));
  }
  throw new Error(lastError);
}

/** Download a single track now (used by the UI). */
export async function downloadTrack(track) {
  if (!track) return false;
  if (!enqueue(track)) return false;
  const started = Date.now();
  while (Date.now() - started < 240000) {
    const state = jobState(track.id);
    if (state === 'done') return true;
    if (state === 'error') return false;
    await sleep(300);
  }
  return false;
}

export async function downloadIds(ids) {
  return enqueueMany(ids.map((id) => byId[id]).filter(Boolean));
}

export { getSettings };
