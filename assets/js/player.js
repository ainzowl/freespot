// Player: queue, transport, Media Session, and now-playing state.
//
// Two engines, in order:
//   1. The hidden YouTube iframe (fast, keyless, official).
//   2. A public Invidious audio stream, for videos whose owner disabled
//      embedding and for anything the iframe refuses to play.
//
// A downloaded file always wins over both, so offline playback needs no network.
// If every engine fails, the player stops on the track and offers a download
// instead of silently skipping past it.

import { byId, ARTISTS, ALBUMS, ensureTrack } from './catalog.js';
import { state, pushRecent } from './library.js';
import { isDownloaded, cachedUrl, releaseBlobUrls, prefetchDownVid } from './media.js';
import * as yt from './ytplayer.js';
import * as invidious from './invidious.js';
import * as downvid from './downvid.js';
import { $, $$, fmtLong, clamp, load, store } from './util.js';
import { emit } from './events.js';
import { get as artGet } from './art.js';
import { STORAGE } from './config.js';

// Where the current track, queue and position are remembered across app closure.
const SESSION_KEY = 'fp_session_v1';

// How long the primary source may hold up playback before a mirror gets the
// whole remaining window.
//
// DownVid has to finish fetching before it can serve a seekable source, and that
// upstream is slow (measured 5-20 s for a 3 MB track). A working mirror still wins
// the race outright, so this is only the patience budget for the case where the
// mirrors are down — which is the common case, and the reason DownVid is primary
// at all. Long enough for a slow-but-working DownVid fetch, short enough that a
// total failure still reaches the mirrors and the iframe promptly.
const DOWNVID_PATIENCE_MS = 20000;

/** Seconds from a "m:ss" / "h:mm:ss" label. */
function parseDuration(text) {
  const parts = String(text || '').split(':').map(Number);
  if (parts.some((n) => !isFinite(n))) return 0;
  return parts.reduce((sum, n) => sum * 60 + n, 0);
}

const audioEl = new Audio();
audioEl.preload = 'metadata';

// A 0.05 s silent WAV. Playing it inside the first user gesture "unlocks" the
// element so later programmatic playback is allowed.
//
// This matters because starting a track is asynchronous: by the time the stream
// URL resolves, the gesture is long gone, and browsers (Safari and Chrome on
// iOS especially) refuse play() without one. Unlocking up front keeps the
// first tap working, and keeps background resume from being blocked.
const SILENT_WAV = 'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

let audioUnlocked = false;

function unlockAudio() {
  if (audioUnlocked) return;
  audioUnlocked = true;
  try {
    const wasMuted = audioEl.muted;
    audioEl.muted = true;
    const original = audioEl.src;
    audioEl.src = SILENT_WAV;
    const p = audioEl.play();
    if (p && p.then) {
      p.then(() => {
        audioEl.pause();
        audioEl.muted = wasMuted;
        if (original) audioEl.src = original;
        else audioEl.removeAttribute('src');
      }).catch(() => {
        audioEl.muted = wasMuted;
        if (original) audioEl.src = original;
      });
    }
  } catch {}
}

if (typeof window !== 'undefined') {
  const events = ['pointerdown', 'touchstart', 'keydown'];
  const once = () => {
    unlockAudio();
    events.forEach((name) => window.removeEventListener(name, once, true));
  };
  events.forEach((name) => window.addEventListener(name, once, { capture: true, passive: true }));
}

export const player = {
  queue: [],
  order: [],
  index: 0,
  playing: false,
  shuffle: false,
  repeat: 'off',
  source: 'Queue',
  current: null,
  sleepTimer: null,
  started: false,
  seeking: false,
  mode: 'iframe',
  audioSource: null,
  token: 0,
  error: null,

  init() {
    yt.onYtEvent((event) => {
      if (this.mode !== 'iframe') return;
      if (event.type === 'state') {
        if (event.state === yt.STATE.PLAYING) {
          this.playing = true;
          this.syncPlayIcons();
        } else if (event.state === yt.STATE.PAUSED) {
          this.playing = false;
          this.syncPlayIcons();
        } else if (event.state === yt.STATE.ENDED) {
          this.onEnded();
        }
      } else if (event.type === 'error') {
        this.onPlayerError(event.code);
      }
    });

    audioEl.addEventListener('timeupdate', () => { if (this.isAudioMode()) this.onTime(); });
    audioEl.addEventListener('loadedmetadata', () => {
      const total = $('#np-duration');
      if (total && this.isAudioMode()) total.textContent = fmtLong(audioEl.duration);
    });
    audioEl.addEventListener('play', () => { if (this.isAudioMode()) { this.playing = true; this.syncPlayIcons(); } });
    audioEl.addEventListener('pause', () => { if (this.isAudioMode()) { this.playing = false; this.syncPlayIcons(); } });
    audioEl.addEventListener('ended', () => { if (this.isAudioMode()) this.onEnded(); });
    audioEl.addEventListener('error', () => {
      if (!this.isAudioMode() || !this.current) return;
      // A stream URL expired: resolve it once more before giving up.
      if (this.audioSource === 'stream' && !this.streamRetried) {
        this.streamRetried = true;
        const track = this.current;
        const token = this.token;
        setTimeout(() => {
          if (token !== this.token) return;
          this.playStream(track, token);
        }, 350);
        return;
      }
      // A corrupt cached download should not trap the user offline.
      if (this.audioSource === 'download') {
        import('./media.js').then((m) => m.removeDownload(this.current.id));
        emit('toast', { message: 'Download was incomplete — removed', icon: 'alert-circle' });
      }
    });

    // The iframe has no timeupdate event, so poll while it is driving playback.
    setInterval(() => {
      if (this.mode !== 'iframe' || !this.started || this.seeking) return;
      this.onTime();
    }, 500);

    const volume = $('#volume-slider');
    if (volume) {
      volume.value = '100';
      volume.addEventListener('input', (event) => {
        const value = Number(event.target.value);
        audioEl.volume = value / 100;
        yt.setVolume(value);
      });
    }

    this.setupMediaSession();
    yt.init().catch(() => {});
  },

  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;

    ms.setActionHandler('play', () => this.play());
    ms.setActionHandler('pause', () => this.pause());
    ms.setActionHandler('previoustrack', () => this.prev());
    ms.setActionHandler('nexttrack', () => this.next());
    ms.setActionHandler('stop', () => this.pause());
    ms.setActionHandler('seekbackward', (d) => {
      const by = (d && d.seekOffset) || 15;
      const target = Math.max(0, this.time() - by);
      if (this.isAudioMode()) audioEl.currentTime = target;
      else yt.seek(target);
    });
    ms.setActionHandler('seekforward', (d) => {
      const by = (d && d.seekOffset) || 15;
      const target = Math.min(this.duration() || 0, this.time() + by);
      if (this.isAudioMode()) audioEl.currentTime = target;
      else yt.seek(target);
    });
    ms.setActionHandler('seekto', (d) => {
      if (!isFinite(d.seekTime)) return;
      if (this.isAudioMode()) audioEl.currentTime = d.seekTime;
      else yt.seek(d.seekTime);
    });
  },

  isAudioMode() {
    return this.mode === 'audio';
  },

  // -------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------

  setQueue(ids, source) {
    const tracks = (ids || []).map((id) => ensureTrack(id)).filter((t) => t && t.videoId);
    this.queue = tracks;
    if (source) this.source = source;
    this.index = 0;
    this.rebuildOrder();
    emit('queue-changed', this.queue);
  },

  /**
   * Shuffle is an order over queue indices, not a random jump.
   *
   * A random jump could land on the same track twice in a row and made
   * "previous" meaningless. Keeping an explicit order gives a real shuffled
   * playlist that walks forward, wraps, and can be reversed.
   */
  rebuildOrder() {
    const indices = this.queue.map((_, i) => i);
    if (this.shuffle) {
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      // Keep the current track where it is so turning shuffle on does not jump.
      const at = indices.indexOf(this.index);
      if (at > 0) {
        indices.splice(at, 1);
        indices.unshift(this.index);
      }
    }
    this.order = indices;
  },

  orderPosition() {
    const at = this.order.indexOf(this.index);
    return at === -1 ? 0 : at;
  },

  reorderForShuffle() {
    const current = this.current && this.current.id;
    this.rebuildOrder();
    if (current) {
      const at = this.queue.findIndex((t) => t.id === current);
      if (at >= 0) this.index = at;
      this.queue = this.order.map((i) => this.queue[i]);
      this.index = this.queue.findIndex((t) => t.id === current);
      if (this.index < 0) this.index = 0;
      this.order = this.queue.map((_, i) => i);
    }
    emit('queue-changed', this.queue);
  },

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  async playTrack(id, source, queueIds) {
    if (queueIds) this.setQueue(queueIds, source);
    else if (source) this.source = source;

    const track = ensureTrack(id);
    if (!track || !track.videoId) {
      emit('toast', { message: 'That track cannot be played', icon: 'alert-circle' });
      return;
    }

    if (state.offline && !(await isDownloaded(id))) {
      emit('toast', { message: 'Not downloaded — turn off offline mode', icon: 'wifi-off' });
      return;
    }

    const queued = this.queue.findIndex((t) => t.id === id);
    if (queued >= 0) this.index = queued;

    const token = ++this.token;
    this.streamRetried = false;
    this.current = track;
    this.clearError();
    this.renderNowPlaying();
    this.updateMediaSession();
    this.pushRecent(id);
    this.persistSession();
    emit('track-changed', track);
    emit('recent-changed');

    const mini = $('#mini-player');
    if (mini) mini.classList.remove('hidden');

    // Downloaded audio plays from disk (works offline) and always wins.
    const local = await cachedUrl(id);
    if (token !== this.token) return;
    if (local) {
      this.mode = 'audio';
      this.audioSource = 'download';
      yt.pause();
      audioEl.src = local;
      audioEl.volume = this.volume();
      this.started = true;
      try {
        await audioEl.play();
      } catch {
        emit('toast', { message: 'Tap play to start', icon: 'play' });
      }
      return;
    }

    // DownVid is the primary playback source, and it is tried first.
    //
    // Two things about it shape the code below, and both were verified against
    // the live service rather than assumed:
    //
    //  1. Its file URL cannot back a seekable audio element. It is **single-use**
    //     (a second request returns 404) and it **ignores `Range`** (a ranged
    //     request returns the whole body). An element pointed at that URL starts
    //     playing but can never seek — measured: a seek to 150 s stayed at 3 s.
    //     Only the cached copy is a proper seekable source, which is also why
    //     `loadAudio` cannot be handed that URL and only the cache is used here.
    //  2. Caching therefore has to finish before playback can start, and that
    //     fetch measured 5-20 s upstream. The status line reports real progress
    //     so the wait is legible instead of looking hung.
    //
    // The engines run strictly in sequence. Sharing the one `audioEl` between
    // DownVid and an in-flight mirror attempt does not work: the mirror loop
    // reassigns `audioEl.src` while it probes dead instances, which clobbers the
    // cached source DownVid just loaded and leaves the track silently stalled.
    // Sequential also matches the intended contract — try this, and if it fails,
    // fall back to what was already there.
    const fetch = prefetchDownVid(track, {
      onStage: (stage, extra) => {
        if (token !== this.token) return;
        if (stage === 'searching') this.setSubText(track, 'Finding audio…');
        else if (stage === 'preparing' || stage === 'waiting') this.setSubText(track, 'Preparing…');
        else if (stage === 'downloading') {
          const pct = Math.round(extra.progress || 0);
          this.setSubText(track, pct ? `Loading ${pct}%` : 'Loading…');
        }
      },
    });

    // Bound the whole attempt so an upstream that hangs cannot strand playback
    // here forever; on expiry the mirror path below still gets its turn.
    const arrived = await Promise.race([
      fetch,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), DOWNVID_PATIENCE_MS)),
    ]);
    if (token !== this.token) return;

    if (arrived === true) {
      const viaDownVid = await this.playDownVid(track, token);
      if (token !== this.token) return;
      if (viaDownVid) return;
      // Cached but refused to play (corrupt or an unsupported codec): drop it so
      // the next play re-fetches, then fall through to the mirrors.
      import('./media.js').then((m) => m.removeDownload(track.id)).catch(() => {});
    }

    // DownVid could not serve it in time: restore the real track details, then
    // fall back to the mirror.
    this.renderNowPlaying();

    // Prefer a real audio stream over the YouTube iframe.
    //
    // An <audio> element keeps playing when the app is backgrounded or the screen
    // locks, and it is the only engine that survives the OS suspending the page.
    // The iframe is a nested browsing context: browsers throttle or freeze it as
    // soon as the tab is hidden, which is exactly the "music stops when I switch
    // apps" symptom. The iframe stays the last resort for when mirrors are down.
    if (await this.playStream(track, token)) return;
    if (token !== this.token) return;

    // Videos known to refuse embedding skip the iframe entirely; retrying it
    // would just fail again with error 150.
    if (isBlocked(track.videoId)) {
      this.reportUnplayable(track);
      return;
    }

    this.mode = 'iframe';
    this.audioSource = null;
    audioEl.pause();
    audioEl.removeAttribute('src');

    try {
      await yt.play(track.videoId);
      if (token !== this.token) return;
      this.started = true;
    } catch {
      // The iframe failed to start at all — the mirror is still worth a try.
      if (token !== this.token) return;
      if (await this.playStream(track, token)) return;
      if (token !== this.token) return;
      this.reportUnplayable(track);
    }
  },

  /**
   * Play a track through DownVid.
   *
   * Plays only from what is already cached, because that is the only form that
   * can back a seekable audio element (the file URL is single-use and ignores
   * Range). The caller has already waited for `prefetchDownVid` to land.
   */
  async playDownVid(track, token) {
    if (!track || !track.videoId) return false;

    const local = await cachedUrl(track.id);
    if (token !== this.token) return false;
    if (!local) return false;

    this.mode = 'audio';
    this.audioSource = 'download';
    yt.pause();
    audioEl.volume = this.volume();
    this.started = true;

    const ready = await this.loadAudio(local);
    if (token !== this.token) return false;
    if (!ready) return false;

    try {
      await audioEl.play();
    } catch {
      emit('toast', { message: 'Tap play to start', icon: 'play' });
    }
    // Clear the "Loading 100%" status the fetch left behind and put the artist
    // back, now that the track is actually playing.
    this.renderNowPlaying();
    return true;
  },

  /**
   * Show a transient status on the track's subtitle, without disturbing a
   * different track that has since become current.
   */
  setSubText(track, text) {
    if (!track || !this.current || this.current.id !== track.id) return;
    const mini = $('#mini-artist');
    if (mini) mini.textContent = text;
    const np = $('#np-sub');
    if (np) np.textContent = text;
  },

  volume() {
    const slider = $('#volume-slider');
    return Number((slider && slider.value) || 100) / 100;
  },

  /**
   * Play through a public Invidious mirror.
   *
   * The instance proxies the media itself, so the URL is CORS-readable and the
   * audio element gets real duration, seeking and an `ended` event. Resolves
   * true once playback actually started.
   */
  async playStream(track, token) {
    // Don't tear down a working iframe until a stream is actually ready: on a
    // mirror outage this would leave the user with silence where the iframe
    // would still have played.
    const wasIframe = this.mode === 'iframe' && this.playing;
    const keepAt = wasIframe ? (this.time() || 0) : 0;

    this.mode = 'audio';
    this.audioSource = 'stream';
    this.started = true;
    audioEl.volume = this.volume();

    let candidates = [];
    try {
      candidates = await invidious.audioCandidates(track.videoId);
    } catch {
      candidates = [];
    }

    for (const url of candidates) {
      if (token !== this.token) return false;
      const ready = await this.loadAudio(url);
      if (token !== this.token) return false;
      if (!ready) continue;

      yt.pause();
      if (keepAt > 0.5) {
        try { audioEl.currentTime = keepAt; } catch {}
      }
      try {
        await audioEl.play();
      } catch {
        emit('toast', { message: 'Tap play to start', icon: 'play' });
      }
      return true;
    }

    // Nothing streamed: put the iframe back the way it was.
    if (wasIframe) {
      this.mode = 'iframe';
      this.audioSource = null;
      yt.play(track.videoId).catch(() => {});
    }
    return false;
  },

  /**
   * Point the audio element at a URL and wait for it to become playable.
   * Resolves false rather than throwing so the caller can try another source.
   */
  loadAudio(url) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        audioEl.removeEventListener('loadedmetadata', ready);
        audioEl.removeEventListener('playing', ready);
        audioEl.removeEventListener('error', failed);
        resolve(ok);
      };
      const ready = () => finish(true);
      const failed = () => finish(false);
      const timer = setTimeout(() => finish(false), 9000);

      // Listeners first: a dead source can fail as soon as it is assigned.
      audioEl.addEventListener('loadedmetadata', ready);
      audioEl.addEventListener('playing', ready);
      audioEl.addEventListener('error', failed);
      audioEl.src = url;
      audioEl.load();
    });
  },

  /**
   * Neither engine could play this track.
   *
   * The old build skipped to the next song, which hid the problem. Stop here and
   * offer the one thing that actually works: download it and play from disk.
   */
  reportUnplayable(track) {
    this.playing = false;
    this.syncPlayIcons();
    this.error = {
      trackId: track.id,
      message: 'Failed to play this song',
      sub: 'Download it to play from your device.',
    };
    this.renderError();
    emit('toast', { message: 'Failed to play — download it to play this song', icon: 'alert-circle' });
  },

  renderError() {
    const box = $('#np-error');
    if (!box) return;
    if (!this.error) {
      box.classList.add('hidden');
      return;
    }
    const text = $('#np-error-text');
    const sub = $('#np-error-sub');
    if (text) text.textContent = this.error.message;
    if (sub) sub.textContent = this.error.sub;
    box.classList.remove('hidden');
  },

  clearError() {
    this.error = null;
    const box = $('#np-error');
    if (box) box.classList.add('hidden');
  },

  updateMediaSession() {
    if (!('mediaSession' in navigator) || !this.current) return;
    const track = this.current;
    const artist = (ARTISTS[track.artistId] || {}).name || 'Unknown';
    const album = (ALBUMS[track.albumId] || {}).name || '';
    const artwork = track.thumb
      ? [
        { src: track.thumb, sizes: '512x512' },
        { src: track.thumb, sizes: '256x256' },
      ]
      : [{ src: 'assets/icons/icon-512.png', type: 'image/png', sizes: '512x512' }];

    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist,
        album: album || 'FreePot',
        artwork,
      });
      navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    } catch {}
  },

  syncPosition() {
    if (!('mediaSession' in navigator) || typeof navigator.mediaSession.setPositionState !== 'function') return;
    const duration = this.isAudioMode() ? audioEl.duration : yt.getDuration();
    if (!isFinite(duration) || duration <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: 1,
        position: clamp(this.isAudioMode() ? audioEl.currentTime : yt.getTime(), 0, duration),
      });
    } catch {}
  },

  onPlayerError(code) {
    // 2 bad id, 5 html5 error, 100 not found, 101/150 embed blocked.
    const track = this.current;
    if (!track) return;
    const token = this.token;

    // 101/150 mean the owner disabled embedding. Anything else can still be a
    // blocked video in disguise, so the mirror is tried for every error except
    // a definitely-missing video (100) — and even there a download can work.
    if (code !== 100 && yt.getVideoId() === track.videoId) {
      markBlocked(track.videoId);
      this.playStream(track, token).then((ok) => {
        if (token !== this.token) return;
        if (!ok) this.reportUnplayable(track);
      });
      return;
    }

    this.playStream(track, token).then((ok) => {
      if (token !== this.token) return;
      if (!ok) this.reportUnplayable(track);
    });
  },

  play() {
    if (!this.current) return;
    if (this.error) {
      this.playTrack(this.current.id);
      return;
    }
    if (this.isAudioMode()) {
      audioEl.play().catch(() => {});
      this.playing = true;
      this.syncPlayIcons();
    } else {
      // The iframe can be left in a dead state after the OS suspends the tab,
      // where playVideo() silently does nothing. Re-cueing the track recovers it.
      if (yt.getState() === yt.STATE.UNSTARTED || yt.getState() === -1) {
        yt.play(this.current.videoId).catch(() => {});
      } else {
        yt.resume();
      }
    }
    this.persistSession();
  },

  pause() {
    if (this.isAudioMode()) audioEl.pause();
    else yt.pause();
    this.persistSession();
  },

  toggle() {
    if (!this.current) return;
    if (this.playing) this.pause();
    else this.play();
  },

  /**
   * Move in the queue.
   *
   * `auto` is true when a track ended by itself: then repeat decides whether to
   * wrap, and repeat-off stops at the end instead of looping forever.
   */
  next(auto = false) {
    if (!this.queue.length) return;
    if (this.queue.length === 1) {
      if (this.repeat === 'one' || (this.repeat === 'all' && auto)) {
        this.index = 0;
        this.playTrack(this.queue[0].id);
      } else if (!auto) {
        this.replay();
      } else {
        this.playing = false;
        this.syncPlayIcons();
      }
      return;
    }

    const list = this.shuffle ? this.order : this.queue.map((_, i) => i);
    const at = list.indexOf(this.index);
    const last = at >= list.length - 1;

    if (last && auto && this.repeat === 'off') {
      this.playing = false;
      this.syncPlayIcons();
      return;
    }

    const nextIndex = list[(at + 1) % list.length];
    this.index = nextIndex;
    this.playTrack(this.queue[nextIndex].id);
  },

  prev() {
    if (!this.queue.length) return;
    if (this.time() > 3) {
      this.seek(0);
      return;
    }
    const list = this.shuffle ? this.order : this.queue.map((_, i) => i);
    const at = list.indexOf(this.index);
    const prevIndex = list[(at - 1 + list.length) % list.length];
    this.index = prevIndex;
    this.playTrack(this.queue[prevIndex].id);
  },

  onEnded() {
    if (this.repeat === 'one') {
      this.replay();
      return;
    }
    this.next(true);
  },

  /** Restart the current track from the top, on whichever engine is active. */
  replay() {
    if (!this.current) return;
    if (this.isAudioMode()) {
      audioEl.currentTime = 0;
      audioEl.play().catch(() => {});
      this.playing = true;
      this.syncPlayIcons();
      return;
    }
    yt.seek(0);
    yt.resume();
  },

  time() {
    return this.isAudioMode() ? audioEl.currentTime : yt.getTime();
  },

  duration() {
    return this.isAudioMode() ? audioEl.duration : yt.getDuration();
  },

  onTime() {
    const duration = this.duration() || 1;
    const time = this.time();
    const pct = Math.min(100, (time / duration) * 100);

    const track = $('#progress-track');
    const bar = $('#progress-bar');
    if (bar && !(track && track.classList.contains('dragging'))) bar.style.width = `${pct}%`;
    const mini = $('#mini-progress-bar');
    if (mini) mini.style.width = `${pct}%`;
    const current = $('#np-current');
    if (current) current.textContent = fmtLong(time);
    const total = $('#np-duration');
    if (total && duration > 1) total.textContent = fmtLong(duration);

    this.ticks = (this.ticks || 0) + 1;
    if (this.ticks % 4 === 0) this.syncPosition();
    // Write the position about every 5 seconds while playing, so a crash or a
    // hard close loses seconds rather than the whole session.
    if (this.playing && this.ticks % 10 === 0) this.persistSession();
    emit('time', { time, duration, pct });
  },

  seek(fraction) {
    if (!this.current) return;
    const frac = clamp(fraction, 0, 1);
    const duration = this.duration();
    if (!duration) return;

    if (this.isAudioMode()) audioEl.currentTime = frac * duration;
    else yt.seek(frac * duration);

    const bar = $('#progress-bar');
    if (bar) bar.style.width = `${frac * 100}%`;
    const current = $('#np-current');
    if (current) current.textContent = fmtLong(frac * duration);
    this.syncPosition();
  },

  playNext(id) {
    const track = ensureTrack(id);
    if (!track) return;
    if (!this.queue.length) this.setQueue([track.id], this.source);
    else {
      this.queue.splice(this.index + 1, 0, track);
      this.rebuildOrder();
      emit('queue-changed', this.queue);
    }
    emit('toast', { message: `Up next: ${track.title}`, icon: 'list-plus' });
  },

  addToQueue(id) {
    const track = ensureTrack(id);
    if (!track) return;
    if (!this.queue.length) {
      this.setQueue([track.id], this.source);
    } else {
      this.queue.push(track);
      this.rebuildOrder();
      emit('queue-changed', this.queue);
    }
    emit('toast', { message: `Queued: ${track.title}`, icon: 'list-music' });
  },

  syncPlayIcons() {
    const icon = this.playing ? 'pause' : 'play';
    $$('#mini-play-icon, #big-play-icon').forEach((el) => el.setAttribute('data-lucide', icon));
    const np = $('#now-playing');
    if (np) np.classList.toggle('paused', !this.playing);
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = this.playing ? 'playing' : 'paused';
    }
    emit('play-state', this.playing);
  },

  renderNowPlaying() {
    if (!this.current) return;
    const track = this.current;
    const artist = (ARTISTS[track.artistId] || {}).name || 'Unknown';
    const album = (ALBUMS[track.albumId] || {}).name || '';

    const setText = (sel, value) => { const el = $(sel); if (el) el.textContent = value; };
    setText('#np-title', track.title);
    // Album names are synthesised from the channel, so avoid "Artist · Artist".
    setText('#np-sub', album && album !== artist ? `${artist} · ${album}` : artist);
    setText('#np-source', this.source);
    setText('#mini-title', track.title);
    setText('#mini-artist', artist);

    const bg = $('#np-bg');
    if (bg) bg.src = track.thumb || artGet(`v:${track.videoId || track.id}`);

    this.syncLikeIcon();
    emit('track-rendered', track);
  },

  syncLikeIcon() {
    const liked = !!(this.current && state.liked.includes(this.current.id));
    const mini = $('#mini-like');
    const np = $('#np-like');
    if (mini) mini.classList.toggle('liked', liked);
    if (np) np.classList.toggle('liked', liked);
  },

  // -------------------------------------------------------------------------
  // Session persistence (survives app closure / OS suspension)
  // -------------------------------------------------------------------------

  /**
   * Remember what is playing and where.
   *
   * Mobile browsers tear the page down when the app is closed or left in the
   * background long enough; without this, reopening the PWA landed on an empty
   * player with no track, no queue and no position.
   */
  persistSession() {
    try {
      if (!this.current) {
        localStorage.removeItem(SESSION_KEY);
        return;
      }
      store(SESSION_KEY, {
        at: Date.now(),
        id: this.current.id,
        queue: this.queue.map((t) => t.id),
        index: this.index,
        position: Math.floor(this.time() || 0),
        source: this.source,
        playing: this.playing,
        shuffle: this.shuffle,
        repeat: this.repeat,
      });
    } catch {}
  },

  /**
   * Restore the previous session on boot.
   *
   * The position is restored but playback is not forced: browsers block audio
   * until a gesture, and silently starting sound on launch is hostile. If the
   * track was playing, the player comes back paused at the same second so one
   * tap resumes it.
   */
  restoreSession() {
    const saved = load(SESSION_KEY, null);
    if (!saved || !saved.id) return false;

    // A session older than a day is stale enough that resuming it is confusing.
    if (Date.now() - (saved.at || 0) > 24 * 60 * 60 * 1000) {
      try { localStorage.removeItem(SESSION_KEY); } catch {}
      return false;
    }

    const track = ensureTrack(saved.id);
    if (!track || !track.videoId) return false;

    this.shuffle = !!saved.shuffle;
    this.repeat = saved.repeat === 'one' || saved.repeat === 'all' ? saved.repeat : 'off';
    this.source = saved.source || 'Queue';

    const ids = Array.isArray(saved.queue) && saved.queue.length ? saved.queue : [saved.id];
    this.setQueue(ids, this.source);
    const at = ids.indexOf(saved.id);
    this.index = at >= 0 ? at : Math.min(saved.index || 0, ids.length - 1);

    this.current = track;
    this.mode = 'audio';
    this.audioSource = 'stream';
    this.playing = false;
    this.started = false;
    this.renderNowPlaying();

    const mini = $('#mini-player');
    if (mini) mini.classList.remove('hidden');

    // Show the saved position right away; the source is only loaded on demand.
    this.pendingResumeAt = Number(saved.position) || 0;
    this.paintResumePosition(track);
    emit('track-changed', track);
    return true;
  },

  paintResumePosition(track) {
    const at = this.pendingResumeAt || 0;
    const dur = parseDuration(track.dur);
    const pct = dur ? Math.min(100, (at / dur) * 100) : 0;
    const bar = $('#progress-bar');
    if (bar) bar.style.width = `${pct}%`;
    const mini = $('#mini-progress-bar');
    if (mini) mini.style.width = `${pct}%`;
    const cur = $('#np-current');
    if (cur) cur.textContent = fmtLong(at);
    if (dur) {
      const total = $('#np-duration');
      if (total) total.textContent = fmtLong(dur);
    }
  },

  /**
   * Called when the page becomes visible again.
   *
   * The audio element and the YouTube iframe both drop their stream while the
   * tab is suspended, so the first thing to do is check whether the current
   * engine is still alive and re-attach it if not.
   */
  resumeFromBackground() {
    if (!this.current) return;

    // Blob handles are tied to the document that created them. If the worker can
    // serve the file, drop them so the next play uses the durable SW URL.
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      releaseBlobUrls();
    }

    if (this.isAudioMode()) {
      const alive = audioEl.src && audioEl.readyState > 0 && !audioEl.error;
      if (alive) {
        if (this.playing) audioEl.play().catch(() => {});
        return;
      }
      // The source was dropped while suspended: reattach and restore position.
      const at = this.time() || this.pendingResumeAt || 0;
      const wasPlaying = this.playing;
      this.pendingResumeAt = at;
      this.playTrackAt(this.current.id, at, wasPlaying);
      return;
    }

    if (this.playing) yt.resume();
  },

  /**
   * Called when the page is about to be hidden.
   *
   * An iframe is throttled as soon as the tab loses focus, so audio coming from
   * YouTube stops. Migrating to the audio engine keeps the same track playing
   * through the lock screen instead of cutting out.
   */
  prepareForBackground() {
    if (!this.current || !this.playing) return;
    if (this.mode !== 'iframe') return;
    if (!this.current.videoId) return;

    // Hand over at the current position. playStream pauses the iframe only once
    // a stream is ready, so a failed hand-off leaves normal playback intact.
    this.playStream(this.current, this.token).catch(() => {});
  },

  /** Play a track from a specific second, used when restoring after suspension. */
  async playTrackAt(id, seconds, shouldPlay) {
    const token = ++this.token;
    const track = ensureTrack(id);
    if (!track || !track.videoId) return;

    this.current = track;
    this.clearError();
    this.renderNowPlaying();

    const local = await cachedUrl(id);
    if (token !== this.token) return;

    const startAt = () => {
      const apply = () => {
        try { audioEl.currentTime = Math.max(0, seconds || 0); } catch {}
        this.pendingResumeAt = 0;
      };
      if (audioEl.readyState >= 1) apply();
      else audioEl.addEventListener('loadedmetadata', apply, { once: true });
      if (shouldPlay) audioEl.play().catch(() => {});
    };

    if (local) {
      this.mode = 'audio';
      this.audioSource = 'download';
      yt.pause();
      audioEl.src = local;
      audioEl.volume = this.volume();
      this.started = true;
      startAt();
      return;
    }

    // No download: re-resolve a stream and start at the saved position.
    this.mode = 'audio';
    this.audioSource = 'stream';
    yt.pause();
    audioEl.volume = this.volume();
    this.started = true;

    let candidates = [];
    try {
      candidates = await invidious.audioCandidates(track.videoId);
    } catch {
      candidates = [];
    }
    for (const url of candidates) {
      if (token !== this.token) return;
      if (await this.loadAudio(url)) {
        startAt();
        return;
      }
    }
    this.reportUnplayable(track);
  },

  pushRecent(id) { pushRecent(id); },
};

// Embed-blocked ids are remembered so the next attempt skips the iframe.
const blocked = new Set();
try {
  const raw = JSON.parse(localStorage.getItem(STORAGE.blocked) || '[]');
  if (Array.isArray(raw)) raw.forEach((id) => blocked.add(id));
} catch {}

function isBlocked(videoId) {
  return !!videoId && blocked.has(videoId);
}

function markBlocked(videoId) {
  if (!videoId || blocked.has(videoId)) return;
  blocked.add(videoId);
  try { localStorage.setItem(STORAGE.blocked, JSON.stringify(Array.from(blocked).slice(-200))); } catch {}
}

export function initPlayer() {
  player.init();
  player.restoreSession();
}

export { yt };
