// Downloads: resolve audio, store it, and serve it back offline.
//
// Three sources, tried in order:
//
//   1. DownVid. The primary: it resolves a search result straight to a finished
//      audio file, so it works for tracks that have no working mirror and does
//      not depend on YouTube's signed stream URLs staying alive. Its API is
//      proxied through a relay that adds CORS (see relay/README.md); the file
//      itself is fetched once and stored, because its URL is single-use.
//   2. Public Invidious mirrors. Their media URLs are proxied by the instance
//      itself, so they send CORS headers and support Range requests. That means
//      the bytes are readable: we can stream them, show a real byte-accurate
//      progress bar, store a normal typed response, *and* resume a transfer that
//      was interrupted by chunk.
//   3. The paid video-download-api provider. Its media host sends no CORS
//      headers, so the bytes cannot be read — but a `no-cors` response can still
//      be stored and replayed by the service worker. That is the last resort.
//
// Playback never spends money: downloading is an explicit action.

import { providerKey, getSettings } from './settings.js';
import { createJob, pollJob } from './provider.js';
import { byId, ARTISTS } from './catalog.js';
import { emit } from './events.js';
import { sleep } from './util.js';
import * as invidious from './invidious.js';
import * as downvid from './downvid.js';

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

// A ranged download is stored part by part, so an interrupted job keeps whatever
// it already fetched. On resume the finished parts are read back instead of being
// downloaded again. This is what makes a download survive the page being frozen,
// backgrounded for a long time, or closed outright.
const partKeyFor = (trackId, index) => `${cacheKeyFor(trackId)}.part${index}`;
const partRequestFor = (trackId, index) => new Request(new URL(partKeyFor(trackId, index), location.origin));

// Pending jobs are persisted so a reload can pick them up again.
const JOB_STORE = 'fp_jobs_v1';

// Why the last primary source gave up, so a total failure can report something
// more useful than a generic message. Cleared at the start of every attempt.
let lastSourceError = '';

const blobUrls = new Map();

// ---------------------------------------------------------------------------
// Suspension clock
// ---------------------------------------------------------------------------
//
// A phone locks its screen, the app is switched away from, the OS freezes the
// page. Every timer stops. When it comes back, all the timers that "should" have
// fired while it was gone fire at once — which used to abort perfectly healthy
// transfers and is why downloads died the moment the screen went off.
//
// The fix is to stop trusting timers as a measure of elapsed time. Deadlines here
// count only the time the page was actually awake and visible, so a request that
// was paused for two minutes in a pocket has spent zero of its timeout budget.
//
// `suspendedAt` is the timestamp the page went to sleep; `background` is how much
// awoken-time it has accumulated in the current episode.

let suspendedAt = 0;
let suspendedSoFar = 0;

function markSuspended() {
  if (!suspendedAt) suspendedAt = Date.now();
}

function markAwake() {
  if (suspendedAt) {
    suspendedSoFar += Math.max(0, Date.now() - suspendedAt);
    suspendedAt = 0;
  }
}

/** Milliseconds of awake time since `startedAt`. */
function awakeSince(startedAt) {
  let elapsed = Date.now() - startedAt - suspendedSoFar;
  // While asleep the clock is stopped, so nothing can time out mid-nap.
  if (suspendedAt) elapsed = 0;
  return Math.max(0, elapsed);
}

const isAsleep = () => suspendedAt > 0 || document.visibilityState === 'hidden';

// ---------------------------------------------------------------------------
// In-flight bookkeeping
// ---------------------------------------------------------------------------
//
// A fetch that is in flight when the page is frozen cannot settle until the page
// runs again, and some engines drop the request entirely without rejecting the
// promise. Without a record of what is running, `running` stays above zero and
// the queue never moves again — the "downloads just stop" symptom.
//
// Each entry remembers when the transfer last delivered bytes, so a genuinely
// dead one can be recognised and restarted instead of being waited on forever.

const inFlight = new Map();

function trackStart(id) {
  inFlight.set(id, { at: Date.now(), bytes: 0, restarts: 0 });
}

function trackBeat(id, bytes) {
  const entry = inFlight.get(id);
  if (!entry) return;
  entry.at = Date.now();
  if (typeof bytes === 'number') entry.bytes = bytes;
}

function trackEnd(id) {
  inFlight.delete(id);
}

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
  // DownVid and mirrors both report a 0..100 `fraction` that already accounts
  // for whichever phase of their pipeline is running.
  if (job.source === 'downvid' || job.source === 'invidious') {
    return Math.min(99, Math.round(job.fraction || 0));
  }
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
  if ((job.source === 'downvid' || job.source === 'invidious') && job.total) {
    return `${Math.round(job.fraction)}% · ${fmtBytes(job.received)} of ${fmtBytes(job.total)}`;
  }
  if (job.source === 'downvid' && job.text) return job.text;
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
 * Two forms, for two different situations:
 *
 *  - `/__audio/<id>`, served by the service worker. This is a real URL, so it
 *    survives the OS suspending the page and being restored — the blob variant
 *    below does not, because the Blob handle lives only in the old document.
 *  - A Blob URL, used when there is no controlling worker yet (first load, or
 *    the worker has not claimed the page). Blob URLs are also what make seeking
 *    work reliably before the worker takes over.
 *
 * The service-worker URL is preferred whenever the worker can actually answer.
 */
export async function cachedUrl(trackId) {
  if (blobUrls.has(trackId)) return blobUrls.get(trackId);

  const stored = await isDownloaded(trackId);
  if (!stored) return null;

  // Only trust the SW route when a worker is controlling this page; otherwise
  // the request would 404 and playback would fail for no reason.
  if (swControls()) return cacheKeyFor(trackId);

  const blob = await cachedBlob(trackId);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  blobUrls.set(trackId, url);
  return url;
}

function swControls() {
  try {
    return !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  } catch {
    return false;
  }
}

/** Drop cached Blob URLs so the next play re-requests them. */
export function releaseBlobUrls() {
  for (const url of blobUrls.values()) {
    try { URL.revokeObjectURL(url); } catch {}
  }
  blobUrls.clear();
}

/**
 * Keep a track's audio bytes for playback, without counting as a "download".
 *
 * Playback through DownVid produces a Blob that disappears with the document, and
 * its source URL is single-use, so the bytes have to be kept somewhere the next
 * play can reach them. They go into the same cache a download uses, which means a
 * track heard once streams from disk on the next play instead of being fetched
 * again — and the player can hand the audio element a durable service-worker URL
 * rather than a Blob URL that dies with the page.
 *
 * This is deliberately separate from `enqueue()`: it writes bytes, it does not
 * show a download icon, and it does not reserve device space indefinitely (the
 * ordinary storage controls and the cache eviction rules still apply).
 */
export async function cacheBlobFor(trackId, blob) {
  if (!trackId || !blob || !blob.size) return false;
  try {
    const cache = await audioCache();
    const type = blob.type || 'audio/mp4';
    await cache.put(requestFor(trackId), new Response(blob, {
      headers: { 'Content-Type': type, 'Content-Length': String(blob.size) },
    }));
    return !!(await cache.match(requestFor(trackId)));
  } catch {
    return false;
  }
}

/**
 * Start a DownVid fetch in the background and cache the result when it lands.
 *
 * Playback needs the cached bytes (only the cache gives a seekable source), but
 * the user should not sit in silence for the 5-20 seconds that fetch can take.
 * So the fetch is started here, the caller plays instantly from a mirror, and
 * when the bytes arrive they replace the transient source on the next play.
 *
 * Returns the promise so a caller can await it, plus `trackId` so a later
 * `resolveDownVid` finds the cached copy.
 */
const backgroundFetches = new Map();

export function prefetchDownVid(track, { onStage } = {}) {
  if (!track || !track.videoId || !downvid.isConfigured()) return Promise.resolve(false);
  if (backgroundFetches.has(track.id)) return backgroundFetches.get(track.id);

  // Already on disk: nothing to fetch.
  const run = (async () => {
    try {
      if (await isDownloaded(track.id)) return true;

      const artist = (ARTISTS[track.artistId] || {}).name || '';
      const query = [track.title, artist].filter(Boolean).join(' ').trim();
      if (!query) return false;

      const { blob } = await downvid.fetchTrackAudio({ query }, { onStage });
      if (!blob || !blob.size) return false;
      return await cacheBlobFor(track.id, blob);
    } catch {
      return false;
    } finally {
      backgroundFetches.delete(track.id);
    }
  })();

  backgroundFetches.set(track.id, run);
  return run;
}

/**
 * Resolve a track to something the audio element can play, through DownVid.
 *
 * **The bytes are always cached first.** That looks slower than streaming the
 * upstream URL straight into the audio element, and on a good connection it is —
 * but streaming that URL is not a viable way to play a song, for a reason that
 * only shows up once you try to use the player:
 *
 *   - the URL is **single-use**: any second request for it returns 404;
 *   - it **ignores `Range`**: a ranged request returns `200` with the whole body.
 *
 * Together those mean an audio element given this URL can start playing but can
 * never serve a seek — there are no retained bytes to seek within, and asking
 * again 404s. Seeking, restarting a track, and the media-session scrub controls
 * are all core player features, so a streaming source here would be a song you
 * could play once and never scrub.
 *
 * A cached Blob is a normal seekable media resource, works offline afterwards,
 * and survives the page being suspended. Verified against the live source: a
 * cached track seeks cleanly from 1.7 s to 121 s.
 *
 * Because that fetch can take a while, `prefetchDownVid` runs it in the
 * background while the user is already listening to a mirror, so this resolves
 * instantly on every play after the first.
 *
 * Resolves null when DownVid cannot serve this track, so the caller falls through
 * to the mirrors and then the iframe rather than to silence.
 */
export async function resolveDownVid(track, { onStage } = {}) {
  if (!track || !track.videoId || !downvid.isConfigured()) return null;

  // Already cached from an earlier play or download: nothing to fetch.
  const existing = await cachedUrl(track.id);
  if (existing) return { url: existing, cached: true, seekable: true };

  // A background fetch may already be running for this track; join it instead of
  // starting a second and paying for the same bytes twice.
  const pending = backgroundFetches.get(track.id);
  if (pending) {
    const ok = await pending;
    if (ok) {
      const url = await cachedUrl(track.id);
      if (url) return { url, cached: true, seekable: true };
    }
    return null;
  }

  const artist = (ARTISTS[track.artistId] || {}).name || '';
  const query = [track.title, artist].filter(Boolean).join(' ').trim();
  if (!query) return null;

  try {
    const { blob } = await downvid.fetchTrackAudio({ query }, { onStage });
    if (!blob || !blob.size) return null;

    if (await cacheBlobFor(track.id, blob)) {
      return { url: await cachedUrl(track.id), cached: true, seekable: true };
    }
    // The cache refused it, but the blob is still playable for this session.
    // A Blob URL is seekable even when it could not be persisted.
    const url = URL.createObjectURL(blob);
    blobUrls.set(track.id, url);
    return { url, cached: false, seekable: true };
  } catch {
    return null;
  }
}

/** True when a track's audio is cached or being fetched. */
export const isPrefetching = (trackId) => backgroundFetches.has(trackId);

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
    await clearParts(trackId);
  } catch {}
  const url = blobUrls.get(trackId);
  if (url) {
    URL.revokeObjectURL(url);
    blobUrls.delete(trackId);
  }
  jobs.delete(trackId);
  forgetJob(trackId);
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
  try { localStorage.removeItem(JOB_STORE); } catch {}
  notify(true);
}

/** Drop any stored partial chunks for a track. */
async function clearParts(trackId) {
  try {
    const cache = await audioCache();
    const keys = await cache.keys();
    const prefix = partKeyFor(trackId, 0).replace(/\.part0$/, '.part');
    await Promise.all(
      keys
        .filter((request) => new URL(request.url).pathname.startsWith(prefix))
        .map((request) => cache.delete(request).catch(() => {}))
    );
  } catch {}
}

export async function countDownloads(trackIds) {
  let n = 0;
  for (const id of trackIds) if (await isDownloaded(id)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Job persistence and resume
// ---------------------------------------------------------------------------

/** Jobs that should still be finished after a reload, keyed by track id. */
function readJobStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(JOB_STORE) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeJobStore(store) {
  try {
    const entries = Object.entries(store)
      .filter(([, entry]) => entry && entry.track && entry.track.videoId)
      .slice(-100);
    if (!entries.length) localStorage.removeItem(JOB_STORE);
    else localStorage.setItem(JOB_STORE, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

function rememberJob(track) {
  if (!track || !track.videoId) return;
  const store = readJobStore();
  store[track.id] = {
    at: Date.now(),
    track: {
      id: track.id,
      title: track.title,
      artistId: track.artistId,
      albumId: track.albumId,
      videoId: track.videoId,
      thumb: track.thumb,
      dur: track.dur,
    },
  };
  writeJobStore(store);
}

function forgetJob(trackId) {
  const store = readJobStore();
  if (!(trackId in store)) return;
  delete store[trackId];
  writeJobStore(store);
}

/**
 * Requeue downloads that were interrupted by a reload, a crash, or the OS
 * suspending the app.
 *
 * Anything already complete is dropped. Anything still registered is put back on
 * the queue, and the ranged downloader skips whatever parts it already stored,
 * so the work resumes rather than restarting.
 */
export async function resumePendingDownloads() {
  const store = readJobStore();
  const ids = Object.keys(store);
  if (!ids.length) return 0;

  let resumed = 0;
  for (const id of ids) {
    const entry = store[id];
    if (!entry || !entry.track) {
      forgetJob(id);
      continue;
    }
    if (await isDownloaded(id)) {
      forgetJob(id);
      continue;
    }
    const state = jobState(id);
    if (state === 'downloading' || state === 'queued' || state === 'done') continue;
    jobs.set(id, { state: 'queued', phase: 'preparing', progress: 0, text: 'Resuming', track: entry.track });
    queue.push(id);
    resumed++;
  }

  if (resumed) {
    notify(true);
    pump();
  }
  return resumed;
}

export function pendingDownloadCount() {
  let n = 0;
  for (const job of jobs.values()) {
    if (job.state === 'queued' || job.state === 'downloading') n++;
  }
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
      forgetJob(queue[i]);
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
  rememberJob(track);
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
  // Nothing new starts while the page is asleep: the transfer would begin, get
  // frozen, and count as a failure on wake.
  if (isAsleep()) return;

  while (running < MAX_PARALLEL && queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job || !job.track) continue;
    running++;
    trackStart(id);
    download(job.track)
      .catch(() => {})
      .finally(() => {
        running--;
        trackEnd(id);
        pump();
      });
  }
}

/**
 * Notice downloads that died and put them back on the queue.
 *
 * Called when the page wakes, and on a slow interval while it is awake. A job is
 * considered dead when nothing about it has changed for far longer than any
 * healthy transfer would allow — measured in awake time, so a page that slept for
 * ten minutes in a pocket is not mistaken for a stalled one.
 */
export function reconcileDownloads() {
  if (isAsleep()) return 0;

  let revived = 0;

  // A watchdog entry that has been silent for two minutes of awake time is not
  // coming back: the request was dropped when the page was frozen.
  for (const [id, entry] of inFlight) {
    if (awakeSince(entry.at) < AWAKE_STALL_MS) continue;
    const job = jobs.get(id);
    if (!job || job.state !== 'downloading') {
      // The job vanished (cancelled) or already finished; stop tracking it.
      inFlight.delete(id);
      continue;
    }
    // Requeue it. Stored chunks are reused, so this continues rather than
    // restarts wherever the downloader supports it.
    if (entry.restarts >= 2) continue;
    inFlight.delete(id);
    jobs.set(id, { ...job, state: 'queued', text: 'Resuming' });
    queue.push(id);
    revived++;
  }

  // `running` counts promises, not transfers. When the page was frozen the
  // promise never settled, so this can be stuck above zero forever; rebuild it
  // from what is actually being tracked.
  if (running > inFlight.size) running = inFlight.size;

  // Anything persisted but not in memory at all (the module was torn down and
  // only localStorage survived) is picked up by resumePendingDownloads().
  if (revived || (queue.length && running < MAX_PARALLEL)) {
    notify(true);
    pump();
  }
  return revived;
}

// Two minutes of *awake* time with no bytes. Long enough that a genuinely slow
// mirror is not killed, short enough that a dropped request does not wedge the
// queue for the rest of the session.
const AWAKE_STALL_MS = 120 * 1000;

/** Install the lifecycle listeners that keep downloads honest. */
export function initDownloadLifecycle() {
  const sleep = () => {
    markSuspended();
    for (const id of inFlight.keys()) {
      const job = jobs.get(id);
      if (job && job.state === 'downloading') {
        jobs.set(id, { ...job, text: 'Paused — waiting for the app' });
      }
    }
    notify(false, 'progress');
  };

  const wake = () => {
    markAwake();
    // Give the engine a moment to notice it is alive again before judging
    // anything as stalled: the old timers fire here, order is not guaranteed.
    setTimeout(() => {
      for (const id of inFlight.keys()) trackBeat(id);
      for (const id of inFlight.keys()) {
        const job = jobs.get(id);
        if (job && job.state === 'downloading') jobs.set(id, { ...job, text: 'Downloading' });
      }
      reconcileDownloads();
      notify(false, 'progress');
    }, 900);
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') sleep();
    else wake();
  });

  // Page Lifecycle API: these fire when the OS freezes and thaws the page
  // outright, which on iOS and Android can happen without a visibility change.
  document.addEventListener('freeze', sleep);
  document.addEventListener('resume', wake);

  window.addEventListener('pagehide', sleep);
  window.addEventListener('pageshow', wake);
  window.addEventListener('online', wake);

  // A slow heartbeat catches a transfer that silently died without a lifecycle
  // event at all, which happens on desktop when the network drops.
  setInterval(() => {
    if (isAsleep()) return;
    reconcileDownloads();
  }, 20000);
}

async function download(track) {
  const id = track.id;

  if (await isDownloaded(id)) {
    jobs.set(id, { state: 'done', phase: 'saved', progress: 1000, track });
    forgetJob(id);
    notify(true);
    return true;
  }

  jobs.set(id, { state: 'downloading', phase: 'preparing', progress: 0, text: 'Starting', track });
  lastSourceError = '';
  notify(true);

  // DownVid first: it returns a finished file rather than a signed media URL, so
  // it succeeds on tracks where every mirror has expired or been throttled.
  try {
    const ok = await downloadFromDownVid(track);
    if (ok) {
      jobs.set(id, { state: 'done', phase: 'saved', progress: 1000, track });
      forgetJob(id);
      notify(true);
      return true;
    }
  } catch (err) {
    // Remember why, so a total failure can say something useful instead of
    // "mirrors unavailable" when the real problem was a missing relay.
    lastSourceError = err && err.message ? err.message : '';
  }

  // Public mirrors second: free, readable bytes, real progress, resumable.
  try {
    const ok = await downloadFromInvidious(track);
    if (ok) {
      jobs.set(id, { state: 'done', phase: 'saved', progress: 1000, track });
      forgetJob(id);
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
      error: lastSourceError
        ? `Could not download — ${lastSourceError}`
        : 'Mirrors unavailable — try again, or set a download key in Setup',
      track,
    });
    // Keep the job on disk: the stored parts are still valid, and retrying (or a
    // reload) resumes from them instead of starting the transfer again.
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
    forgetJob(id);
    notify(true);
    return true;
  } catch (err) {
    jobs.set(id, { state: 'error', phase: 'failed', error: err.message, track });
    notify(true);
    return false;
  }
}

/**
 * Download through DownVid.
 *
 * DownVid has no notion of a track id — it only accepts a search query — so the
 * track's own title and artist are used to find it again. The duration is used as
 * a tie-breaker, because a search for "Doubt" returns several songs with no
 * duration and only one with the right one.
 *
 * The finished file URL is single-use, so the bytes are fetched exactly once and
 * written straight into the cache. There is no partial-file resume here; the
 * resume machinery belongs to the mirror path, which can address byte ranges.
 */
async function downloadFromDownVid(track) {
  if (!downvid.isConfigured()) return false;

  const artist = (ARTISTS[track.artistId] || {}).name || '';
  const query = [track.title, artist].filter(Boolean).join(' ').trim();
  if (!query) return false;

  const setJob = (patch) => {
    const current = jobs.get(track.id);
    if (!current) return;
    jobs.set(track.id, { ...current, source: 'downvid', ...patch });
  };

  setJob({ state: 'downloading', fraction: 1, text: 'Searching' });
  notify(false, 'progress');
  trackBeat(track.id);

  const results = await downvid.searchMusic(query);
  if (!results.length) return false;
  trackBeat(track.id);

  const pick = chooseBestResult(results, track, artist);
  if (!pick) return false;

  setJob({ fraction: 4, text: 'Preparing' });
  notify(false, 'progress');

  const job = await downvid.createJob(pick.sessionId, pick.optionId);

  setJob({ fraction: 8, text: 'Preparing' });
  notify(false, 'progress');

  await downvid.waitForFile(job.id, {
    onProgress: (pct) => {
      // Waiting is cheap but slow, so it only ever accounts for the first tenth
      // of the bar; the real movement comes from the byte stream below.
      setJob({ fraction: 8 + Math.min(12, (pct / 100) * 12), text: 'Preparing' });
      notify(false, 'progress');
    },
  });

  setJob({ fraction: 20, text: 'Downloading' });
  notify(false, 'progress');
  trackBeat(track.id);

  let lastPaint = 0;
  const { blob } = await downvid.downloadFile(job.id, {
    onProgress: (pct, received, total) => {
      trackBeat(track.id, received || 0);
      const now = Date.now();
      // Byte updates are frequent; repainting at 8 fps is plenty and keeps the
      // progress write from competing with the transfer.
      if (now - lastPaint < 125 && pct < 100) return;
      lastPaint = now;
      setJob({
        fraction: 20 + Math.min(79, (pct / 100) * 79),
        received: received || 0,
        total: total || 0,
        text: 'Downloading',
      });
      notify(false, 'progress');
    },
  });

  if (!blob || !blob.size) return false;

  setJob({ fraction: 99, text: 'Saving' });
  notify(false, 'progress');

  const cache = await audioCache();
  const type = blob.type || 'audio/mp4';
  await cache.put(requestFor(track.id), new Response(blob, {
    headers: { 'Content-Type': type, 'Content-Length': String(blob.size) },
  }));

  return !!(await cache.match(requestFor(track.id)));
}

/**
 * Pick the suggestion that matches the track being downloaded.
 *
 * The API returns whatever it thinks is close, usually with several same-titled
 * songs by different artists, so a blind "take the first" is regularly the wrong
 * recording. Scoring prefers a title match, then an artist match, then a duration
 * match, and refuses to guess when nothing matches at all.
 */
function chooseBestResult(results, track, artist) {
  if (!results.length) return null;

  const wantedTitle = normalise(track.title);
  const wantedArtist = normalise(artist);
  const wantedDur = secondsOf(track.dur);

  let best = null;
  let bestScore = -Infinity;

  for (let i = 0; i < results.length; i++) {
    const item = results[i];
    const title = normalise(item.title);
    const who = normalise(item.artist);

    let score = 0;
    // Later results are less relevant, so position is a mild tie-breaker.
    score -= i * 0.4;

    if (title && wantedTitle) {
      if (title === wantedTitle) score += 10;
      else if (title.includes(wantedTitle) || wantedTitle.includes(title)) score += 6;
      else score -= 4;
    }

    if (who && wantedArtist) {
      if (who === wantedArtist) score += 8;
      else if (who.includes(wantedArtist) || wantedArtist.includes(who)) score += 5;
      else score -= 3;
    }

    // A matching duration is strong evidence it is the same recording. It is
    // only compared when both sides know theirs.
    const dur = secondsOf(item.dur);
    if (wantedDur && dur) {
      const delta = Math.abs(dur - wantedDur);
      if (delta <= 2) score += 6;
      else if (delta <= 6) score += 2;
      else score -= 2;
    }

    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  // Everything scored badly: better to fall through to the mirrors than to save
  // the wrong song under this track's id.
  return bestScore > 0 ? best : null;
}

const normalise = (value) => String(value || '')
  .toLowerCase()
  .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')     // drop "(Official Video)" and friends
  .replace(/\b(official|video|audio|lyrics?|hd|hq|remaster(ed)?|feat\.?|ft\.?)\b/g, ' ')
  .replace(/[^\p{L}\p{N}]+/gu, ' ')
  .trim();

function secondsOf(label) {
  const parts = String(label || '').split(':').map(Number);
  if (!parts.length || parts.some((n) => !isFinite(n))) return 0;
  return parts.reduce((sum, n) => sum * 60 + n, 0);
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

// Downloads are split into fixed-size chunks rather than "N parts of size/N".
//
// Public mirrors throttle per connection and run at wildly different speeds, so
// a 5 MB file split four ways meant a single 1.3 MB chunk could take 45 seconds
// and nothing was durable until it finished. 256 KB chunks complete every few
// seconds, so an interrupted transfer always keeps most of its progress, and a
// bounded number of them run at once to keep the parallel bandwidth win.
const CHUNK_SIZE = 256 * 1024;
const CONCURRENCY = 4;
const PART_TIMEOUT = 45000;

/**
 * Fetch one stream as parallel byte ranges, resuming finished chunks.
 *
 * Each chunk is written to the cache as soon as it arrives, so a transfer that
 * is cut off (page frozen, app backgrounded, tab closed) keeps the bytes it
 * already paid for. The next attempt — including one after a full reload —
 * reads the stored chunks back and only fetches what is missing.
 *
 * Falls back to a single stream when the server ignores Range (a 200 with the
 * whole body), so this never makes a download worse than the plain path.
 */
async function downloadRanges(id, stream) {
  const size = Number(stream.length) || 0;
  if (!size) return downloadSingle(id, stream);

  const cache = await audioCache();
  const total = Math.max(1, Math.ceil(size / CHUNK_SIZE));
  const received = new Array(total).fill(0);
  const have = new Array(total).fill(false);
  let lastPaint = 0;

  // Restore anything a previous attempt stored.
  let resumedBytes = 0;
  let resumedChunks = 0;
  for (let index = 0; index < total; index++) {
    const hit = await cache.match(partRequestFor(id, index)).catch(() => null);
    if (!hit) continue;
    const blob = await hit.blob().catch(() => null);
    if (!blob || !blob.size) continue;
    received[index] = blob.size;
    have[index] = true;
    resumedBytes += blob.size;
    resumedChunks++;
  }

  if (resumedChunks) {
    jobs.set(id, {
      ...(jobs.get(id) || {}),
      state: 'downloading',
      source: 'invidious',
      received: resumedBytes,
      total: size,
      fraction: Math.min(99, (resumedBytes / size) * 100),
      text: `Resuming · ${fmtBytes(resumedBytes)} kept`,
    });
    notify(true);
  }

  const report = (force) => {
    const now = Date.now();
    if (!force && now - lastPaint < 150) return;
    lastPaint = now;
    const sum = received.reduce((a, b) => a + b, 0);
    const current = jobs.get(id);
    if (!current) return;
    jobs.set(id, {
      ...current,
      state: 'downloading',
      source: 'invidious',
      received: sum,
      total: size,
      fraction: Math.min(99, (sum / size) * 100),
      text: 'Downloading',
    });
    notify(false, 'progress');
  };

  let rangeUnsupported = false;

  const fetchChunk = async (index) => {
    if (have[index] || rangeUnsupported) return;

    const start = index * CHUNK_SIZE;
    const end = Math.min(size - 1, start + CHUNK_SIZE - 1);
    const controller = new AbortController();
    // Awake-time budget, not wall clock: a chunk paused by a locked screen must
    // not be aborted the moment the phone wakes up. See armAwakeTimeout.
    let cancelTimeout = null;
    const rearm = () => {
      if (cancelTimeout) cancelTimeout();
      cancelTimeout = armAwakeTimeout(PART_TIMEOUT, () => controller.abort());
    };
    rearm();

    try {
      const res = await fetch(stream.url, {
        headers: { Range: `bytes=${start}-${end}`, Accept: 'audio/*' },
        signal: controller.signal,
      });

      // Server ignored Range: it is sending the whole file for every chunk.
      if (res.status !== 206) {
        rangeUnsupported = true;
        throw new RangeUnsupported();
      }

      const reader = res.body.getReader();
      const chunks = [];
      for (;;) {
        rearm();
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received[index] += value.byteLength;
        trackBeat(id, received.reduce((a, b) => a + b, 0));
        report(false);
      }

      const blob = new Blob(chunks, { type: stream.mime || 'audio/mp4' });
      if (!blob.size) throw new Error('Empty chunk');

      // Store the chunk immediately; this is what makes the next attempt resume.
      await cache.put(partRequestFor(id, index), new Response(blob, {
        headers: { 'Content-Type': stream.mime || 'audio/mp4', 'Content-Length': String(blob.size) },
      })).catch(() => {});
      have[index] = true;
    } finally {
      if (cancelTimeout) cancelTimeout();
    }
  };

  // Bounded worker pool: keeps several range requests in flight without opening
  // one connection per chunk on a long track.
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (rangeUnsupported) return;
      const index = next++;
      if (index >= total) return;
      await fetchChunk(index).catch((err) => {
        if (err instanceof RangeUnsupported) return;
        throw err;
      });
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker));
  } catch {
    // Some chunks failed; fall through and check how far we got.
  }

  if (rangeUnsupported) {
    await clearParts(id);
    return downloadSingle(id, stream);
  }

  const missing = have.filter((v) => !v).length;
  if (missing) {
    // Keep the chunks that did arrive and let the next attempt continue.
    throw new Error(`${missing} chunk${missing === 1 ? '' : 's'} incomplete`);
  }

  const blobs = [];
  for (let index = 0; index < total; index++) {
    const hit = await cache.match(partRequestFor(id, index));
    if (!hit) throw new Error('Missing chunk');
    blobs.push(await hit.blob());
  }

  const blob = new Blob(blobs, { type: stream.mime || 'audio/mp4' });
  if (!blob.size) return false;

  await cache.put(requestFor(id), new Response(blob, {
    headers: {
      'Content-Type': stream.mime || 'audio/mp4',
      'Content-Length': String(blob.size),
    },
  }));
  const stored = !!(await cache.match(requestFor(id)));
  if (stored) await clearParts(id);
  return stored;
}

class RangeUnsupported extends Error {}

/**
 * A `setTimeout` that stops counting while the page is asleep.
 *
 * This is the fix for downloads dying when the screen locks. A plain timer keeps
 * counting wall-clock time, so a transfer that was paused for two minutes in a
 * pocket would fire its 45-second abort the instant the phone woke up — killing a
 * request that had done nothing wrong. Here the deadline is re-armed from the
 * remaining budget on every tick, and the budget only decreases while the page is
 * actually awake and visible.
 *
 * Returns a cancel function.
 */
function armAwakeTimeout(ms, onExpire) {
  let remaining = ms;
  let last = Date.now();
  let stopped = false;
  let handle = null;

  const tick = () => {
    if (stopped) return;
    const now = Date.now();

    if (suspendedAt) {
      // Asleep: bank nothing, and do not let the deadline run down.
      last = now;
    } else {
      remaining -= now - last;
      last = now;
    }

    if (remaining <= 0) {
      stopped = true;
      onExpire();
      return;
    }

    // Wake up often enough to notice a freeze quickly, but not so often that the
    // timer itself becomes work.
    handle = setTimeout(tick, Math.min(1000, Math.max(120, remaining)));
  };

  handle = setTimeout(tick, Math.min(1000, ms));

  return () => {
    stopped = true;
    if (handle) clearTimeout(handle);
  };
}

/** Plain single-request download, used when Range is unavailable. */
async function downloadSingle(id, stream) {
  const controller = new AbortController();
  let cancelStall = null;
  const armStall = () => {
    if (cancelStall) cancelStall();
    cancelStall = armAwakeTimeout(PART_TIMEOUT, () => controller.abort());
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
      trackBeat(id, received);

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
    if (cancelStall) cancelStall();
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
